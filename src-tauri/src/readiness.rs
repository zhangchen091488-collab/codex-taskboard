use serde::Deserialize;
use std::{
    sync::mpsc::{Receiver, RecvTimeoutError},
    time::Duration,
};

pub const LAUNCHER_READINESS_PREFIX: &str = "CODEX_TASKBOARD_READINESS_V1 ";
const READINESS_TYPE: &str = "codex-taskboard:readiness";
const READINESS_VERSION: u8 = 1;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListeningReadiness {
    pub host: String,
    pub port: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ReadinessEvent {
    Listening(ListeningReadiness),
    Error,
}

pub fn taskboard_url(readiness: &ListeningReadiness, instance_token: &str) -> String {
    format!(
        "http://{}:{}/{}",
        readiness.host, readiness.port, instance_token
    )
}

#[derive(Deserialize)]
#[serde(tag = "status", deny_unknown_fields)]
enum ReadinessMessage {
    #[serde(rename = "listening")]
    Listening {
        #[serde(rename = "type")]
        message_type: String,
        version: u8,
        host: String,
        port: u16,
    },
    #[serde(rename = "error")]
    Error {
        #[serde(rename = "type")]
        message_type: String,
        version: u8,
        code: String,
    },
}

fn validate_header(message_type: &str, version: u8) -> Result<(), String> {
    if message_type != READINESS_TYPE || version != READINESS_VERSION {
        return Err("Taskboard readiness message has an unsupported type or version".into());
    }
    Ok(())
}

pub fn parse_launcher_readiness_line(line: &str) -> Result<Option<ReadinessEvent>, String> {
    let Some(payload) = line.strip_prefix(LAUNCHER_READINESS_PREFIX) else {
        return Ok(None);
    };
    let message: ReadinessMessage = serde_json::from_str(payload)
        .map_err(|_| "Taskboard readiness message is malformed".to_string())?;
    match message {
        ReadinessMessage::Listening {
            message_type,
            version,
            host,
            port,
        } => {
            validate_header(&message_type, version)?;
            if host != "127.0.0.1" {
                return Err("Taskboard readiness host must be 127.0.0.1".into());
            }
            if port == 0 {
                return Err("Taskboard readiness port must be between 1 and 65535".into());
            }
            Ok(Some(ReadinessEvent::Listening(ListeningReadiness {
                host,
                port,
            })))
        }
        ReadinessMessage::Error {
            message_type,
            version,
            code,
        } => {
            validate_header(&message_type, version)?;
            if code != "LISTEN_FAILED" {
                return Err("Taskboard readiness error code is not supported".into());
            }
            Ok(Some(ReadinessEvent::Error))
        }
    }
}

pub fn wait_for_taskboard_readiness(
    receiver: &Receiver<Result<ListeningReadiness, String>>,
    timeout: Duration,
) -> Result<ListeningReadiness, String> {
    match receiver.recv_timeout(timeout) {
        Ok(result) => result,
        Err(RecvTimeoutError::Timeout) => Err("Timed out waiting for Taskboard readiness".into()),
        Err(RecvTimeoutError::Disconnected) => {
            Err("Launcher child exited before Taskboard readiness".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn listening_line(port: u16) -> String {
        format!(
            "{LAUNCHER_READINESS_PREFIX}{{\"type\":\"codex-taskboard:readiness\",\"version\":1,\"status\":\"listening\",\"host\":\"127.0.0.1\",\"port\":{port}}}"
        )
    }

    #[test]
    fn parses_only_the_versioned_loopback_message() {
        assert_eq!(
            parse_launcher_readiness_line(&listening_line(49_152)).unwrap(),
            Some(ReadinessEvent::Listening(ListeningReadiness {
                host: "127.0.0.1".into(),
                port: 49_152,
            }))
        );
        assert_eq!(parse_launcher_readiness_line("ordinary log").unwrap(), None);
        for payload in [
            "{\"type\":\"codex-taskboard:readiness\",\"version\":2,\"status\":\"listening\",\"host\":\"127.0.0.1\",\"port\":49152}",
            "{\"type\":\"codex-taskboard:readiness\",\"version\":1,\"status\":\"listening\",\"host\":\"0.0.0.0\",\"port\":49152}",
            "{\"type\":\"codex-taskboard:readiness\",\"version\":1,\"status\":\"listening\",\"host\":\"127.0.0.1\",\"port\":0}",
            "{\"type\":\"codex-taskboard:readiness\",\"version\":1,\"status\":\"listening\",\"host\":\"127.0.0.1\",\"port\":49152,\"secret\":\"forbidden\"}",
            "not-json",
        ] {
            assert!(parse_launcher_readiness_line(&format!(
                "{LAUNCHER_READINESS_PREFIX}{payload}"
            ))
            .is_err());
        }
    }

    #[test]
    fn returns_generic_server_error_readiness() {
        let line = format!(
            "{LAUNCHER_READINESS_PREFIX}{{\"type\":\"codex-taskboard:readiness\",\"version\":1,\"status\":\"error\",\"code\":\"LISTEN_FAILED\"}}"
        );
        assert_eq!(
            parse_launcher_readiness_line(&line).unwrap(),
            Some(ReadinessEvent::Error)
        );
    }

    #[test]
    fn readiness_wait_returns_a_valid_listening_message() {
        let (sender, receiver) = mpsc::channel();
        sender
            .send(Ok(ListeningReadiness {
                host: "127.0.0.1".into(),
                port: 49_152,
            }))
            .unwrap();
        assert_eq!(
            wait_for_taskboard_readiness(&receiver, Duration::from_millis(10))
                .unwrap()
                .port,
            49_152
        );
    }

    #[test]
    fn constructs_the_private_taskboard_url_only_from_validated_readiness() {
        let readiness = ListeningReadiness {
            host: "127.0.0.1".into(),
            port: 49_152,
        };
        assert_eq!(
            taskboard_url(&readiness, "00000000-0000-4000-8000-000000000001"),
            "http://127.0.0.1:49152/00000000-0000-4000-8000-000000000001"
        );
    }

    #[test]
    fn readiness_wait_reports_timeout() {
        let (_sender, receiver) = mpsc::channel();
        assert_eq!(
            wait_for_taskboard_readiness(&receiver, Duration::from_millis(1)).unwrap_err(),
            "Timed out waiting for Taskboard readiness"
        );
    }

    #[test]
    fn readiness_wait_reports_child_exit() {
        let (sender, receiver) = mpsc::channel::<Result<ListeningReadiness, String>>();
        drop(sender);
        assert_eq!(
            wait_for_taskboard_readiness(&receiver, Duration::from_millis(10)).unwrap_err(),
            "Launcher child exited before Taskboard readiness"
        );
    }

    #[test]
    fn readiness_wait_preserves_a_sanitized_protocol_error() {
        let (sender, receiver) = mpsc::channel();
        sender
            .send(Err("Taskboard readiness message is malformed".into()))
            .unwrap();
        assert_eq!(
            wait_for_taskboard_readiness(&receiver, Duration::from_millis(10)).unwrap_err(),
            "Taskboard readiness message is malformed"
        );
    }
}
