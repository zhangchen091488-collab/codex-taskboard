#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

pub mod launcher_record;
pub mod platform;
#[cfg(target_os = "macos")]
mod readiness;
mod transport_readiness;

#[cfg(any(target_os = "macos", target_os = "windows"))]
use platform::{
    process_tree::{ProcessTree, StopResult},
    NativeProcessTree,
};
use serde::Serialize;
#[cfg(target_os = "macos")]
use std::num::NonZeroU32;
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
};
#[cfg(target_os = "macos")]
use std::{
    io::{BufRead, BufReader},
    process::{Command as StdCommand, Stdio},
    sync::mpsc,
};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use std::{thread, time::Duration};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::{Update, UpdaterExt};
#[cfg(any(target_os = "macos", target_os = "windows"))]
use uuid::Uuid;

#[cfg(any(target_os = "macos", target_os = "windows"))]
const STOP_TIMEOUT: Duration = Duration::from_secs(5);
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LauncherSnapshot {
    phase: String,
    message: String,
    update_message: String,
    update_available: bool,
    version: String,
    app_path: Option<String>,
    child_pid: Option<u32>,
}

struct LauncherChild {
    pid: u32,
    startup_nonce: String,
    process_tree: NativeProcessTree,
}

struct LauncherState {
    child: Mutex<Option<LauncherChild>>,
    snapshot: Mutex<LauncherSnapshot>,
    intentional_stop: AtomicBool,
    update_flow_in_progress: AtomicBool,
    update_in_progress: AtomicBool,
    generation: AtomicU64,
    lifecycle: Mutex<()>,
    taskboard_url: Mutex<Option<String>>,
    data_directory: PathBuf,
    log_path: PathBuf,
    pid_record_path: PathBuf,
}

impl LauncherState {
    fn new(data_directory: PathBuf, log_directory: PathBuf, version: String) -> Self {
        Self {
            child: Mutex::new(None),
            snapshot: Mutex::new(LauncherSnapshot {
                phase: "starting".into(),
                message: "正在启动任务面板…".into(),
                update_message: "启动后将自动检查更新。".into(),
                update_available: false,
                version,
                app_path: None,
                child_pid: None,
            }),
            intentional_stop: AtomicBool::new(false),
            update_flow_in_progress: AtomicBool::new(false),
            update_in_progress: AtomicBool::new(false),
            generation: AtomicU64::new(0),
            lifecycle: Mutex::new(()),
            taskboard_url: Mutex::new(None),
            pid_record_path: data_directory.join("launcher-child.json"),
            data_directory,
            log_path: log_directory.join("codex-taskboard-launcher.log"),
        }
    }
}

fn copy_directory(source: &Path, destination: &Path) -> Result<(), std::io::Error> {
    fs::create_dir_all(destination)?;
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let destination = destination.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_directory(&entry.path(), &destination)?;
        } else {
            fs::copy(entry.path(), destination)?;
        }
    }
    Ok(())
}

fn update_snapshot(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    update: impl FnOnce(&mut LauncherSnapshot),
) -> LauncherSnapshot {
    let snapshot = {
        let mut snapshot = state.snapshot.lock().unwrap();
        update(&mut snapshot);
        snapshot.clone()
    };
    let _ = app.emit("launcher-status", snapshot.clone());
    snapshot
}

