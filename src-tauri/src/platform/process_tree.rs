use std::{fmt, num::NonZeroU32, time::Duration};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessTreeState {
    Created,
    Running { root_pid: NonZeroU32 },
    Stopping { root_pid: NonZeroU32 },
    Exited { root_pid: NonZeroU32 },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StopResult {
    AlreadyExited,
    Exited,
    TimedOut,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProcessTreeError {
    InvalidTransition {
        operation: &'static str,
        state: ProcessTreeState,
    },
    Platform {
        operation: &'static str,
        code: Option<i64>,
        message: String,
    },
}

impl fmt::Display for ProcessTreeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTransition { operation, state } => {
                write!(
                    formatter,
                    "{operation} is invalid while the process tree is {state:?}"
                )
            }
            Self::Platform {
                operation,
                code,
                message,
            } => match code {
                Some(code) => write!(formatter, "{operation} failed ({code}): {message}"),
                None => write!(formatter, "{operation} failed: {message}"),
            },
        }
    }
}

impl std::error::Error for ProcessTreeError {}

/// Owns the lifecycle boundary for one launcher-managed process tree.
///
/// Implementations must reject a second root registration. A graceful stop
/// returning `TimedOut` must leave the tree eligible for `force_stop`.
/// `release` consumes the owner and must reject a still-running tree rather
/// than detach it. Dropping an implementation must never detach live children.
pub trait ProcessTree: Send + Sized {
    fn create() -> Result<Self, ProcessTreeError>;

    fn state(&self) -> ProcessTreeState;

    fn register_root(&mut self, root_pid: NonZeroU32) -> Result<(), ProcessTreeError>;

    /// Refreshes liveness and transitions a completed tree to `Exited`.
    fn is_running(&mut self) -> Result<bool, ProcessTreeError>;

    fn stop_gracefully(&mut self, timeout: Duration) -> Result<StopResult, ProcessTreeError>;

    fn force_stop(&mut self, timeout: Duration) -> Result<StopResult, ProcessTreeError>;

    fn release(self) -> Result<(), ProcessTreeError>;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_contract<T: ProcessTree>() {}

    struct ContractExample {
        state: ProcessTreeState,
    }

    impl ProcessTree for ContractExample {
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
            self.state = ProcessTreeState::Running { root_pid };
            Ok(())
        }

        fn is_running(&mut self) -> Result<bool, ProcessTreeError> {
            Ok(matches!(
                self.state,
                ProcessTreeState::Running { .. } | ProcessTreeState::Stopping { .. }
            ))
        }

        fn stop_gracefully(&mut self, _timeout: Duration) -> Result<StopResult, ProcessTreeError> {
            match self.state {
                ProcessTreeState::Running { root_pid } => {
                    self.state = ProcessTreeState::Stopping { root_pid };
                    Ok(StopResult::TimedOut)
                }
                ProcessTreeState::Exited { .. } => Ok(StopResult::AlreadyExited),
                state => Err(ProcessTreeError::InvalidTransition {
                    operation: "stop_gracefully",
                    state,
                }),
            }
        }

        fn force_stop(&mut self, _timeout: Duration) -> Result<StopResult, ProcessTreeError> {
            match self.state {
                ProcessTreeState::Stopping { root_pid } => {
                    self.state = ProcessTreeState::Exited { root_pid };
                    Ok(StopResult::Exited)
                }
                ProcessTreeState::Exited { .. } => Ok(StopResult::AlreadyExited),
                state => Err(ProcessTreeError::InvalidTransition {
                    operation: "force_stop",
                    state,
                }),
            }
        }

        fn release(self) -> Result<(), ProcessTreeError> {
            if matches!(
                self.state,
                ProcessTreeState::Created | ProcessTreeState::Exited { .. }
            ) {
                Ok(())
            } else {
                Err(ProcessTreeError::InvalidTransition {
                    operation: "release",
                    state: self.state,
                })
            }
        }
    }

    #[test]
    fn contract_covers_registration_graceful_timeout_force_and_release() {
        assert_contract::<ContractExample>();
        let root_pid = NonZeroU32::new(42).unwrap();
        let mut tree = ContractExample::create().unwrap();
        assert_eq!(tree.state(), ProcessTreeState::Created);
        tree.register_root(root_pid).unwrap();
        assert!(tree.is_running().unwrap());
        assert_eq!(
            tree.stop_gracefully(Duration::from_millis(1)).unwrap(),
            StopResult::TimedOut
        );
        assert_eq!(
            tree.force_stop(Duration::from_millis(1)).unwrap(),
            StopResult::Exited
        );
        assert!(!tree.is_running().unwrap());
        tree.release().unwrap();
    }

    #[test]
    fn contract_rejects_duplicate_registration_and_live_release() {
        let root_pid = NonZeroU32::new(42).unwrap();
        let mut tree = ContractExample::create().unwrap();
        assert!(matches!(
            tree.stop_gracefully(Duration::from_millis(1)),
            Err(ProcessTreeError::InvalidTransition {
                operation: "stop_gracefully",
                ..
            })
        ));
        tree.register_root(root_pid).unwrap();
        assert!(matches!(
            tree.register_root(root_pid),
            Err(ProcessTreeError::InvalidTransition {
                operation: "register_root",
                ..
            })
        ));
        assert!(matches!(
            tree.release(),
            Err(ProcessTreeError::InvalidTransition {
                operation: "release",
                ..
            })
        ));
    }

    #[test]
    fn platform_error_retains_operation_and_native_code() {
        let error = ProcessTreeError::Platform {
            operation: "assign_root",
            code: Some(5),
            message: "access denied".into(),
        };
        assert_eq!(
            error,
            ProcessTreeError::Platform {
                operation: "assign_root",
                code: Some(5),
                message: "access denied".into(),
            }
        );
        assert_eq!(error.to_string(), "assign_root failed (5): access denied");
    }
}
