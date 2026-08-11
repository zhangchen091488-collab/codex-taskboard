use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{Ipv4Addr, SocketAddr, SocketAddrV4, TcpStream},
    path::Path,
    time::Duration,
};

use serde::{Deserialize, Serialize};

pub const LAUNCHER_RECORD_VERSION: u32 = 2;
const RUNTIME_DESCRIPTOR_VERSION: u32 = 2;
const HEALTH_TIMEOUT: Duration = Duration::from_millis(750);
const MAX_HEALTH_RESPONSE_BYTES: u64 = 16 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LauncherRecord {
    pub version: u32,
    pub pid: u32,
    pub startup_nonce: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeDescriptor {
    version: u32,
    pid: u32,
    startup_nonce: String,
    host: String,
    port: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: String,
    product: String,
    startup_nonce: String,
}

fn valid_nonce(value: &str) -> bool {
    (16..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
}

fn parse_record(content: &[u8]) -> Result<LauncherRecord, String> {
    let value: serde_json::Value =
        serde_json::from_slice(content).map_err(|error| format!("invalid JSON: {error}"))?;
    let version = value.get("version").and_then(serde_json::Value::as_u64);
    if version != Some(LAUNCHER_RECORD_VERSION as u64) {
        return Err(format!(
            "unsupported launcher record version {}",
            version
                .map(|value| value.to_string())
                .unwrap_or_else(|| "legacy".into())
        ));
    }
    let record: LauncherRecord =
        serde_json::from_value(value).map_err(|error| format!("invalid fields: {error}"))?;
    if record.pid == 0 {
        return Err("launcher record PID must be non-zero".into());
    }
    if !valid_nonce(&record.startup_nonce) {
        return Err("launcher record startup nonce is invalid".into());
    }
    Ok(record)
}

pub fn read_record(path: &Path) -> Result<Option<LauncherRecord>, String> {
    match fs::read(path) {
        Ok(content) => parse_record(&content).map(Some),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("could not read launcher record: {error}")),
    }
}

pub fn write_record(path: &Path, pid: u32, startup_nonce: &str) -> Result<(), String> {
    if pid == 0 {
        return Err("launcher record PID must be non-zero".into());
    }
    if !valid_nonce(startup_nonce) {
        return Err("launcher record startup nonce is invalid".into());
    }
    let record = LauncherRecord {
        version: LAUNCHER_RECORD_VERSION,
        pid,
        startup_nonce: startup_nonce.into(),
    };
    let content = serde_json::to_vec(&record).map_err(|error| error.to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "launcher record path has no parent directory".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary_path = parent.join(format!(".launcher-child-{startup_nonce}.tmp"));
    let write_result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary_path)
            .map_err(|error| error.to_string())?;
        file.write_all(&content)
            .and_then(|_| file.write_all(b"\n"))
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        fs::rename(&temporary_path, path).map_err(|error| error.to_string())
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary_path);
    }
    write_result
}

pub fn remove_record(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove launcher record: {error}")),
    }
}

pub fn clear_record_if_matches(path: &Path, pid: u32, startup_nonce: &str) -> Result<bool, String> {
    let Some(record) = read_record(path)? else {
        return Ok(false);
    };
    if record.pid != pid || record.startup_nonce != startup_nonce {
        return Ok(false);
    }
    remove_record(path)?;
    Ok(true)
}

fn health_response_body(response: &[u8]) -> Option<&[u8]> {
    let separator = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")?;
    let headers = std::str::from_utf8(&response[..separator]).ok()?;
    let status_line = headers.lines().next()?;
    if !status_line.starts_with("HTTP/1.1 200 ") && !status_line.starts_with("HTTP/1.0 200 ") {
        return None;
    }
    Some(&response[separator + 4..])
}

fn verify_health(port: u16, startup_nonce: &str) -> Result<bool, String> {
    let address = SocketAddr::V4(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&address, HEALTH_TIMEOUT)
        .map_err(|error| format!("launcher health connection failed: {error}"))?;
    stream
        .set_read_timeout(Some(HEALTH_TIMEOUT))
        .and_then(|_| stream.set_write_timeout(Some(HEALTH_TIMEOUT)))
        .map_err(|error| format!("launcher health timeout setup failed: {error}"))?;
    let challenge = uuid::Uuid::new_v4().simple().to_string();
    write!(
        stream,
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nx-codex-taskboard-challenge: {challenge}\r\nConnection: close\r\n\r\n"
    )
    .and_then(|_| stream.flush())
    .map_err(|error| format!("launcher health request failed: {error}"))?;
    let mut response = Vec::new();
    stream
        .take(MAX_HEALTH_RESPONSE_BYTES)
        .read_to_end(&mut response)
        .map_err(|error| format!("launcher health response failed: {error}"))?;
    let Some(body) = health_response_body(&response) else {
        return Ok(false);
    };
    let health: HealthResponse = match serde_json::from_slice(body) {
        Ok(health) => health,
        Err(_) => return Ok(false),
    };
    Ok(health.status == "ok"
        && health.product == "codex-taskboard"
        && health.startup_nonce == startup_nonce)
}