fn append_log(state: &LauncherState, line: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&state.log_path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn show_error_dialog(app: &AppHandle, title: &str, message: &str) {
    app.dialog()
        .message(message)
        .title(title)
        .kind(MessageDialogKind::Error)
        .buttons(MessageDialogButtons::OkCustom("关闭".into()))
        .blocking_show();
}

#[cfg(target_os = "macos")]
fn find_codex_app(home_directory: &Path) -> Option<PathBuf> {
    [
        PathBuf::from("/Applications/ChatGPT.app"),
        home_directory.join("Applications/ChatGPT.app"),
        PathBuf::from("/Applications/Codex.app"),
        home_directory.join("Applications/Codex.app"),
    ]
    .into_iter()
    .find(|candidate| candidate.is_dir())
}

#[cfg(target_os = "macos")]
fn process_tree_for_pid(pid: u32) -> Result<NativeProcessTree, String> {
    let root_pid =
        NonZeroU32::new(pid).ok_or_else(|| "Process root PID must be non-zero".to_string())?;
    let mut process_tree = NativeProcessTree::create().map_err(|error| error.to_string())?;
    process_tree
        .register_root(root_pid)
        .map_err(|error| error.to_string())?;
    Ok(process_tree)
}

fn force_process_tree(state: &LauncherState, process_tree: &mut NativeProcessTree) {
    match process_tree.force_stop(Duration::from_secs(1)) {
        Ok(StopResult::TimedOut) => append_log(state, "Process tree force stop timed out"),
        Err(error) => append_log(state, &format!("Process tree force stop failed: {error}")),
        Ok(_) => {}
    }
}

fn terminate_process_tree(state: &LauncherState, mut process_tree: NativeProcessTree) {
    match process_tree.stop_gracefully(STOP_TIMEOUT) {
        Ok(StopResult::TimedOut) => force_process_tree(state, &mut process_tree),
        Err(error) => {
            append_log(
                state,
                &format!("Process tree graceful stop failed: {error}"),
            );
            force_process_tree(state, &mut process_tree);
        }
        Ok(_) => {}
    }
    if let Err(error) = process_tree.release() {
        append_log(state, &format!("Process tree release failed: {error}"));
    }
}

#[cfg(target_os = "macos")]
fn stop_recorded_child(state: &LauncherState) {
    match launcher_record::read_record(&state.pid_record_path) {
        Ok(Some(record)) => match launcher_record::verify_recorded_launcher(
            &record,
            &state.data_directory.join("launcher-runtime.json"),
        ) {
            Ok(true) => match process_tree_for_pid(record.pid) {
                Ok(process_tree) => terminate_process_tree(state, process_tree),
                Err(error) => append_log(
                    state,
                    &format!("Verified process tree could not be registered: {error}"),
                ),
            },
            Ok(false) => append_log(
                state,
                "Stale launcher record was not trusted because its runtime nonce was not live",
            ),
            Err(error) => append_log(
                state,
                &format!("Launcher record verification failed safely: {error}"),
            ),
        },
        Ok(None) => {}
        Err(error) => append_log(
            state,
            &format!("Legacy or invalid launcher record was ignored safely: {error}"),
        ),
    }
    if let Err(error) = launcher_record::remove_record(&state.pid_record_path) {
        append_log(state, &error);
    }
}

fn clear_pid_record(state: &LauncherState, pid: u32, startup_nonce: &str) {
    if let Err(error) =
        launcher_record::clear_record_if_matches(&state.pid_record_path, pid, startup_nonce)
    {
        append_log(state, &format!("Launcher record cleanup failed: {error}"));
    }
}

#[cfg(target_os = "macos")]
fn write_pid_record(state: &LauncherState, pid: u32, startup_nonce: &str) -> Result<(), String> {
    launcher_record::write_record(&state.pid_record_path, pid, startup_nonce)
}

#[cfg(target_os = "windows")]
fn discard_stale_windows_record(state: &LauncherState) {
    if let Err(error) = launcher_record::remove_record(&state.pid_record_path) {
        append_log(
            state,
            &format!("Stale Windows launcher record cleanup failed: {error}"),
        );
    }
}

fn stop_managed_child_locked(app: &AppHandle, state: &Arc<LauncherState>) {
    state.generation.fetch_add(1, Ordering::SeqCst);
    state.intentional_stop.store(true, Ordering::SeqCst);
    if let Some(child) = state.child.lock().unwrap().take() {
        append_log(state, &format!("Stopping launcher child {}", child.pid));
        terminate_process_tree(state, child.process_tree);
        clear_pid_record(state, child.pid, &child.startup_nonce);
    }
    *state.taskboard_url.lock().unwrap() = None;
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "stopped".into();
        snapshot.message = "任务面板已停止。".into();
        snapshot.child_pid = None;
    });
}

fn stop_managed_child(app: &AppHandle, state: &Arc<LauncherState>) {
    let _lifecycle = state.lifecycle.lock().unwrap();
    stop_managed_child_locked(app, state);
}

