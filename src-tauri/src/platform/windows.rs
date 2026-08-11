use std::{
    ffi::{c_void, OsString},
    num::NonZeroU32,
    os::windows::{
        ffi::OsStringExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    path::{Path, PathBuf},
    ptr::{null, null_mut},
    thread,
    time::{Duration, Instant},
};

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use windows_sys::core::PWSTR;
use windows_sys::Win32::{
    Foundation::{GetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE},
    Storage::Packaging::Appx::{
        FindPackagesByPackageFamily, FormatApplicationUserModelId, GetPackagePathByFullName,
        PackageFamilyNameFromId, PACKAGE_FILTER_HEAD, PACKAGE_ID,
    },
    System::{
        JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
            JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
            TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        },
        Threading::{OpenProcess, PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE, PROCESS_TERMINATE},
    },
};

use super::{
    codex_installation::{
        discover_automatic, load_stored_selection, save_stored_selection, validate_user_selection,
        AutomaticDiscovery, CodexDiscoveryError, CodexInstallation, SystemPackageCandidate,
        CODEX_APP_OVERRIDE_ENV, CODEX_PACKAGE_APPLICATION_ID, CODEX_PACKAGE_EXECUTABLE,
        CODEX_PACKAGE_NAME, CODEX_PACKAGE_PUBLISHER,
    },
    process_tree::{ProcessTree, ProcessTreeError, ProcessTreeState, StopResult},
    AppDirectories,
};

const FORCE_EXIT_CODE: u32 = 1;
const WAIT_INTERVAL: Duration = Duration::from_millis(50);

pub struct WindowsProcessTree {
    state: ProcessTreeState,
    job: OwnedHandle,
    root_process: Option<OwnedHandle>,
}

fn raw_handle(handle: &OwnedHandle) -> HANDLE {
    handle.as_raw_handle() as HANDLE
}

fn last_platform_error(operation: &'static str, message: &'static str) -> ProcessTreeError {
    ProcessTreeError::Platform {
        operation,
        code: Some(unsafe { GetLastError() } as i64),
        message: message.into(),
    }
}

fn wide_null(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0)).collect()
}

fn string_from_wide_buffer(buffer: &[u16]) -> String {
    let length = buffer
        .iter()
        .position(|character| *character == 0)
        .unwrap_or(buffer.len());
    OsString::from_wide(&buffer[..length])
        .to_string_lossy()
        .into_owned()
}

fn string_from_wide_pointer(pointer: PWSTR, buffer: &[u16]) -> Result<String, String> {
    if pointer.is_null() {
        return Err("Windows package query returned a null package name".into());
    }
    let buffer_start = buffer.as_ptr() as usize;
    let buffer_end = buffer_start.saturating_add(std::mem::size_of_val(buffer));
    let pointer = pointer as usize;
    if pointer < buffer_start || pointer >= buffer_end || (pointer - buffer_start) % 2 != 0 {
        return Err("Windows package query returned a package name outside its buffer".into());
    }
    let offset = (pointer - buffer_start) / 2;
    let package_name = &buffer[offset..];
    if !package_name.contains(&0) {
        return Err("Windows package query returned an unterminated package name".into());
    }
    Ok(string_from_wide_buffer(package_name))
}

fn package_family_name() -> Result<String, String> {
    let mut name = wide_null(CODEX_PACKAGE_NAME);
    let mut publisher = wide_null(CODEX_PACKAGE_PUBLISHER);
    let package_id = PACKAGE_ID {
        name: name.as_mut_ptr(),
        publisher: publisher.as_mut_ptr(),
        ..Default::default()
    };
    let mut length = 0;
    let first = unsafe { PackageFamilyNameFromId(&package_id, &mut length, null_mut()) };
    if first != ERROR_INSUFFICIENT_BUFFER {
        return Err(format!(
            "PackageFamilyNameFromId size query failed with Windows error {first}"
        ));
    }
    let mut buffer = vec![0_u16; length as usize];
    let second = unsafe { PackageFamilyNameFromId(&package_id, &mut length, buffer.as_mut_ptr()) };
    if second != ERROR_SUCCESS {
        return Err(format!(
            "PackageFamilyNameFromId failed with Windows error {second}"
        ));
    }
    Ok(string_from_wide_buffer(&buffer))
}

