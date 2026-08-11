use std::{
    env,
    ffi::{c_void, OsStr, OsString},
    num::NonZeroU32,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
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
    Foundation::{GetLastError, ERROR_INSUFFICIENT_BUFFER, ERROR_SUCCESS, HANDLE, WAIT_OBJECT_0},
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
        Threading::{
            CreateProcessW, GetExitCodeProcess, OpenProcess, ResumeThread, TerminateProcess,
            WaitForSingleObject, CREATE_NO_WINDOW, CREATE_SUSPENDED, CREATE_UNICODE_ENVIRONMENT,
            INFINITE, PROCESS_INFORMATION, PROCESS_SET_QUOTA, PROCESS_SYNCHRONIZE,
            PROCESS_TERMINATE, STARTUPINFOW,
        },
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
    AppDirectories, CodexProfileDirectories,
};

const FORCE_EXIT_CODE: u32 = 1;
const WAIT_INTERVAL: Duration = Duration::from_millis(50);

pub struct WindowsProcessTree {
    state: ProcessTreeState,
    job: OwnedHandle,
    root_process: Option<OwnedHandle>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WindowsLaunchDescription {
    pub executable_path: PathBuf,
    pub arguments: Vec<OsString>,
    pub current_directory: PathBuf,
    pub environment: Vec<(OsString, OsString)>,
}

#[derive(Debug)]
pub struct WindowsProcessWaiter {
    pid: u32,
    process: OwnedHandle,
}

impl WindowsProcessWaiter {
    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn wait(self) -> Result<u32, ProcessTreeError> {
        if unsafe { WaitForSingleObject(raw_handle(&self.process), INFINITE) } != WAIT_OBJECT_0 {
            return Err(last_platform_error(
                "wait_root",
                "could not wait for the launcher process",
            ));
        }
        let mut exit_code = 0;
        if unsafe { GetExitCodeProcess(raw_handle(&self.process), &mut exit_code) } == 0 {
            return Err(last_platform_error(
                "read_root_exit",
                "could not read the launcher process exit code",
            ));
        }
        Ok(exit_code)
    }
}

fn sanitized_launch_environment(
    environment: impl IntoIterator<Item = (OsString, OsString)>,
) -> Vec<(OsString, OsString)> {
    environment
        .into_iter()
        .filter(|(name, _)| {
            !name
                .to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("CODEX_TASKBOARD_")
        })
        .collect()
}

pub fn codex_launch_description(
    node_path: PathBuf,
    injector_path: PathBuf,
    app_root: PathBuf,
    codex_executable_path: PathBuf,
    profiles: &CodexProfileDirectories,
) -> WindowsLaunchDescription {
    WindowsLaunchDescription {
        executable_path: node_path,
        arguments: vec![
            injector_path.into_os_string(),
            "--launch-only".into(),
            "--app-path".into(),
            codex_executable_path.into_os_string(),
            "--profile-path".into(),
            profiles.independent.clone().into_os_string(),
            "--source-profile-path".into(),
            profiles.source.clone().into_os_string(),
        ],
        current_directory: app_root,
        environment: sanitized_launch_environment(env::vars_os()),
    }
}

fn wide_null_os(value: &OsStr) -> Result<Vec<u16>, ProcessTreeError> {
    let mut encoded = value.encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) {
        return Err(ProcessTreeError::Platform {
            operation: "build_launch",
            code: None,
            message: "launch values must not contain NUL characters".into(),
        });
    }
    encoded.push(0);
    Ok(encoded)
}

fn append_quoted_argument(
    command_line: &mut Vec<u16>,
    value: &OsStr,
) -> Result<(), ProcessTreeError> {
    let encoded = value.encode_wide().collect::<Vec<_>>();
    if encoded.contains(&0) {
        return Err(ProcessTreeError::Platform {
            operation: "build_launch",
            code: None,
            message: "launch arguments must not contain NUL characters".into(),
        });
    }
    command_line.push(b'"' as u16);
    let mut backslashes = 0;
    for character in encoded {
        if character == b'\\' as u16 {
            backslashes += 1;
            continue;
        }
        if character == b'"' as u16 {
            command_line.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2 + 1));
        } else {
            command_line.extend(std::iter::repeat_n(b'\\' as u16, backslashes));
        }
        backslashes = 0;
        command_line.push(character);
    }
    command_line.extend(std::iter::repeat_n(b'\\' as u16, backslashes * 2));
    command_line.push(b'"' as u16);
    Ok(())
}