#[cfg(target_os = "macos")]
fn watch_launcher_output<R: std::io::Read + Send + 'static>(
    reader: R,
    is_stderr: bool,
    app: AppHandle,
    state: Arc<LauncherState>,
    readiness_sender: Option<mpsc::Sender<Result<readiness::ListeningReadiness, String>>>,
) {
    thread::spawn(move || {
        let mut readiness_observed = false;
        for line in BufReader::new(reader).lines().map_while(Result::ok) {
            if !is_stderr {
                match readiness::parse_launcher_readiness_line(&line) {
                    Ok(Some(readiness::ReadinessEvent::Listening(message))) => {
                        readiness_observed = true;
                        if let Some(sender) = &readiness_sender {
                            let _ = sender.send(Ok(message));
                        }
                        continue;
                    }
                    Ok(Some(readiness::ReadinessEvent::Error)) => {
                        readiness_observed = true;
                        append_log(&state, "Taskboard readiness reported a startup failure");
                        if let Some(sender) = &readiness_sender {
                            let _ =
                                sender.send(Err("Taskboard startup failed: LISTEN_FAILED".into()));
                        }
                        continue;
                    }
                    Ok(None) => {}
                    Err(error) => {
                        readiness_observed = true;
                        append_log(&state, "Rejected invalid Taskboard readiness message");
                        if let Some(sender) = &readiness_sender {
                            let _ = sender.send(Err(error));
                        }
                        continue;
                    }
                }
            }
            append_log(&state, &line);
            if is_stderr && line.contains("Waiting for Codex") {
                update_snapshot(&app, &state, |snapshot| {
                    snapshot.phase = "starting".into();
                    snapshot.message = "正在等待 Codex 窗口…".into();
                });
            } else if !is_stderr && line.contains("\"injected\"") {
                update_snapshot(&app, &state, |snapshot| {
                    snapshot.phase = "running".into();
                    snapshot.message = "任务面板已在 Codex 客户端中打开。".into();
                });
            }
        }
        if !is_stderr && !readiness_observed {
            if let Some(sender) = &readiness_sender {
                let _ = sender.send(Err(
                    "Launcher child exited before Taskboard readiness".into()
                ));
            }
        }
    });
}

#[cfg(target_os = "macos")]
fn apply_taskboard_readiness(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    instance_token: &str,
    listening: &readiness::ListeningReadiness,
) {
    let taskboard_url = readiness::taskboard_url(listening, instance_token);
    *state.taskboard_url.lock().unwrap() = Some(taskboard_url);
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "starting".into();
        snapshot.message = "任务面板服务已启动，正在注入 Codex…".into();
    });
    append_log(
        state,
        &format!(
            "Taskboard readiness accepted on {}:{}",
            listening.host, listening.port
        ),
    );
}