fn application_user_model_id(package_family_name: &str) -> Result<String, String> {
    let family = wide_null(package_family_name);
    let application = wide_null(CODEX_PACKAGE_APPLICATION_ID);
    let mut length = 0;
    let first = unsafe {
        FormatApplicationUserModelId(
            family.as_ptr(),
            application.as_ptr(),
            &mut length,
            null_mut(),
        )
    };
    if first != ERROR_INSUFFICIENT_BUFFER {
        return Err(format!(
            "FormatApplicationUserModelId size query failed with Windows error {first}"
        ));
    }
    let mut buffer = vec![0_u16; length as usize];
    let second = unsafe {
        FormatApplicationUserModelId(
            family.as_ptr(),
            application.as_ptr(),
            &mut length,
            buffer.as_mut_ptr(),
        )
    };
    if second != ERROR_SUCCESS {
        return Err(format!(
            "FormatApplicationUserModelId failed with Windows error {second}"
        ));
    }
    Ok(string_from_wide_buffer(&buffer))
}

fn installed_package_full_names(package_family_name: &str) -> Result<Vec<String>, String> {
    let family = wide_null(package_family_name);
    for _ in 0..3 {
        let mut count = 0;
        let mut buffer_length = 0;
        let first = unsafe {
            FindPackagesByPackageFamily(
                family.as_ptr(),
                PACKAGE_FILTER_HEAD,
                &mut count,
                null_mut(),
                &mut buffer_length,
                null_mut(),
                null_mut(),
            )
        };
        if first == ERROR_SUCCESS && count == 0 {
            return Ok(Vec::new());
        }
        if first != ERROR_INSUFFICIENT_BUFFER {
            return Err(format!(
                "FindPackagesByPackageFamily size query failed with Windows error {first}"
            ));
        }

        let mut names = vec![null_mut(); count as usize];
        let mut buffer = vec![0_u16; buffer_length as usize];
        let second = unsafe {
            FindPackagesByPackageFamily(
                family.as_ptr(),
                PACKAGE_FILTER_HEAD,
                &mut count,
                names.as_mut_ptr(),
                &mut buffer_length,
                buffer.as_mut_ptr(),
                null_mut(),
            )
        };
        if second == ERROR_INSUFFICIENT_BUFFER {
            continue;
        }
        if second != ERROR_SUCCESS {
            return Err(format!(
                "FindPackagesByPackageFamily failed with Windows error {second}"
            ));
        }
        names.truncate(count as usize);
        return names
            .into_iter()
            .map(|name| string_from_wide_pointer(name, &buffer))
            .collect();
    }
    Err("Windows package list changed repeatedly during discovery; please retry".into())
}

fn package_install_path(package_full_name: &str) -> Result<PathBuf, String> {
    let full_name = wide_null(package_full_name);
    let mut length = 0;
    let first = unsafe { GetPackagePathByFullName(full_name.as_ptr(), &mut length, null_mut()) };
    if first != ERROR_INSUFFICIENT_BUFFER {
        return Err(format!(
            "GetPackagePathByFullName size query failed with Windows error {first}"
        ));
    }
    let mut buffer = vec![0_u16; length as usize];
    let second =
        unsafe { GetPackagePathByFullName(full_name.as_ptr(), &mut length, buffer.as_mut_ptr()) };
    if second != ERROR_SUCCESS {
        return Err(format!(
            "GetPackagePathByFullName failed with Windows error {second}"
        ));
    }
    Ok(PathBuf::from(OsString::from_wide(
        &buffer[..buffer
            .iter()
            .position(|value| *value == 0)
            .unwrap_or(buffer.len())],
    )))
}

fn system_codex_candidates() -> Result<(Vec<SystemPackageCandidate>, Vec<String>), String> {
    let family = package_family_name()?;
    let application_user_model_id = application_user_model_id(&family)?;
    let package_names = installed_package_full_names(&family)?;
    let mut candidates = Vec::new();
    let mut diagnostics = Vec::new();
    for package_full_name in package_names {
        match package_install_path(&package_full_name) {
            Ok(install_path) => candidates.push(SystemPackageCandidate {
                package_full_name,
                executable_path: install_path.join(CODEX_PACKAGE_EXECUTABLE),
                application_user_model_id: application_user_model_id.clone(),
            }),
            Err(error) => diagnostics.push(format!(
                "无法解析已安装包 {package_full_name} 的位置：{error}"
            )),
        }
    }
    Ok((candidates, diagnostics))
}

