use serde::{Deserialize, Serialize};
use std::{
    fs::{self, OpenOptions},
    io::Write,
    path::Path,
};

const UPDATE_STATE_SCHEMA_VERSION: u32 = 1;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct UpdateInstallIntent {
    pub schema_version: u32,
    pub phase: String,
    pub target_version: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RecoveredUpdateIntent {
    pub target_version: String,
    pub current_version: String,
    pub installed: bool,
}

impl RecoveredUpdateIntent {
    pub fn message(&self) -> String {
        if self.installed {
            format!("版本 {} 已安装；已清理更新恢复状态。", self.current_version)
        } else {
            format!(
                "上次更新到 {} 未完成；已恢复当前版本 {}。",
                self.target_version, self.current_version
            )
        }
    }
}

fn valid_version(version: &str) -> bool {
    !version.is_empty()
        && version.len() <= 64
        && version
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b".-+".contains(&byte))
}

fn parse_intent(content: &[u8]) -> Result<UpdateInstallIntent, String> {
    let intent: UpdateInstallIntent =
        serde_json::from_slice(content).map_err(|error| format!("invalid JSON: {error}"))?;
    if intent.schema_version != UPDATE_STATE_SCHEMA_VERSION {
        return Err("unsupported Windows update state schema".into());
    }
    if intent.phase != "installing" {
        return Err("unsupported Windows update state phase".into());
    }
    if !valid_version(&intent.target_version) {
        return Err("invalid Windows update target version".into());
    }
    Ok(intent)
}

pub fn write_install_intent(path: &Path, target_version: &str) -> Result<(), String> {
    if !valid_version(target_version) {
        return Err("invalid Windows update target version".into());
    }
    let intent = UpdateInstallIntent {
        schema_version: UPDATE_STATE_SCHEMA_VERSION,
        phase: "installing".into(),
        target_version: target_version.into(),
    };
    let content = serde_json::to_vec(&intent).map_err(|error| error.to_string())?;
    let parent = path
        .parent()
        .ok_or_else(|| "Windows update state path has no parent".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temporary_path = parent.join(format!(".windows-update-{}.tmp", uuid::Uuid::new_v4()));
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

pub fn remove_install_intent(path: &Path) -> Result<(), String> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("could not remove Windows update state: {error}")),
    }
}

pub fn consume_install_intent(
    path: &Path,
    current_version: &str,
) -> Result<Option<RecoveredUpdateIntent>, String> {
    if !valid_version(current_version) {
        return Err("invalid current application version".into());
    }
    let content = match fs::read(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("could not read Windows update state: {error}")),
    };
    let parsed = parse_intent(&content);
    remove_install_intent(path)?;
    let intent = parsed?;
    Ok(Some(RecoveredUpdateIntent {
        installed: intent.target_version == current_version,
        target_version: intent.target_version,
        current_version: current_version.into(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn fixture_path() -> PathBuf {
        std::env::temp_dir().join(format!(
            "codex-taskboard-windows-update-{}.json",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn install_intent_is_atomic_private_and_consumed_once() {
        let path = fixture_path();
        write_install_intent(&path, "1.2.3").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_eq!(
            consume_install_intent(&path, "1.2.3").unwrap(),
            Some(RecoveredUpdateIntent {
                target_version: "1.2.3".into(),
                current_version: "1.2.3".into(),
                installed: true,
            })
        );
        assert_eq!(consume_install_intent(&path, "1.2.3").unwrap(), None);
    }

    #[test]
    fn interrupted_install_reports_the_restored_current_version() {
        let path = fixture_path();
        write_install_intent(&path, "2.0.0").unwrap();
        let recovered = consume_install_intent(&path, "1.9.0").unwrap().unwrap();
        assert!(!recovered.installed);
        assert!(recovered.message().contains("2.0.0 未完成"));
        assert!(recovered.message().contains("当前版本 1.9.0"));
    }

    #[test]
    fn malformed_unknown_and_secret_bearing_states_are_rejected_then_removed() {
        for content in [
            br#"{"schemaVersion":0,"phase":"installing","targetVersion":"1.2.3"}"#.as_slice(),
            br#"{"schemaVersion":1,"phase":"download","targetVersion":"1.2.3"}"#.as_slice(),
            br#"{"schemaVersion":1,"phase":"installing","targetVersion":"../bad"}"#.as_slice(),
            br#"{"schemaVersion":1,"phase":"installing","targetVersion":"1.2.3","token":"secret"}"#
                .as_slice(),
            b"not json".as_slice(),
        ] {
            let path = fixture_path();
            fs::write(&path, content).unwrap();
            assert!(consume_install_intent(&path, "1.0.0").is_err());
            assert!(!path.exists());
        }
    }

    #[test]
    fn invalid_versions_and_idempotent_removal_fail_closed() {
        let path = fixture_path();
        assert!(write_install_intent(&path, "../bad").is_err());
        assert!(consume_install_intent(&path, "bad/version").is_err());
        remove_install_intent(&path).unwrap();
        remove_install_intent(&path).unwrap();
    }
}