#[cfg(target_os = "macos")]
fn start_launcher_locked(
    app: &AppHandle,
    state: &Arc<LauncherState>,
) -> Result<LauncherSnapshot, String> {
    if state.child.lock().unwrap().is_some() {
        return Ok(state.snapshot.lock().unwrap().clone());
    }

    let home_directory = app.path().home_dir().map_err(|error| error.to_string())?;
    let codex_app = find_codex_app(&home_directory).ok_or_else(|| {
        "未找到官方 ChatGPT.app 或 Codex.app。请先安装到 Applications 文件夹。".to_string()
    })?;
    let resource_directory = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let app_root = resource_directory.join("app");
    let injector_path = app_root.join("scripts/codex-injector.mjs");
    let node_path = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or_else(|| "无法定位 App 可执行文件目录".to_string())?
        .join("node");
    stop_recorded_child(state);
    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.intentional_stop.store(false, Ordering::SeqCst);
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "starting".into();
        snapshot.message = "正在启动任务面板服务…".into();
        snapshot.app_path = Some(codex_app.display().to_string());
    });

    let inherited_path = std::env::var_os("PATH");
    let path_value = platform::launcher_path(&resource_directory, inherited_path.as_deref())
        .map_err(|error| format!("无法构造任务面板 PATH：{error}"))?;
    let instance_token = Uuid::new_v4().to_string();
    let instance_secret = Uuid::new_v4().to_string();
    let version = state.snapshot.lock().unwrap().version.clone();
    let roaming_data_directory = app.path().data_dir().map_err(|error| error.to_string())?;
    let codex_profiles =
        platform::codex_profile_directories(&state.data_directory, &roaming_data_directory);
    let mut command = StdCommand::new(&node_path);
    command
        .arg(&injector_path)
        .args(["--launch", "--watch", "--open", "--cdp-pipe"])
        .args(["--startup-token", &instance_token, "--app-path"])
        .arg(&codex_app)
        .env("CODEX_TASKBOARD_DATA_DIR", &state.data_directory)
        .env(
            "CODEX_TASKBOARD_RUNTIME_FILE",
            state.data_directory.join("launcher-runtime.json"),
        )
        .env("CODEX_TASKBOARD_HOST", "127.0.0.1")
        .env("CODEX_TASKBOARD_PORT", "0")
        .env("CODEX_TASKBOARD_INSTANCE_TOKEN", &instance_token)
        .env("CODEX_TASKBOARD_INSTANCE_SECRET", &instance_secret)
        .env("CODEX_TASKBOARD_LAUNCHER_READINESS", "1")
        .env("CODEX_TASKBOARD_VERSION", &version)
        .env(
            "CODEX_TASKBOARD_CODEX_PROFILE",
            codex_profiles.independent.to_string_lossy().as_ref(),
        )
        .env(
            "CODEX_TASKBOARD_CODEX_SOURCE_PROFILE",
            codex_profiles.source.to_string_lossy().as_ref(),
        )
        .env("HOST", "127.0.0.1")
        .env("PATH", path_value)
        .current_dir(&app_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    platform::configure_process_tree_command(&mut command);
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let pid = child.id();
    let mut process_tree = match process_tree_for_pid(pid) {
        Ok(process_tree) => process_tree,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    if let Err(error) = write_pid_record(state, pid, &instance_token) {
        force_process_tree(state, &mut process_tree);
        let _ = child.wait();
        return Err(error);
    }
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let (readiness_sender, readiness_receiver) = mpsc::channel();
    if let Some(stdout) = stdout {
        watch_launcher_output(
            stdout,
            false,
            app.clone(),
            state.clone(),
            Some(readiness_sender),
        );
    }
    if let Some(stderr) = stderr {
        watch_launcher_output(stderr, true, app.clone(), state.clone(), None);
    }
    let listening =
        match readiness::wait_for_taskboard_readiness(&readiness_receiver, Duration::from_secs(10))
        {
            Ok(listening) => listening,
            Err(error) => {
                append_log(state, &format!("Launcher readiness failed: {error}"));
                force_process_tree(state, &mut process_tree);
                let _ = child.wait();
                clear_pid_record(state, pid, &instance_token);
                return Err(error);
            }
        };
    apply_taskboard_readiness(app, state, &instance_token, &listening);
    let readiness_app = app.clone();
    let readiness_state = state.clone();
    let readiness_token = instance_token.clone();
    thread::spawn(move || {
        while let Ok(result) = readiness_receiver.recv() {
            match result {
                Ok(listening) => apply_taskboard_readiness(
                    &readiness_app,
                    &readiness_state,
                    &readiness_token,
                    &listening,
                ),
                Err(error) => append_log(
                    &readiness_state,
                    &format!("Launcher follow-up readiness rejected: {error}"),
                ),
            }
        }
    });
    *state.child.lock().unwrap() = Some(LauncherChild {
        pid,
        startup_nonce: instance_token.clone(),
        process_tree,
    });
    let snapshot = update_snapshot(app, state, |snapshot| {
        snapshot.child_pid = Some(pid);
    });
    append_log(
        state,
        &format!(
            "Started launcher child {pid} on Taskboard {}:{} with private CDP pipe",
            listening.host, listening.port
        ),
    );

    let event_app = app.clone();
    let event_state = state.clone();
    let event_startup_nonce = instance_token.clone();
    thread::spawn(move || {
        let status = child.wait();
        append_log(
            &event_state,
            &format!("Launcher child {pid} exited: {status:?}"),
        );
        if event_state.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let mut current_child = event_state.child.lock().unwrap();
        if current_child.as_ref().map(|child| child.pid) != Some(pid) {
            return;
        }
        let managed_child = current_child.take().unwrap();
        drop(current_child);
        terminate_process_tree(&event_state, managed_child.process_tree);
        clear_pid_record(&event_state, pid, &event_startup_nonce);
        let intentional = event_state.intentional_stop.load(Ordering::SeqCst);
        update_snapshot(&event_app, &event_state, |snapshot| {
            snapshot.child_pid = None;
            if !intentional {
                snapshot.phase = "error".into();
                snapshot.message = "任务面板进程已退出，正在恢复…".into();
            }
        });
        if intentional {
            return;
        }
        thread::sleep(Duration::from_secs(2));
        let recovery_result = {
            let _lifecycle = event_state.lifecycle.lock().unwrap();
            if event_state.generation.load(Ordering::SeqCst) != generation
                || event_state.intentional_stop.load(Ordering::SeqCst)
                || event_state.update_in_progress.load(Ordering::SeqCst)
            {
                return;
            }
            start_launcher_locked(&event_app, &event_state)
        };
        if let Err(error) = recovery_result {
            append_log(&event_state, &format!("Launcher recovery failed: {error}"));
            update_snapshot(&event_app, &event_state, |snapshot| {
                snapshot.phase = "error".into();
                snapshot.message = error.clone();
            });
            show_error_dialog(
                &event_app,
                "Codex Taskboard 恢复失败",
                &format!("任务面板进程无法恢复：{error}\n\n请重新打开 App。"),
            );
        }
    });
    Ok(snapshot)
}

#[cfg(target_os = "windows")]
fn start_launcher_locked(
    app: &AppHandle,
    state: &Arc<LauncherState>,
) -> Result<LauncherSnapshot, String> {
    if state.child.lock().unwrap().is_some() {
        return Ok(state.snapshot.lock().unwrap().clone());
    }
    discard_stale_windows_record(state);
    let codex_installation = platform::discover_codex_installation(app, &state.data_directory)?;
    append_log(
        state,
        &format!(
            "Windows Codex installation discovered from {:?}: {}",
            codex_installation.source,
            codex_installation.executable_path.display()
        ),
    );
    update_snapshot(app, state, |snapshot| {
        snapshot.app_path = Some(codex_installation.executable_path.display().to_string());
    });
    let resource_directory = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let roaming_data_directory = app.path().data_dir().map_err(|error| error.to_string())?;
    let codex_profiles =
        platform::codex_profile_directories(&state.data_directory, &roaming_data_directory);
    let app_root = resource_directory.join("app");
    let injector_path = app_root.join("scripts/codex-injector.mjs");
    let node_path = std::env::current_exe()
        .map_err(|error| error.to_string())?
        .parent()
        .ok_or_else(|| "无法定位 App 可执行文件目录".to_string())?
        .join("node.exe");
    let launch_description = platform::codex_launch_description(
        node_path,
        injector_path,
        app_root,
        codex_installation.executable_path.clone(),
        &codex_profiles,
    );

    let generation = state.generation.fetch_add(1, Ordering::SeqCst) + 1;
    state.intentional_stop.store(false, Ordering::SeqCst);
    let startup_nonce = Uuid::new_v4().to_string();
    update_snapshot(app, state, |snapshot| {
        snapshot.phase = "starting".into();
        snapshot.message = "正在启动独立 Codex Windows 实例…".into();
    });

    let mut process_tree = NativeProcessTree::create().map_err(|error| error.to_string())?;
    let launched = process_tree
        .spawn_suspended(&launch_description)
        .map_err(|error| error.to_string())?;
    let pid = launched.pid();
    *state.child.lock().unwrap() = Some(LauncherChild {
        pid,
        startup_nonce: startup_nonce.clone(),
        process_tree,
    });
    let snapshot = update_snapshot(app, state, |snapshot| {
        snapshot.phase = "starting".into();
        snapshot.message = "独立 Codex 已启动，等待调试通道接入…".into();
        snapshot.child_pid = Some(pid);
    });
    append_log(
        state,
        &format!("Started suspended Windows launcher child {pid} inside its Job Object"),
    );

    let event_app = app.clone();
    let event_state = state.clone();
    thread::spawn(move || {
        let exit = launched.wait();
        append_log(
            &event_state,
            &format!("Windows launcher child {pid} exited: {exit:?}"),
        );
        if event_state.generation.load(Ordering::SeqCst) != generation {
            return;
        }
        let mut current_child = event_state.child.lock().unwrap();
        if current_child.as_ref().map(|child| child.pid) != Some(pid) {
            return;
        }
        let managed_child = current_child.take().unwrap();
        drop(current_child);
        terminate_process_tree(&event_state, managed_child.process_tree);
        clear_pid_record(&event_state, pid, &startup_nonce);
        let launch_failed = !matches!(&exit, Ok(0));
        update_snapshot(&event_app, &event_state, |snapshot| {
            snapshot.child_pid = None;
            match &exit {
                Ok(0) => {
                    snapshot.phase = "stopped".into();
                    snapshot.message = "Codex Windows 实例已退出。".into();
                }
                Ok(_) | Err(_) => {
                    snapshot.phase = "error".into();
                    snapshot.message =
                        "Codex Windows 实例启动失败；请检查安装后从托盘重试。".into();
                }
            }
        });
        if launch_failed {
            show_error_dialog(
                &event_app,
                "Codex Taskboard 启动失败",
                "无法启动独立的 Codex Windows 实例。请确认 ChatGPT 已安装，然后从托盘重新启动 Codex。",
            );
        }
    });
    Ok(snapshot)
}

fn start_launcher(app: &AppHandle, state: &Arc<LauncherState>) -> Result<LauncherSnapshot, String> {
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.intentional_stop.load(Ordering::SeqCst)
        || state.update_in_progress.load(Ordering::SeqCst)
    {
        return Ok(state.snapshot.lock().unwrap().clone());
    }
    start_launcher_locked(app, state)
}

fn restart_launcher(
    app: &AppHandle,
    state: &Arc<LauncherState>,
) -> Result<LauncherSnapshot, String> {
    let _lifecycle = state.lifecycle.lock().unwrap();
    if state.intentional_stop.load(Ordering::SeqCst) {
        return Ok(state.snapshot.lock().unwrap().clone());
    }
    if state.update_in_progress.load(Ordering::SeqCst) {
        append_log(state, "Launcher reopen ignored during update installation");
        return Ok(state.snapshot.lock().unwrap().clone());
    }
    stop_managed_child_locked(app, state);
    let result = start_launcher_locked(app, state);
    if result.is_err() {
        state.intentional_stop.store(false, Ordering::SeqCst);
    }
    result
}

async fn check_for_startup_update(
    app: &AppHandle,
    state: &Arc<LauncherState>,
) -> Result<Option<Update>, String> {
    update_snapshot(app, state, |snapshot| {
        snapshot.update_message = "正在检查更新…".into();
        snapshot.update_available = false;
    });
    let update = app
        .updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())?;
    match &update {
        Some(update) => {
            append_log(state, &format!("Update {} is available", update.version));
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message =
                    format!("发现新版本 {}，可以下载并安装。", update.version);
                snapshot.update_available = true;
            });
        }
        None => {
            append_log(state, "No update is available");
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message = "当前已是最新版本。".into();
                snapshot.update_available = false;
            });
        }
    }
    Ok(update)
}