pub fn discover_codex_installation(
    app: &tauri::AppHandle,
    data_directory: &Path,
) -> Result<CodexInstallation, String> {
    let mut diagnostics = Vec::new();
    let stored_selection = match load_stored_selection(data_directory) {
        Ok(selection) => selection,
        Err(error) => {
            diagnostics.push(error);
            None
        }
    };
    let system_candidates = match system_codex_candidates() {
        Ok((candidates, system_diagnostics)) => {
            diagnostics.extend(system_diagnostics);
            candidates
        }
        Err(error) => {
            diagnostics.push(format!("Windows 包元数据查询失败：{error}"));
            Vec::new()
        }
    };
    let explicit_override = std::env::var_os(CODEX_APP_OVERRIDE_ENV).map(PathBuf::from);
    match discover_automatic(
        explicit_override,
        stored_selection,
        system_candidates,
        diagnostics,
    )
    .map_err(|error| error.to_string())?
    {
        AutomaticDiscovery::Found(installation) => Ok(installation),
        AutomaticDiscovery::SelectionRequired { diagnostics } => {
            let Some(file_path) = app
                .dialog()
                .file()
                .add_filter("Windows 应用程序", &["exe"])
                .set_title("选择 ChatGPT.exe")
                .blocking_pick_file()
            else {
                return Err(CodexDiscoveryError::SelectionCancelled { diagnostics }.to_string());
            };
            let selected_path = PathBuf::try_from(file_path).map_err(|error| {
                CodexDiscoveryError::InvalidUserSelection {
                    path: PathBuf::from("<selected file>"),
                    reason: error.to_string(),
                }
                .to_string()
            })?;
            let installation =
                validate_user_selection(selected_path).map_err(|error| error.to_string())?;
            save_stored_selection(data_directory, &installation)
                .map_err(|error| error.to_string())?;
            Ok(installation)
        }
    }
}

impl WindowsProcessTree {
    fn active_processes(&self) -> Result<u32, ProcessTreeError> {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        let succeeded = unsafe {
            QueryInformationJobObject(
                raw_handle(&self.job),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast::<c_void>(),
                std::mem::size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                null_mut(),
            )
        };
        if succeeded == 0 {
            return Err(last_platform_error(
                "query_job",
                "could not query the managed process tree",
            ));
        }
        Ok(accounting.ActiveProcesses)
    }

    fn wait_until_empty(&self, timeout: Duration) -> Result<bool, ProcessTreeError> {
        let deadline = Instant::now()
            .checked_add(timeout)
            .unwrap_or_else(Instant::now);
        loop {
            if self.active_processes()? == 0 {
                return Ok(true);
            }
            let now = Instant::now();
            if now >= deadline {
                return Ok(false);
            }
            thread::sleep(WAIT_INTERVAL.min(deadline.saturating_duration_since(now)));
        }
    }
}

