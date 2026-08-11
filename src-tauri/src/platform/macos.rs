use std::{
    num::NonZeroU32,
    os::unix::process::CommandExt,
    path::PathBuf,
    process::Command,
    thread,
    time::{Duration, Instant},
};

use tauri::{ActivationPolicy, Manager};

use super::{
    process_tree::{ProcessTree, ProcessTreeError, ProcessTreeState, StopResult},
    AppDirectories,
};

pub struct MacProcessTree {
    state: ProcessTreeState,
}

fn root_pid(state: ProcessTreeState) -> Option<NonZeroU32> {
    match state {
        ProcessTreeState::Running { root_pid }
        | ProcessTreeState::Stopping { root_pid }
        | ProcessTreeState::Exited { root_pid } => Some(root_pid),
        ProcessTreeState::Created => None,
    }
}

fn send_process_group_signal(pid: NonZeroU32, signal: i32) {
    unsafe {
        if libc::kill(-(pid.get() as i32), signal) != 0 {
            libc::kill(pid.get() as i32, signal);
        }
    }
}

fn process_group_is_running(pid: NonZeroU32) -> bool {
    unsafe { libc::kill(-(pid.get() as i32), 0) == 0 }
}

fn wait_for_process_group_exit(pid: NonZeroU32, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while process_group_is_running(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(100));
    }
    !process_group_is_running(pid)
}