async fn install_update(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    update: Update,
) -> Result<(), String> {
    let update_version = update.version.clone();
    update_snapshot(app, state, |snapshot| {
        snapshot.update_message = format!("正在下载版本 {update_version}…");
        snapshot.update_available = false;
    });
    let progress_app = app.clone();
    let progress_state = Arc::clone(state);
    let progress_version = update_version.clone();
    let finish_app = app.clone();
    let finish_state = Arc::clone(state);
    let mut downloaded = 0_u64;
    let bytes = match update
        .download(
            move |chunk_length, content_length| {
                downloaded = downloaded.saturating_add(chunk_length as u64);
                update_snapshot(&progress_app, &progress_state, |snapshot| {
                    snapshot.update_message = match content_length.filter(|total| *total > 0) {
                        Some(total) => format!(
                            "正在下载版本 {progress_version}：{}%",
                            downloaded
                                .saturating_mul(100)
                                .saturating_div(total)
                                .min(100)
                        ),
                        None => format!("正在下载版本 {progress_version}…"),
                    };
                });
            },
            move || {
                update_snapshot(&finish_app, &finish_state, |snapshot| {
                    snapshot.update_message = "下载完成，正在验证更新签名…".into();
                });
            },
        )
        .await
    {
        Ok(bytes) => bytes,
        Err(error) => {
            append_log(state, &format!("Update download failed: {error}"));
            update_snapshot(app, state, |snapshot| {
                snapshot.update_message = format!("更新下载或签名验证失败：{error}");
                snapshot.update_available = true;
            });
            return Err(error.to_string());
        }
    };

    update_snapshot(app, state, |snapshot| {
        snapshot.update_message = "更新签名验证通过，正在安装…".into();
    });
    {
        let _lifecycle = state.lifecycle.lock().unwrap();
        if state.intentional_stop.load(Ordering::SeqCst) {
            return Err("App exit is in progress".into());
        }
        state.update_in_progress.store(true, Ordering::SeqCst);
        stop_managed_child_locked(app, state);
    }
    if let Err(error) = update.install(&bytes) {
        append_log(state, &format!("Update installation failed: {error}"));
        let restart_error = {
            let _lifecycle = state.lifecycle.lock().unwrap();
            let restart_error = start_launcher_locked(app, state).err();
            state.intentional_stop.store(false, Ordering::SeqCst);
            state.update_in_progress.store(false, Ordering::SeqCst);
            restart_error
        };
        if let Some(restart_error) = &restart_error {
            append_log(
                state,
                &format!("Taskboard restart after update failure failed: {restart_error}"),
            );
        } else {
            append_log(
                state,
                "Taskboard restarted after update installation failure",
            );
        }
        update_snapshot(app, state, |snapshot| {
            snapshot.update_message = format!("更新安装失败：{error}");
            snapshot.update_available = true;
            if let Some(restart_error) = &restart_error {
                snapshot.phase = "error".into();
                snapshot.message = format!("任务面板恢复失败：{restart_error}");
            }
        });
        return Err(error.to_string());
    }

    append_log(
        state,
        &format!("Installed update {update_version}; restarting"),
    );
    update_snapshot(app, state, |snapshot| {
        snapshot.update_message = format!("版本 {update_version} 已安装，正在重启…");
    });
    app.restart()
}

