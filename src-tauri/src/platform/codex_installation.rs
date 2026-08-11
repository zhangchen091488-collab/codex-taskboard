use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    fmt, fs, io,
    path::{Path, PathBuf},
};

pub const CODEX_APP_OVERRIDE_ENV: &str = "CODEX_TASKBOARD_CODEX_APP";
pub const CODEX_STORE_PRODUCT_ID: &str = "9PLM9XGG6VKS";
pub const CODEX_PACKAGE_NAME: &str = "OpenAI.Codex";
pub const CODEX_PACKAGE_PUBLISHER: &str = "CN=50BDFD77-8903-4850-9FFE-6E8522F64D5B";
pub const CODEX_PACKAGE_APPLICATION_ID: &str = "App";
pub const CODEX_PACKAGE_EXECUTABLE: &str = "app/ChatGPT.exe";

const SELECTION_RECORD_VERSION: u32 = 1;
const SELECTION_RECORD_FILE: &str = "windows-codex-installation.json";

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CodexInstallationSource {
    ExplicitOverride,
    StoredSelection,
    SystemPackage,
    UserSelection,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexInstallation {
    pub executable_path: PathBuf,
    pub source: CodexInstallationSource,
    pub package_full_name: Option<String>,
    pub application_user_model_id: Option<String>,
}

impl CodexInstallation {
    fn executable(path: PathBuf, source: CodexInstallationSource) -> Self {
        Self {
            executable_path: path,
            source,
            package_full_name: None,
            application_user_model_id: None,
        }
    }

    fn system_package(candidate: SystemPackageCandidate) -> Self {
        Self {
            executable_path: candidate.executable_path,
            source: CodexInstallationSource::SystemPackage,
            package_full_name: Some(candidate.package_full_name),
            application_user_model_id: Some(candidate.application_user_model_id),
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SystemPackageCandidate {
    pub package_full_name: String,
    pub executable_path: PathBuf,
    pub application_user_model_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum AutomaticDiscovery {
    Found(CodexInstallation),
    SelectionRequired { diagnostics: Vec<String> },
}

#[derive(Debug, PartialEq, Eq)]
pub enum CodexDiscoveryError {
    InvalidExplicitOverride { path: PathBuf, reason: String },
    InvalidUserSelection { path: PathBuf, reason: String },
    SelectionCancelled { diagnostics: Vec<String> },
    Persistence(String),
}

impl fmt::Display for CodexDiscoveryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidExplicitOverride { path, reason } => write!(
                formatter,
                "{CODEX_APP_OVERRIDE_ENV} 指向的 Windows App 无效（{}）：{reason}。请修正或移除该环境变量后重试。",
                path.display()
            ),
            Self::InvalidUserSelection { path, reason } => write!(
                formatter,
                "所选 Windows App 无效（{}）：{reason}。请从托盘重新启动并选择 ChatGPT.exe。",
                path.display()
            ),
            Self::SelectionCancelled { diagnostics } => {
                write!(
                    formatter,
                    "未找到可用的 ChatGPT Windows App。请先从 Microsoft Store 安装产品 {CODEX_STORE_PRODUCT_ID}，或重新启动后手动选择 ChatGPT.exe。"
                )?;
                if !diagnostics.is_empty() {
                    write!(formatter, " 发现详情：{}", diagnostics.join("；"))?;
                }
                Ok(())
            }
            Self::Persistence(message) => write!(formatter, "无法保存 Windows App 选择：{message}"),
        }
    }
}

impl std::error::Error for CodexDiscoveryError {}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSelection {
    version: u32,
    executable_path: PathBuf,
}

pub fn selection_record_path(data_directory: &Path) -> PathBuf {
    data_directory.join(SELECTION_RECORD_FILE)
}

pub fn load_stored_selection(data_directory: &Path) -> Result<Option<PathBuf>, String> {
    let path = selection_record_path(data_directory);
    let contents = match fs::read(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("无法读取 {}：{error}", path.display())),
    };
    let selection: StoredSelection = serde_json::from_slice(&contents)
        .map_err(|error| format!("{} 格式无效：{error}", path.display()))?;
    if selection.version != SELECTION_RECORD_VERSION {
        return Err(format!(
            "{} 使用不支持的记录版本 {}",
            path.display(),
            selection.version
        ));
    }
    Ok(Some(selection.executable_path))
}

pub fn save_stored_selection(
    data_directory: &Path,
    installation: &CodexInstallation,
) -> Result<(), CodexDiscoveryError> {
    if installation.source != CodexInstallationSource::UserSelection {
        return Ok(());
    }
    fs::create_dir_all(data_directory)
        .map_err(|error| CodexDiscoveryError::Persistence(error.to_string()))?;
    let record = StoredSelection {
        version: SELECTION_RECORD_VERSION,
        executable_path: installation.executable_path.clone(),
    };
    let contents = serde_json::to_vec_pretty(&record)
        .map_err(|error| CodexDiscoveryError::Persistence(error.to_string()))?;
    let path = selection_record_path(data_directory);
    fs::write(&path, contents)
        .map_err(|error| CodexDiscoveryError::Persistence(format!("{}：{error}", path.display())))
}

fn executable_probe(path: &Path) -> Result<PathBuf, String> {
    if !path
        .extension()
        .is_some_and(|extension| extension.eq_ignore_ascii_case("exe"))
    {
        return Err("文件扩展名必须为 .exe".into());
    }
    let metadata = fs::metadata(path).map_err(|error| match error.kind() {
        io::ErrorKind::NotFound => "文件不存在或已被移动".into(),
        io::ErrorKind::PermissionDenied => "没有读取该文件的权限".into(),
        _ => error.to_string(),
    })?;
    if !metadata.is_file() {
        return Err("所选路径不是普通文件".into());
    }
    path.canonicalize().map_err(|error| error.to_string())
}

fn package_version(package_full_name: &str) -> Option<[u32; 4]> {
    package_full_name.split('_').find_map(|component| {
        let values = component
            .split('.')
            .map(str::parse::<u32>)
            .collect::<Result<Vec<_>, _>>()
            .ok()?;
        (values.len() == 4).then(|| [values[0], values[1], values[2], values[3]])
    })
}

fn preferred_system_package(
    candidates: impl IntoIterator<Item = SystemPackageCandidate>,
) -> Option<SystemPackageCandidate> {
    let mut seen = HashSet::new();
    let mut candidates = candidates
        .into_iter()
        .filter(|candidate| {
            seen.insert(
                candidate
                    .executable_path
                    .to_string_lossy()
                    .to_ascii_lowercase(),
            )
        })
        .collect::<Vec<_>>();
    candidates.sort_by(|left, right| {
        package_version(&left.package_full_name)
            .cmp(&package_version(&right.package_full_name))
            .then_with(|| left.package_full_name.cmp(&right.package_full_name))
    });
    candidates.pop()
}

pub fn discover_automatic(
    explicit_override: Option<PathBuf>,
    stored_selection: Option<PathBuf>,
    system_candidates: Vec<SystemPackageCandidate>,
    diagnostics: Vec<String>,
) -> Result<AutomaticDiscovery, CodexDiscoveryError> {
    discover_automatic_with_probe(
        explicit_override,
        stored_selection,
        system_candidates,
        diagnostics,
        executable_probe,
    )
}

fn discover_automatic_with_probe<F>(
    explicit_override: Option<PathBuf>,
    stored_selection: Option<PathBuf>,
    system_candidates: Vec<SystemPackageCandidate>,
    mut diagnostics: Vec<String>,
    probe: F,
) -> Result<AutomaticDiscovery, CodexDiscoveryError>
where
    F: Fn(&Path) -> Result<PathBuf, String>,
{
    if let Some(path) = explicit_override {
        return probe(&path)
            .map(|path| {
                AutomaticDiscovery::Found(CodexInstallation::executable(
                    path,
                    CodexInstallationSource::ExplicitOverride,
                ))
            })
            .map_err(|reason| CodexDiscoveryError::InvalidExplicitOverride { path, reason });
    }

    if let Some(path) = stored_selection {
        match probe(&path) {
            Ok(path) => {
                return Ok(AutomaticDiscovery::Found(CodexInstallation::executable(
                    path,
                    CodexInstallationSource::StoredSelection,
                )))
            }
            Err(reason) => diagnostics.push(format!(
                "已保存的位置 {} 不再可用：{reason}",
                path.display()
            )),
        }
    }

    if let Some(candidate) = preferred_system_package(system_candidates) {
        return Ok(AutomaticDiscovery::Found(
            CodexInstallation::system_package(candidate),
        ));
    }

    Ok(AutomaticDiscovery::SelectionRequired { diagnostics })
}

pub fn validate_user_selection(path: PathBuf) -> Result<CodexInstallation, CodexDiscoveryError> {
    executable_probe(&path)
        .map(|path| CodexInstallation::executable(path, CodexInstallationSource::UserSelection))
        .map_err(|reason| CodexDiscoveryError::InvalidUserSelection { path, reason })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use uuid::Uuid;

    fn candidate(version: &str, path: &str) -> SystemPackageCandidate {
        SystemPackageCandidate {
            package_full_name: format!("OpenAI.Codex_{version}_x64__publisher"),
            executable_path: PathBuf::from(path),
            application_user_model_id: "OpenAI.Codex_publisher!App".into(),
        }
    }

    fn temp_directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!("codex-installation-{}", Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn explicit_override_is_authoritative_and_records_its_source() {
        let result = discover_automatic_with_probe(
            Some(PathBuf::from(r"D:\Portable ChatGPT\ChatGPT.exe")),
            Some(PathBuf::from(r"C:\Stored\ChatGPT.exe")),
            vec![candidate("26.2.0.0", r"C:\Store\ChatGPT.exe")],
            vec![],
            |path| Ok(path.to_path_buf()),
        )
        .unwrap();

        let AutomaticDiscovery::Found(result) = result else {
            panic!("expected a discovered installation");
        };
        assert_eq!(result.source, CodexInstallationSource::ExplicitOverride);
        assert_eq!(
            result.executable_path,
            PathBuf::from(r"D:\Portable ChatGPT\ChatGPT.exe")
        );
    }

    #[test]
    fn invalid_explicit_override_does_not_silently_fall_back() {
        let error = discover_automatic_with_probe(
            Some(PathBuf::from(r"D:\Moved\ChatGPT.exe")),
            None,
            vec![candidate("26.2.0.0", r"C:\Store\ChatGPT.exe")],
            vec![],
            |_| Err("文件不存在或已被移动".into()),
        )
        .unwrap_err();

        assert!(matches!(
            error,
            CodexDiscoveryError::InvalidExplicitOverride { .. }
        ));
        assert!(error.to_string().contains(CODEX_APP_OVERRIDE_ENV));
    }

    #[test]
    fn stored_selection_precedes_system_metadata() {
        let result = discover_automatic_with_probe(
            None,
            Some(PathBuf::from(r"D:\Chosen\ChatGPT.exe")),
            vec![candidate("26.2.0.0", r"C:\Store\ChatGPT.exe")],
            vec![],
            |path| Ok(path.to_path_buf()),
        )
        .unwrap();

        let AutomaticDiscovery::Found(result) = result else {
            panic!("expected a discovered installation");
        };
        assert_eq!(result.source, CodexInstallationSource::StoredSelection);
    }

    #[test]
    fn moved_stored_selection_falls_back_to_latest_system_version() {
        let result = discover_automatic_with_probe(
            None,
            Some(PathBuf::from(r"D:\Moved\ChatGPT.exe")),
            vec![
                candidate("26.99.0.0", r"C:\Store\Old\ChatGPT.exe"),
                candidate("26.100.0.0", r"C:\Store\New\ChatGPT.exe"),
                candidate("26.100.0.0", r"c:\store\new\CHATGPT.EXE"),
            ],
            vec![],
            |_| Err("文件不存在或已被移动".into()),
        )
        .unwrap();

        let AutomaticDiscovery::Found(result) = result else {
            panic!("expected a discovered installation");
        };
        assert_eq!(result.source, CodexInstallationSource::SystemPackage);
        assert_eq!(
            result.package_full_name.as_deref(),
            Some("OpenAI.Codex_26.100.0.0_x64__publisher")
        );
    }

    #[test]
    fn missing_installation_requests_a_recoverable_selection() {
        let result = discover_automatic(None, None, vec![], vec!["未安装".into()]).unwrap();

        assert_eq!(
            result,
            AutomaticDiscovery::SelectionRequired {
                diagnostics: vec!["未安装".into()]
            }
        );
    }

    #[test]
    fn permission_failure_is_reported_before_requesting_a_new_selection() {
        let result = discover_automatic_with_probe(
            None,
            Some(PathBuf::from(r"D:\Protected\ChatGPT.exe")),
            vec![],
            vec![],
            |_| Err("没有读取该文件的权限".into()),
        )
        .unwrap();

        let AutomaticDiscovery::SelectionRequired { diagnostics } = result else {
            panic!("expected selection fallback");
        };
        assert!(diagnostics.join(" ").contains("权限"));
    }

    #[test]
    fn a_user_selected_moved_location_is_validated_and_persisted() {
        let directory = temp_directory();
        let executable = directory.join("移动位置 ChatGPT.exe");
        fs::write(&executable, b"test executable").unwrap();

        let installation = validate_user_selection(executable.canonicalize().unwrap()).unwrap();
        save_stored_selection(&directory, &installation).unwrap();

        assert_eq!(installation.source, CodexInstallationSource::UserSelection);
        assert_eq!(
            load_stored_selection(&directory).unwrap(),
            Some(executable.canonicalize().unwrap())
        );
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn malformed_selection_record_is_recoverable() {
        let directory = temp_directory();
        fs::write(selection_record_path(&directory), b"not-json").unwrap();

        let error = load_stored_selection(&directory).unwrap_err();

        assert!(error.contains("格式无效"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn only_manual_choices_are_persisted() {
        let directory = temp_directory();
        let automatic = CodexInstallation::executable(
            PathBuf::from(r"C:\Store\ChatGPT.exe"),
            CodexInstallationSource::SystemPackage,
        );

        save_stored_selection(&directory, &automatic).unwrap();

        assert!(!selection_record_path(&directory).exists());
        fs::remove_dir_all(directory).unwrap();
    }
}