impl ProcessTree for MacProcessTree {
    fn create() -> Result<Self, ProcessTreeError> {
        Ok(Self {
            state: ProcessTreeState::Created,
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
        if root_pid.get() > i32::MAX as u32 {
            return Err(ProcessTreeError::Platform {
                operation: "register_root",
                code: None,
                message: "root PID exceeds macOS pid_t range".into(),
            });
        }
        self.state = ProcessTreeState::Running { root_pid };
        Ok(())
    }

    fn is_running(&mut self) -> Result<bool, ProcessTreeError> {
        let Some(pid) = root_pid(self.state) else {
            return Ok(false);
        };
        if matches!(self.state, ProcessTreeState::Exited { .. }) {
            return Ok(false);
        }
        let running = process_group_is_running(pid);
        if !running {
            self.state = ProcessTreeState::Exited { root_pid: pid };
        }
        Ok(running)
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
        if !process_group_is_running(root_pid) {
            self.state = ProcessTreeState::Exited { root_pid };
            return Ok(StopResult::AlreadyExited);
        }
        send_process_group_signal(root_pid, libc::SIGTERM);
        if wait_for_process_group_exit(root_pid, timeout) {
            self.state = ProcessTreeState::Exited { root_pid };
            Ok(StopResult::Exited)
        } else {
            self.state = ProcessTreeState::Stopping { root_pid };
            Ok(StopResult::TimedOut)
        }
    }

    fn force_stop(&mut self, timeout: Duration) -> Result<StopResult, ProcessTreeError> {
        let Some(root_pid) = root_pid(self.state) else {
            return Err(ProcessTreeError::InvalidTransition {
                operation: "force_stop",
                state: self.state,
            });
        };
        if matches!(self.state, ProcessTreeState::Exited { .. })
            || !process_group_is_running(root_pid)
        {
            self.state = ProcessTreeState::Exited { root_pid };
            return Ok(StopResult::AlreadyExited);
        }
        send_process_group_signal(root_pid, libc::SIGKILL);
        if wait_for_process_group_exit(root_pid, timeout) {
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

impl Drop for MacProcessTree {
    fn drop(&mut self) {
        if matches!(
            self.state,
            ProcessTreeState::Running { .. } | ProcessTreeState::Stopping { .. }
        ) {
            let _ = self.force_stop(Duration::from_secs(1));
        }
    }
}

fn select_app_directory(standard: PathBuf, legacy: PathBuf) -> PathBuf {
    if legacy.exists() {
        legacy
    } else {
        standard
    }
}

pub fn configure_app(app: &mut tauri::App) {
    app.set_activation_policy(ActivationPolicy::Accessory);
}

pub fn configure_process_tree_command(command: &mut Command) {
    command.process_group(0);
}

pub fn app_directories(app: &tauri::App) -> tauri::Result<AppDirectories> {
    let home = app.path().home_dir()?;
    let standard_data = app.path().app_data_dir()?;
    let standard_logs = app.path().app_log_dir()?;
    let legacy_data = home.join("Library/Application Support/Codex Taskboard");
    let legacy_logs = home.join("Library/Logs/Codex Taskboard");

    Ok(AppDirectories {
        data: select_app_directory(standard_data, legacy_data),
        logs: select_app_directory(standard_logs, legacy_logs),
    })
}

#[cfg(test)]
mod tests {
    use super::{select_app_directory, MacProcessTree};
    use crate::platform::process_tree::{ProcessTree, StopResult};
    use std::{
        fs, num::NonZeroU32, os::unix::process::CommandExt, path::PathBuf, process::Command,
        thread, time::Duration,
    };
    use uuid::Uuid;

    fn process_tree_for_child(
        mut child: std::process::Child,
    ) -> (MacProcessTree, thread::JoinHandle<()>) {
        let pid = NonZeroU32::new(child.id()).unwrap();
        let mut tree = MacProcessTree::create().unwrap();
        tree.register_root(pid).unwrap();
        let waiter = thread::spawn(move || {
            let _ = child.wait();
        });
        (tree, waiter)
    }

    #[test]
    fn existing_legacy_directory_remains_authoritative() {
        let root = std::env::temp_dir().join(format!("codex-taskboard-{}", Uuid::new_v4()));
        let standard = root.join("com.chuspeeism.codex-taskboard");
        let legacy = root.join("Codex Taskboard");
        fs::create_dir_all(&legacy).expect("create legacy data directory");

        assert_eq!(select_app_directory(standard, legacy.clone()), legacy);
        fs::remove_dir_all(root).expect("remove test directories");
    }

    #[test]
    fn new_install_uses_standard_directory_without_rewriting_the_path() {
        let standard = PathBuf::from(
            "/Users/示例 User/Library/Application Support/com.chuspeeism.codex-taskboard",
        );
        let legacy = PathBuf::from("/Users/示例 User/Library/Application Support/Codex Taskboard");

        assert_eq!(select_app_directory(standard.clone(), legacy), standard);
    }

    #[test]
    fn process_tree_stops_a_cooperative_group_gracefully() {
        let mut command = Command::new("/bin/sleep");
        command.arg("30").process_group(0);
        let (mut tree, waiter) = process_tree_for_child(command.spawn().unwrap());

        assert!(tree.is_running().unwrap());
        assert_eq!(
            tree.stop_gracefully(Duration::from_secs(2)).unwrap(),
            StopResult::Exited
        );
        waiter.join().unwrap();
        tree.release().unwrap();
    }

    #[test]
    fn process_tree_rejects_a_root_outside_pid_t_range() {
        let mut tree = MacProcessTree::create().unwrap();
        let invalid = NonZeroU32::new(i32::MAX as u32 + 1).unwrap();
        assert!(matches!(
            tree.register_root(invalid),
            Err(crate::platform::process_tree::ProcessTreeError::Platform {
                operation: "register_root",
                ..
            })
        ));
        tree.release().unwrap();
    }

    #[test]
    fn process_tree_forces_a_group_after_graceful_timeout() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "trap '' TERM; exec /bin/sleep 30"])
            .process_group(0);
        let (mut tree, waiter) = process_tree_for_child(command.spawn().unwrap());
        thread::sleep(Duration::from_millis(100));

        assert_eq!(
            tree.stop_gracefully(Duration::from_millis(200)).unwrap(),
            StopResult::TimedOut
        );
        assert_eq!(
            tree.force_stop(Duration::from_secs(2)).unwrap(),
            StopResult::Exited
        );
        waiter.join().unwrap();
        tree.release().unwrap();
    }

    #[test]
    fn process_tree_stops_an_orphan_after_the_root_exits() {
        let mut command = Command::new("/bin/sh");
        command
            .args(["-c", "/bin/sleep 30 & exit 0"])
            .process_group(0);
        let (mut tree, waiter) = process_tree_for_child(command.spawn().unwrap());
        waiter.join().unwrap();

        assert!(tree.is_running().unwrap());
        assert_eq!(
            tree.stop_gracefully(Duration::from_secs(2)).unwrap(),
            StopResult::Exited
        );
        tree.release().unwrap();
    }
}
