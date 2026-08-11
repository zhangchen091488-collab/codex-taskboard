use serde::Deserialize;
use std::{
    fs,
    io::ErrorKind,
    path::Path,
    thread,
    time::{Duration, Instant},
};

const MESSAGE_TYPE: &str = "codex-taskboard:cdp-transport";
const MESSAGE_VERSION: u64 = 1;
const ERROR_CODE: &str = "CDP_TRANSPORT_FAILED";
const POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Debug, PartialEq, Eq)]
pub enum TransportReadiness {
    Ready,
    Failed,
}

#[derive(Deserialize)]
struct ReadinessHeader {
    #[serde(rename = "type")]
    message_type: String,
    version: u64,
    status: String,
    nonce: String,
}

fn remove_readiness_file(path: &Path) {
    match fs::remove_file(path) {
        Ok(()) => {}
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(_) => {}
    }
}

fn parse_readiness(payload: &[u8], expected_nonce: &str) -> Result<TransportReadiness, String> {
    let value: serde_json::Value = serde_json::from_slice(payload)
        .map_err(|_| "Codex transport readiness is malformed".to_string())?;
    let object = value
        .as_object()
        .ok_or_else(|| "Codex transport readiness must be an object".to_string())?;
    let header: ReadinessHeader = serde_json::from_value(value.clone())
        .map_err(|_| "Codex transport readiness header is invalid".to_string())?;
    if header.message_type != MESSAGE_TYPE
        || header.version != MESSAGE_VERSION
        || header.nonce != expected_nonce
    {
        return Err("Codex transport readiness header is invalid".into());
    }

    let required_keys: &[&str] = match header.status.as_str() {
        "ready" => &["type", "version", "status", "transport", "nonce"],
        "error" => &["type", "version", "status", "code", "nonce"],
        _ => return Err("Codex transport readiness status is unsupported".into()),
    };
    if object.len() != required_keys.len()
        || !required_keys.iter().all(|key| object.contains_key(*key))
    {
        return Err("Codex transport readiness has unexpected fields".into());
    }

    match header.status.as_str() {
        "ready" if object.get("transport").and_then(|value| value.as_str()) == Some("pipe") => {
            Ok(TransportReadiness::Ready)
        }
        "ready" => Err("Codex transport must use a private pipe".into()),
        "error" if object.get("code").and_then(|value| value.as_str()) == Some(ERROR_CODE) => {
            Ok(TransportReadiness::Failed)
        }
        "error" => Err("Codex transport error code is unsupported".into()),
        _ => unreachable!(),
    }
}

pub fn wait_for_transport_readiness<F>(
    path: &Path,
    expected_nonce: &str,
    timeout: Duration,
    mut child_has_exited: F,
) -> Result<TransportReadiness, String>
where
    F: FnMut() -> Result<bool, String>,
{
    let deadline = Instant::now()
        .checked_add(timeout)
        .unwrap_or_else(Instant::now);
    loop {
        match fs::read(path) {
            Ok(payload) => {
                let result = parse_readiness(&payload, expected_nonce);
                remove_readiness_file(path);
                return result;
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(_) => {
                remove_readiness_file(path);
                return Err("Codex transport readiness could not be read".into());
            }
        }

        if child_has_exited()? {
            remove_readiness_file(path);
            return Err("Codex exited before its private transport was ready".into());
        }
        let now = Instant::now();
        if now >= deadline {
            remove_readiness_file(path);
            return Err("Timed out waiting for the private Codex transport".into());
        }
        thread::sleep(POLL_INTERVAL.min(deadline.saturating_duration_since(now)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;
    use uuid::Uuid;

    const NONCE: &str = "00000000-0000-4000-8000-000000000053";

    fn fixture_path() -> PathBuf {
        std::env::temp_dir().join(format!("codex-transport-{}.json", Uuid::new_v4()))
    }

    fn write_fixture(path: &Path, value: serde_json::Value) {
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }

    #[test]
    fn accepts_ready_private_pipe_and_removes_file() {
        let path = fixture_path();
        write_fixture(
            &path,
            json!({
                "type": MESSAGE_TYPE,
                "version": MESSAGE_VERSION,
                "status": "ready",
                "transport": "pipe",
                "nonce": NONCE,
            }),
        );
        assert_eq!(
            wait_for_transport_readiness(&path, NONCE, Duration::from_secs(1), || Ok(false))
                .unwrap(),
            TransportReadiness::Ready
        );
        assert!(!path.exists());
    }

    #[test]
    fn accepts_only_the_fixed_error_code() {
        let path = fixture_path();
        write_fixture(
            &path,
            json!({
                "type": MESSAGE_TYPE,
                "version": MESSAGE_VERSION,
                "status": "error",
                "code": ERROR_CODE,
                "nonce": NONCE,
            }),
        );
        assert_eq!(
            wait_for_transport_readiness(&path, NONCE, Duration::from_secs(1), || Ok(false))
                .unwrap(),
            TransportReadiness::Failed
        );
    }

    #[test]
    fn rejects_malformed_stale_public_and_secret_bearing_messages() {
        for value in [
            json!({"type": MESSAGE_TYPE, "version": 1, "status": "ready", "transport": "port", "nonce": NONCE}),
            json!({"type": MESSAGE_TYPE, "version": 1, "status": "ready", "transport": "pipe", "nonce": "stale"}),
            json!({"type": MESSAGE_TYPE, "version": 1, "status": "ready", "transport": "pipe", "nonce": NONCE, "token": "secret"}),
            json!({"type": MESSAGE_TYPE, "version": 1, "status": "error", "code": "raw failure", "nonce": NONCE}),
        ] {
            let path = fixture_path();
            write_fixture(&path, value);
            assert!(
                wait_for_transport_readiness(&path, NONCE, Duration::from_secs(1), || Ok(false))
                    .is_err()
            );
            assert!(!path.exists());
        }
    }

    #[test]
    fn reports_early_exit_without_waiting_for_timeout() {
        let path = fixture_path();
        let error = wait_for_transport_readiness(&path, NONCE, Duration::from_secs(1), || Ok(true))
            .unwrap_err();
        assert!(error.contains("exited"));
    }

    #[test]
    fn times_out_and_removes_a_stale_file_name() {
        let path = fixture_path();
        let error =
            wait_for_transport_readiness(&path, NONCE, Duration::from_millis(1), || Ok(false))
                .unwrap_err();
        assert!(error.contains("Timed out"));
        assert!(!path.exists());
    }
}