pub fn verify_recorded_launcher(
    record: &LauncherRecord,
    runtime_path: &Path,
) -> Result<bool, String> {
    let content = match fs::read(runtime_path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("could not read runtime descriptor: {error}")),
    };
    let runtime: RuntimeDescriptor = match serde_json::from_slice(&content) {
        Ok(runtime) => runtime,
        Err(_) => return Ok(false),
    };
    if runtime.version != RUNTIME_DESCRIPTOR_VERSION
        || runtime.pid != record.pid
        || runtime.startup_nonce != record.startup_nonce
        || runtime.host != "127.0.0.1"
        || runtime.port == 0
    {
        return Ok(false);
    }
    verify_health(runtime.port, &record.startup_nonce)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{net::TcpListener, path::PathBuf, thread};

    fn temporary_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "codex-taskboard-launcher-record-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn record_write_is_versioned_atomic_and_cleared_by_pid_and_nonce() {
        let directory = temporary_directory();
        let path = directory.join("launcher-child.json");
        let nonce = uuid::Uuid::new_v4().to_string();
        write_record(&path, 42, &nonce).unwrap();
        assert_eq!(
            read_record(&path).unwrap(),
            Some(LauncherRecord {
                version: LAUNCHER_RECORD_VERSION,
                pid: 42,
                startup_nonce: nonce.clone(),
            })
        );
        assert!(!clear_record_if_matches(&path, 43, &nonce).unwrap());
        assert!(!clear_record_if_matches(&path, 42, "different-valid-nonce").unwrap());
        assert!(clear_record_if_matches(&path, 42, &nonce).unwrap());
        assert_eq!(read_record(&path).unwrap(), None);
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn record_is_private_on_unix() {
        use std::os::unix::fs::PermissionsExt;

        let directory = temporary_directory();
        let path = directory.join("launcher-child.json");
        write_record(&path, 42, &uuid::Uuid::new_v4().to_string()).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn legacy_and_corrupt_records_are_rejected() {
        assert!(parse_record(br#"{"pid":42,"nodePath":"/old/node"}"#).is_err());
        assert!(
            parse_record(br#"{"version":2,"pid":0,"startupNonce":"valid-nonce-value"}"#).is_err()
        );
        assert!(parse_record(b"not json").is_err());
    }

    #[test]
    fn runtime_nonce_and_live_health_endpoint_verify_the_record() {
        let directory = temporary_directory();
        let runtime_path = directory.join("launcher-runtime.json");
        let nonce = uuid::Uuid::new_v4().to_string();
        let record = LauncherRecord {
            version: LAUNCHER_RECORD_VERSION,
            pid: 42,
            startup_nonce: nonce.clone(),
        };
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let response_nonce = nonce.clone();
        let server = thread::spawn(move || {
            let (mut socket, _) = listener.accept().unwrap();
            let mut request = Vec::new();
            let mut chunk = [0u8; 256];
            while !request.windows(4).any(|window| window == b"\r\n\r\n") {
                let size = socket.read(&mut chunk).unwrap();
                assert!(size > 0);
                request.extend_from_slice(&chunk[..size]);
            }
            assert!(String::from_utf8_lossy(&request).contains("GET /health HTTP/1.1"));
            let body = serde_json::json!({
                "status": "ok",
                "product": "codex-taskboard",
                "startupNonce": response_nonce,
            })
            .to_string();
            write!(
                socket,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                body.len(),
                body
            )
            .unwrap();
            socket.flush().unwrap();
        });
        fs::write(
            &runtime_path,
            serde_json::to_vec(&serde_json::json!({
                "version": 2,
                "pid": 42,
                "url": format!("http://127.0.0.1:{port}/{nonce}"),
                "host": "127.0.0.1",
                "port": port,
                "startupNonce": nonce,
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(verify_recorded_launcher(&record, &runtime_path).unwrap());
        server.join().unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stale_or_mismatched_runtime_descriptor_is_not_trusted() {
        let directory = temporary_directory();
        let runtime_path = directory.join("launcher-runtime.json");
        let record = LauncherRecord {
            version: LAUNCHER_RECORD_VERSION,
            pid: 42,
            startup_nonce: uuid::Uuid::new_v4().to_string(),
        };
        fs::write(
            &runtime_path,
            br#"{"version":1,"pid":42,"url":"http://127.0.0.1:9/old"}"#,
        )
        .unwrap();
        assert!(!verify_recorded_launcher(&record, &runtime_path).unwrap());
        fs::write(
            &runtime_path,
            serde_json::to_vec(&serde_json::json!({
                "version": 2,
                "pid": 43,
                "url": "http://127.0.0.1:9/wrong",
                "host": "127.0.0.1",
                "port": 9,
                "startupNonce": record.startup_nonce,
            }))
            .unwrap(),
        )
        .unwrap();
        assert!(!verify_recorded_launcher(&record, &runtime_path).unwrap());
        fs::remove_dir_all(directory).unwrap();
    }
}
