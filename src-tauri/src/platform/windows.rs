use std::{
    ffi::c_void,
    num::NonZeroU32,
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    ptr::{null, null_mut},
    thread,
    time::{Duration, Instant},
};

use tauri::Manager;
use windows_sys::Win32::{
    Foundation::{GetLastError, HANDLE},
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
    use super::WindowsProcessTree;
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