fn command_line(description: &WindowsLaunchDescription) -> Result<Vec<u16>, ProcessTreeError> {
    let mut command_line = Vec::new();
    append_quoted_argument(&mut command_line, description.executable_path.as_os_str())?;
    for argument in &description.arguments {
        command_line.push(b' ' as u16);
        append_quoted_argument(&mut command_line, argument)?;
    }
    command_line.push(0);
    Ok(command_line)
}

fn environment_block(description: &WindowsLaunchDescription) -> Result<Vec<u16>, ProcessTreeError> {
    let mut environment = description.environment.clone();
    environment.sort_by_cached_key(|(name, _)| name.to_string_lossy().to_ascii_uppercase());
    let mut block = Vec::new();
    for (name, value) in environment {
        let name = name.encode_wide().collect::<Vec<_>>();
        let value = value.encode_wide().collect::<Vec<_>>();
        if name.contains(&0) || value.contains(&0) {
            return Err(ProcessTreeError::Platform {
                operation: "build_launch",
                code: None,
                message: "environment values must not contain NUL characters".into(),
            });
        }
        block.extend(name);
        block.push(b'=' as u16);
        block.extend(value);
        block.push(0);
    }
    block.push(0);
    if block.len() == 1 {
        block.push(0);
    }
    Ok(block)
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
    pub fn spawn_suspended(
        &mut self,
        description: &WindowsLaunchDescription,
    ) -> Result<WindowsProcessWaiter, ProcessTreeError> {
        if self.state != ProcessTreeState::Created {
            return Err(ProcessTreeError::InvalidTransition {
                operation: "spawn_suspended",
                state: self.state,
            });
        }

        let application = wide_null_os(description.executable_path.as_os_str())?;
        let mut command_line = command_line(description)?;
        let environment = environment_block(description)?;
        let current_directory = wide_null_os(description.current_directory.as_os_str())?;
        let mut startup = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            ..Default::default()
        };
        let mut process_information = PROCESS_INFORMATION::default();
        let created = unsafe {
            CreateProcessW(
                application.as_ptr(),
                command_line.as_mut_ptr(),
                null(),
                null(),
                0,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
                environment.as_ptr().cast::<c_void>(),
                current_directory.as_ptr(),
                &mut startup,
                &mut process_information,
            )
        };
        if created == 0 {
            return Err(last_platform_error(
                "create_suspended",
                "could not create the launcher process",
            ));
        }
        let process = unsafe { OwnedHandle::from_raw_handle(process_information.hProcess) };
        let primary_thread = unsafe { OwnedHandle::from_raw_handle(process_information.hThread) };
        let Some(root_pid) = NonZeroU32::new(process_information.dwProcessId) else {
            let error = ProcessTreeError::Platform {
                operation: "create_suspended",
                code: None,
                message: "Windows returned a zero process identifier".into(),
            };
            unsafe {
                TerminateProcess(raw_handle(&process), FORCE_EXIT_CODE);
                WaitForSingleObject(raw_handle(&process), INFINITE);
            }
            return Err(error);
        };

        if unsafe { AssignProcessToJobObject(raw_handle(&self.job), raw_handle(&process)) } == 0 {
            let error = last_platform_error(
                "assign_suspended",
                "suspended launcher could not be assigned to its process tree",
            );
            unsafe {
                TerminateProcess(raw_handle(&process), FORCE_EXIT_CODE);
                WaitForSingleObject(raw_handle(&process), INFINITE);
            }
            return Err(error);
        }
        let tree_process = unsafe {
            OpenProcess(
                PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_SYNCHRONIZE,
                0,
                root_pid.get(),
            )
        };
        if tree_process.is_null() {
            let error = last_platform_error(
                "open_suspended_root",
                "assigned launcher process could not be retained",
            );
            unsafe {
                TerminateJobObject(raw_handle(&self.job), FORCE_EXIT_CODE);
                WaitForSingleObject(raw_handle(&process), INFINITE);
            }
            return Err(error);
        }
        self.root_process = Some(unsafe { OwnedHandle::from_raw_handle(tree_process) });
        self.state = ProcessTreeState::Running { root_pid };

        if unsafe { ResumeThread(raw_handle(&primary_thread)) } == u32::MAX {
            let error = last_platform_error(
                "resume_root",
                "assigned launcher process could not be resumed",
            );
            unsafe {
                TerminateJobObject(raw_handle(&self.job), FORCE_EXIT_CODE);
                WaitForSingleObject(raw_handle(&process), INFINITE);
            }
            self.state = ProcessTreeState::Exited { root_pid };
            return Err(error);
        }

        Ok(WindowsProcessWaiter {
            pid: root_pid.get(),
            process,
        })
    }

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
    use super::{
        application_user_model_id, codex_launch_description, command_line, environment_block,
        package_family_name, sanitized_launch_environment, WindowsLaunchDescription,
        WindowsProcessTree, WindowsProcessWaiter,
    };
    use crate::platform::process_tree::{ProcessTree, StopResult};
    use crate::platform::CodexProfileDirectories;
    use std::{
        ffi::OsString,
        fs,
        num::NonZeroU32,
        os::windows::ffi::OsStringExt,
        os::windows::io::{AsRawHandle, FromRawHandle},
        path::PathBuf,
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

    fn cmd_description(arguments: impl IntoIterator<Item = OsString>) -> WindowsLaunchDescription {
        WindowsLaunchDescription {
            executable_path: std::env::var_os("ComSpec")
                .map(Into::into)
                .unwrap_or_else(|| PathBuf::from(r"C:\Windows\System32\cmd.exe")),
            arguments: arguments.into_iter().collect(),
            current_directory: std::env::temp_dir(),
            environment: sanitized_launch_environment(std::env::vars_os()),
        }
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
    fn launch_description_quotes_unicode_paths_and_sorts_a_private_environment() {
        let description = WindowsLaunchDescription {
            executable_path: PathBuf::from(r"C:\Program Files\Node 22\node.exe"),
            arguments: vec![
                OsString::from(r"C:\资源 目录\injector.mjs"),
                OsString::from("--profile-path"),
                OsString::from(r"C:\Users\示例 User\profile\"),
                OsString::from("quote\"inside"),
            ],
            current_directory: PathBuf::from(r"C:\Program Files\Taskboard\resources\app"),
            environment: sanitized_launch_environment([
                (
                    OsString::from("Path"),
                    OsString::from(r"C:\Windows\System32"),
                ),
                (
                    OsString::from("codex_taskboard_instance_secret"),
                    OsString::from("must-not-reach-child"),
                ),
                (
                    OsString::from("APPDATA"),
                    OsString::from(r"C:\Users\示例\AppData"),
                ),
            ]),
        };

        let command = command_line(&description).unwrap();
        let command = OsString::from_wide(&command[..command.len() - 1])
            .to_string_lossy()
            .into_owned();
        assert!(command
            .starts_with(r#""C:\Program Files\Node 22\node.exe" "C:\资源 目录\injector.mjs""#));
        assert!(command.contains(r#""C:\Users\示例 User\profile\\""#));
        assert!(command.contains(r#""quote\"inside""#));

        let block = environment_block(&description).unwrap();
        let block = OsString::from_wide(&block).to_string_lossy().into_owned();
        assert!(block.starts_with("APPDATA="));
        assert!(block.contains("\0Path="));
        assert!(!block.to_ascii_uppercase().contains("CODEX_TASKBOARD_"));
        assert!(block.ends_with("\0\0"));
    }

    #[test]
    fn codex_launch_description_uses_launch_only_and_explicit_profile_arguments() {
        let profiles = CodexProfileDirectories {
            independent: PathBuf::from(r"C:\Users\示例 User\Taskboard\codex-profile"),
            source: PathBuf::from(r"C:\Users\示例 User\AppData\Roaming\Codex"),
        };
        let description = codex_launch_description(
            PathBuf::from(r"C:\Program Files\Taskboard\node.exe"),
            PathBuf::from(r"C:\Program Files\Taskboard\resources\app\scripts\codex-injector.mjs"),
            PathBuf::from(r"C:\Program Files\Taskboard\resources\app"),
            PathBuf::from(r"C:\Program Files\WindowsApps\OpenAI.Codex\app\ChatGPT.exe"),
            &profiles,
        );

        assert_eq!(description.arguments[1], "--launch-only");
        assert_eq!(description.arguments[2], "--app-path");
        assert_eq!(description.arguments[4], "--profile-path");
        assert_eq!(
            PathBuf::from(&description.arguments[5]),
            profiles.independent
        );
        assert_eq!(description.arguments[6], "--source-profile-path");
        assert_eq!(PathBuf::from(&description.arguments[7]), profiles.source);
        assert!(!description
            .arguments
            .iter()
            .any(|argument| { argument.to_string_lossy().contains("remote-debugging") }));
        assert!(!description.environment.iter().any(|(name, _)| {
            name.to_string_lossy()
                .to_ascii_uppercase()
                .starts_with("CODEX_TASKBOARD_")
        }));
    }

    #[test]
    fn suspended_launch_assigns_before_resume_and_reports_normal_exit() {
        let mut tree = WindowsProcessTree::create().unwrap();
        let launched = tree
            .spawn_suspended(&cmd_description([
                "/D".into(),
                "/S".into(),
                "/C".into(),
                "exit 0".into(),
            ]))
            .unwrap();
        assert!(launched.pid() > 0);
        assert_eq!(launched.wait().unwrap(), 0);
        assert!(matches!(
            tree.stop_gracefully(Duration::from_secs(1)).unwrap(),
            StopResult::AlreadyExited | StopResult::Exited
        ));
        tree.release().unwrap();
    }

    #[test]
    fn suspended_launch_handles_an_executable_path_with_spaces_and_unicode() {
        let root = std::env::temp_dir().join(format!(
            "codex-taskboard Windows 启动 {}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let copied_executable = root.join("命令 helper.exe");
        fs::copy(
            std::env::var_os("ComSpec").unwrap_or_else(|| r"C:\Windows\System32\cmd.exe".into()),
            &copied_executable,
        )
        .unwrap();
        let mut description =
            cmd_description(["/D".into(), "/S".into(), "/C".into(), "exit 0".into()]);
        description.executable_path = copied_executable;
        description.current_directory = root.clone();

        let mut tree = WindowsProcessTree::create().unwrap();
        let launched = tree.spawn_suspended(&description).unwrap();
        assert_eq!(launched.wait().unwrap(), 0);
        assert!(matches!(
            tree.stop_gracefully(Duration::from_secs(1)).unwrap(),
            StopResult::AlreadyExited | StopResult::Exited
        ));
        tree.release().unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn suspended_launch_failure_leaves_the_job_reusable_and_does_not_adopt_a_pid() {
        let mut tree = WindowsProcessTree::create().unwrap();
        let mut description = cmd_description(std::iter::empty::<OsString>());
        description.executable_path = PathBuf::from(r"C:\missing taskboard\不存在.exe");
        let error = tree.spawn_suspended(&description).unwrap_err();
        assert!(matches!(
            error,
            crate::platform::process_tree::ProcessTreeError::Platform {
                operation: "create_suspended",
                ..
            }
        ));
        assert_eq!(
            tree.state(),
            crate::platform::process_tree::ProcessTreeState::Created
        );
        tree.release().unwrap();
    }

    #[test]
    fn forcing_a_suspended_launch_tree_does_not_terminate_an_existing_process() {
        let mut existing = ping_child("30");
        let mut tree = WindowsProcessTree::create().unwrap();
        let launched = tree
            .spawn_suspended(&cmd_description([
                "/D".into(),
                "/S".into(),
                "/C".into(),
                "ping -n 30 127.0.0.1 >NUL".into(),
            ]))
            .unwrap();

        assert_eq!(
            tree.force_stop(Duration::from_secs(3)).unwrap(),
            StopResult::Exited
        );
        assert_ne!(launched.wait().unwrap(), 0);
        assert!(existing.try_wait().unwrap().is_none());
        existing.kill().unwrap();
        existing.wait().unwrap();
        tree.release().unwrap();
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
        assert_is_send::<WindowsProcessWaiter>();
    }
}