impl ProcessTree for WindowsProcessTree {
    fn create() -> Result<Self, ProcessTreeError> {
        let job = unsafe { CreateJobObjectW(null(), null()) };
        if job.is_null() {
            return Err(last_platform_error(
                "create_job",
                "could not create the process tree owner",
            ));
        }
        let job = unsafe { OwnedHandle::from_raw_handle(job) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let succeeded = unsafe {
            SetInformationJobObject(
                raw_handle(&job),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast::<c_void>(),
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if succeeded == 0 {
            return Err(last_platform_error(
                "configure_job",
                "could not configure process-tree cleanup",
            ));
        }
        Ok(Self {
            state: ProcessTreeState::Created,
            job,
            root_process: None,
        })
    }

    fn state(&self) -> ProcessTreeState {
        self.state
    }

    fn register_root(&mut self, root_pid: NonZeroU32) -> Result<(), ProcessTreeError> {
        if self.state != ProcessTreeState::Created {
            return Err(ProcessTreeError::InvalidTransition {
                operation: "register_root",
                state: self.state,
            });
        }
        let process = unsafe {
            OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                0,
                root_pid.get(),
            )
        };
        if process.is_null() {
            return Err(last_platform_error(
                "open_root",
                "root process is unavailable for registration",
            ));
        }
        let process = unsafe { OwnedHandle::from_raw_handle(process) };
        if unsafe { AssignProcessToJobObject(raw_handle(&self.job), raw_handle(&process)) } == 0 {
            return Err(last_platform_error(
                "assign_root",
                "root process could not be assigned to its process tree",
            ));
        }
        self.root_process = Some(process);
        self.state = ProcessTreeState::Running { root_pid };
        Ok(())
    }

    fn is_running(&mut self) -> Result<bool, ProcessTreeError> {
        let root_pid = match self.state {
            ProcessTreeState::Running { root_pid } | ProcessTreeState::Stopping { root_pid } => {
                root_pid
            }
            ProcessTreeState::Exited { .. } | ProcessTreeState::Created => return Ok(false),
        };
        if self.active_processes()? == 0 {
            self.state = ProcessTreeState::Exited { root_pid };
            Ok(false)
        } else {
            Ok(true)
        }
    }

    fn stop_gracefully(&mut self, timeout: Duration) -> Result<StopResult, ProcessTreeError> {
        let ProcessTreeState::Running { root_pid } = self.state else {
            return match self.state {
                ProcessTreeState::Exited { .. } => Ok(StopResult::AlreadyExited),
                state => Err(ProcessTreeError::InvalidTransition {
                    operation: "stop_gracefully",
                    state,
                }),
            };
        };
        if self.active_processes()? == 0 {
            self.state = ProcessTreeState::Exited { root_pid };
            return Ok(StopResult::AlreadyExited);
        }
        if self.wait_until_empty(timeout)? {
            self.state = ProcessTreeState::Exited { root_pid };
            Ok(StopResult::Exited)
        } else {
            self.state = ProcessTreeState::Stopping { root_pid };
            Ok(StopResult::TimedOut)
        }
    }

    fn force_stop(&mut self, timeout: Duration) -> Result<StopResult, ProcessTreeError> {
        let root_pid = match self.state {
            ProcessTreeState::Running { root_pid } | ProcessTreeState::Stopping { root_pid } => {
                root_pid
            }
            ProcessTreeState::Exited { .. } => return Ok(StopResult::AlreadyExited),
            state => {
                return Err(ProcessTreeError::InvalidTransition {
                    operation: "force_stop",
                    state,
                })
            }
        };
        if self.active_processes()? == 0 {
            self.state = ProcessTreeState::Exited { root_pid };
            return Ok(StopResult::AlreadyExited);
        }
        if unsafe { TerminateJobObject(raw_handle(&self.job), FORCE_EXIT_CODE) } == 0 {
            return Err(last_platform_error(
                "terminate_job",
                "could not terminate the managed process tree",
            ));
        }
        if self.wait_until_empty(timeout)? {
            self.state = ProcessTreeState::Exited { root_pid };
            Ok(StopResult::Exited)
        } else {
            self.state = ProcessTreeState::Stopping { root_pid };
            Ok(StopResult::TimedOut)
        }
    }

    fn release(mut self) -> Result<(), ProcessTreeError> {
        if self.is_running()? {
            return Err(ProcessTreeError::InvalidTransition {
                operation: "release",
                state: self.state,
            });
        }
        Ok(())
    }
}

impl Drop for WindowsProcessTree {
    fn drop(&mut self) {
        if matches!(
            self.state,
            ProcessTreeState::Running { .. } | ProcessTreeState::Stopping { .. }
        ) {
            unsafe {
                TerminateJobObject(raw_handle(&self.job), FORCE_EXIT_CODE);
            }
        }
    }
}

pub fn configure_app(_app: &mut tauri::App) {}

pub fn app_directories(app: &tauri::App) -> tauri::Result<AppDirectories> {
    Ok(AppDirectories {
        data: app.path().app_data_dir()?,
        logs: app.path().app_log_dir()?,
    })
}

#[cfg(test)]
mod tests {
    use super::{application_user_model_id, package_family_name, WindowsProcessTree};
    use crate::platform::process_tree::{ProcessTree, StopResult};
    use std::{
        fs,
        num::NonZeroU32,
        os::windows::io::{AsRawHandle, FromRawHandle},
        process::{Child, Command, Stdio},
        time::Duration,
    };
    use windows_sys::Win32::{
        Foundation::{GetHandleInformation, GetLastError, ERROR_INVALID_HANDLE, WAIT_OBJECT_0},
        System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE},
    };

    const OWNER_HELPER_ENV: &str = "CODEX_TASKBOARD_JOB_OWNER_HELPER";
    const OWNER_MARKER_ENV: &str = "CODEX_TASKBOARD_JOB_OWNER_MARKER";

    #[test]
    fn official_package_identity_produces_the_stable_family_and_app_id() {
        let family = package_family_name().unwrap();

        assert_eq!(family, "OpenAI.Codex_2p2nqsd0c76g0");
        assert_eq!(
            application_user_model_id(&family).unwrap(),
            "OpenAI.Codex_2p2nqsd0c76g0!App"
        );
    }

    fn ping_child(count: &str) -> Child {
        let command = format!("ping -n {count} 127.0.0.1 >NUL");
        Command::new("cmd.exe")
            .args(["/D", "/S", "/C", &command])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    fn tree_for_child(child: &Child) -> WindowsProcessTree {
        let mut tree = WindowsProcessTree::create().unwrap();
        tree.register_root(NonZeroU32::new(child.id()).unwrap())
            .unwrap();
        tree
    }

    fn assert_handle_is_closed(handle: *mut std::ffi::c_void) {
        let mut flags = 0;
        assert_eq!(unsafe { GetHandleInformation(handle, &mut flags) }, 0);
        assert_eq!(unsafe { GetLastError() }, ERROR_INVALID_HANDLE);
    }

    fn wait_for_process_exit(pid: u32, timeout: Duration) -> bool {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            return true;
        }
        let handle = unsafe { std::os::windows::io::OwnedHandle::from_raw_handle(handle) };
        (unsafe { WaitForSingleObject(handle.as_raw_handle(), timeout.as_millis() as u32) })
            == WAIT_OBJECT_0
    }

    #[test]
    fn job_observes_normal_exit_and_closes_owned_handles() {
        let mut child = ping_child("2");
        let mut tree = tree_for_child(&child);
        let job_handle = tree.job.as_raw_handle();
        let process_handle = tree.root_process.as_ref().unwrap().as_raw_handle();

        assert_eq!(
            tree.stop_gracefully(Duration::from_secs(5)).unwrap(),
            StopResult::Exited
        );
        child.wait().unwrap();
        tree.release().unwrap();
        assert_handle_is_closed(process_handle);
        assert_handle_is_closed(job_handle);
    }

    #[test]
    fn job_times_out_then_forces_the_tree_and_allows_repeated_stop() {
        let mut child = ping_child("30");
        let mut tree = tree_for_child(&child);

        assert_eq!(
            tree.stop_gracefully(Duration::from_millis(50)).unwrap(),
            StopResult::TimedOut
        );
        assert_eq!(
            tree.force_stop(Duration::from_secs(3)).unwrap(),
            StopResult::Exited
        );
        child.wait().unwrap();
        assert_eq!(
            tree.force_stop(Duration::from_millis(1)).unwrap(),
            StopResult::AlreadyExited
        );
        tree.release().unwrap();
    }

    #[test]
    fn job_owner_process_helper() {
        let Ok(marker_path) = std::env::var(OWNER_MARKER_ENV) else {
            return;
        };
        if std::env::var_os(OWNER_HELPER_ENV).is_none() {
            return;
        }
        let child = ping_child("30");
        let _tree = tree_for_child(&child);
        fs::write(marker_path, child.id().to_string()).unwrap();
        std::process::exit(0);
    }

    #[test]
    fn closing_the_owner_process_kills_job_members() {
        let marker = std::env::temp_dir().join(format!(
            "codex-taskboard-job-owner-{}.pid",
            uuid::Uuid::new_v4()
        ));
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "platform::windows::tests::job_owner_process_helper",
                "--nocapture",
            ])
            .env(OWNER_HELPER_ENV, "1")
            .env(OWNER_MARKER_ENV, &marker)
            .output()
            .unwrap();
        assert!(output.status.success());
        let pid = fs::read_to_string(&marker).unwrap().parse::<u32>().unwrap();
        let _ = fs::remove_file(&marker);
        assert!(wait_for_process_exit(pid, Duration::from_secs(5)));
    }

    #[test]
    fn missing_root_is_reported_without_adopting_an_unrelated_process() {
        let mut tree = WindowsProcessTree::create().unwrap();
        let unavailable = NonZeroU32::new(u32::MAX).unwrap();
        let error = tree.register_root(unavailable).unwrap_err();
        assert!(matches!(
            error,
            crate::platform::process_tree::ProcessTreeError::Platform {
                operation: "open_root",
                ..
            }
        ));
        tree.release().unwrap();
    }

    fn assert_is_send<T: Send>() {}

    #[test]
    fn windows_process_tree_is_send() {
        assert_is_send::<WindowsProcessTree>();
    }
}