fn finish_update_flow(state: &LauncherState, check_update: &MenuItem<tauri::Wry>) {
    state.update_flow_in_progress.store(false, Ordering::SeqCst);
    check_update.set_enabled(true).unwrap();
}

async fn offer_update(
    app: &AppHandle,
    state: &Arc<LauncherState>,
    check_update: &MenuItem<tauri::Wry>,
    show_current_version: bool,
) {
    if state
        .update_flow_in_progress
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    let update = match check_for_startup_update(app, state).await {
        Ok(update) => update,
        Err(error) => {
            append_log(state, &format!("Update check failed: {error}"));
            if show_current_version {
                show_error_dialog(
                    app,
                    "Codex Taskboard 更新检查失败",
                    &format!("无法检查更新。请稍后重试。\n\n{error}"),
                );
            }
            finish_update_flow(state, check_update);
            return;
        }
    };
    let Some(update) = update else {
        if show_current_version {
            app.dialog()
                .message("当前已是最新版本。")
                .title("Codex Taskboard 更新")
                .buttons(MessageDialogButtons::Ok)
                .blocking_show();
        }
        finish_update_flow(state, check_update);
        return;
    };

    let version = update.version.clone();
    append_log(state, &format!("Showing update prompt for {version}"));
    let install_now = app
        .dialog()
        .message(format!(
            "发现 Codex Taskboard {version}。是否现在下载、安装并重启？"
        ))
        .title("Codex Taskboard 更新")
        .buttons(MessageDialogButtons::OkCancelCustom(
            "立即更新".into(),
            "稍后".into(),
        ))
        .blocking_show();
    if !install_now {
        append_log(state, &format!("Update {version} deferred by user"));
        finish_update_flow(state, check_update);
        return;
    }
    append_log(state, &format!("Update {version} accepted by user"));
    if let Err(error) = install_update(app, state, update).await {
        append_log(state, &format!("Update installation failed: {error}"));
        let service_recovered = state.snapshot.lock().unwrap().child_pid.is_some();
        let service_message = if service_recovered {
            "任务面板服务已恢复。"
        } else {
            "任务面板服务未能恢复，请重新打开 App。"
        };
        show_error_dialog(
            app,
            "Codex Taskboard 更新失败",
            &format!("更新未完成。{service_message}\n\n请稍后重试。详情见启动日志。\n\n{error}"),
        );
        finish_update_flow(state, check_update);
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|_, _, _| {}))
        .enable_macos_default_menu(false)
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            platform::configure_app(app);
            let home_directory = app.path().home_dir()?;
            let bundled_skill = app
                .path()
                .resource_dir()?
                .join("app/skills/manage-taskboard");
            let global_skill = home_directory.join(".agents/skills/manage-taskboard");
            if global_skill.exists() {
                fs::remove_dir_all(&global_skill)?;
            }
            copy_directory(&bundled_skill, &global_skill)?;
            let app_directories = platform::app_directories(app)?;
            let data_directory = app_directories.data;
            let log_directory = app_directories.logs;
            fs::create_dir_all(&data_directory)?;
            fs::create_dir_all(&log_directory)?;
            let version = app.package_info().version.to_string();
            let state = Arc::new(LauncherState::new(data_directory, log_directory, version));
            app.manage(state.clone());

            let check_update =
                MenuItem::with_id(app, "check-update", "检查更新", false, None::<&str>)?;
            let restart_codex =
                MenuItem::with_id(app, "restart-codex", "重新启动 Codex", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&check_update, &restart_codex, &quit])?;
            let check_update_menu = check_update.clone();
            TrayIconBuilder::new()
                .icon(tauri::include_image!("icons/tray-codex.png"))
                .icon_as_template(true)
                .tooltip("Codex Taskboard")
                .menu(&tray_menu)
                .on_menu_event(move |app, event| match event.id().as_ref() {
                    "check-update" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        check_update_menu.set_enabled(false).unwrap();
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        let check_update = check_update_menu.clone();
                        tauri::async_runtime::spawn(async move {
                            offer_update(&app, &state, &check_update, true).await;
                        });
                    }
                    "restart-codex" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let state = Arc::clone(state.inner());
                        let app = app.clone();
                        tauri::async_runtime::spawn_blocking(move || {
                            if let Err(error) = restart_launcher(&app, &state) {
                                append_log(
                                    &state,
                                    &format!("Launcher menu restart failed: {error}"),
                                );
                                show_error_dialog(
                                    &app,
                                    "Codex Taskboard 启动失败",
                                    &format!("{error}\n\n请确认官方 Codex/ChatGPT App 已安装。"),
                                );
                            }
                        });
                    }
                    "quit" => {
                        let Some(state) = app.try_state::<Arc<LauncherState>>() else {
                            return;
                        };
                        let lifecycle = state.lifecycle.lock().unwrap();
                        if state.update_in_progress.load(Ordering::SeqCst) {
                            return;
                        }
                        stop_managed_child_locked(app, &state);
                        drop(lifecycle);
                        app.exit(0);
                    }
                    _ => {}
                })
                .build(app)?;

            let app_handle = app.handle().clone();
            let startup_check_update = check_update.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = start_launcher(&app_handle, &state) {
                    append_log(&state, &format!("Launcher startup failed: {error}"));
                    update_snapshot(&app_handle, &state, |snapshot| {
                        snapshot.phase = "error".into();
                        snapshot.message = error.clone();
                    });
                    show_error_dialog(
                        &app_handle,
                        "Codex Taskboard 启动失败",
                        &format!(
                            "{error}\n\n请确认官方 Codex/ChatGPT App 已安装。详情见启动日志。"
                        ),
                    );
                }
                offer_update(&app_handle, &state, &startup_check_update, false).await;
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Codex Taskboard");

    app.run(|app_handle, event| match event {
        #[cfg(target_os = "macos")]
        tauri::RunEvent::Reopen { .. } => {
            let Some(state) = app_handle.try_state::<Arc<LauncherState>>() else {
                return;
            };
            if let Err(error) = restart_launcher(app_handle, &state) {
                append_log(&state, &format!("Launcher reopen failed: {error}"));
                show_error_dialog(
                    app_handle,
                    "Codex Taskboard 启动失败",
                    &format!("{error}\n\n请确认官方 Codex/ChatGPT App 已安装。"),
                );
            }
        }
        tauri::RunEvent::ExitRequested { code, api, .. } => {
            if let Some(state) = app_handle.try_state::<Arc<LauncherState>>() {
                let _lifecycle = state.lifecycle.lock().unwrap();
                if code != Some(tauri::RESTART_EXIT_CODE)
                    && state.update_in_progress.load(Ordering::SeqCst)
                {
                    api.prevent_exit();
                    return;
                }
                stop_managed_child_locked(app_handle, &state);
            }
        }
        tauri::RunEvent::Exit => {
            if let Some(state) = app_handle.try_state::<Arc<LauncherState>>() {
                stop_managed_child(app_handle, &state);
            }
        }
        _ => {}
    });
}
