use std::path::PathBuf;

use tauri::{ActivationPolicy, Manager};

use super::AppDirectories;

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
    use super::select_app_directory;
    use std::{fs, path::PathBuf};
    use uuid::Uuid;

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
}
