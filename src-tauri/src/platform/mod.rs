use std::{
    env::{join_paths, split_paths, JoinPathsError},
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

pub mod codex_installation;
pub mod process_tree;

pub struct AppDirectories {
    pub data: PathBuf,
    pub logs: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
pub struct CodexProfileDirectories {
    pub independent: PathBuf,
    pub source: PathBuf,
}

pub fn codex_profile_directories(
    taskboard_data_directory: &Path,
    roaming_data_directory: &Path,
) -> CodexProfileDirectories {
    CodexProfileDirectories {
        independent: taskboard_data_directory.join("codex-profile"),
        source: roaming_data_directory.join("Codex"),
    }
}

pub fn launcher_path(
    resource_directory: &Path,
    inherited_path: Option<&OsStr>,
) -> Result<OsString, JoinPathsError> {
    let mut directories = vec![resource_directory.join("bin")];
    if let Some(inherited_path) = inherited_path {
        directories.extend(split_paths(inherited_path).filter(|path| !path.as_os_str().is_empty()));
    }
    join_paths(directories)
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "macos")]
pub use macos::{
    app_directories, configure_app, configure_process_tree_command,
    MacProcessTree as NativeProcessTree,
};
#[cfg(target_os = "windows")]
pub use windows::{
    app_directories, configure_app, discover_codex_installation,
    WindowsProcessTree as NativeProcessTree,
};

#[cfg(test)]
mod tests {
    use super::{codex_profile_directories, launcher_path};
    use std::{env, path::PathBuf};

    #[test]
    fn launcher_path_prepends_only_the_controlled_resource_bin() {
        #[cfg(target_os = "windows")]
        let resource_directory = PathBuf::from(r"C:\Program Files\任务面板\resources");
        #[cfg(not(target_os = "windows"))]
        let resource_directory = PathBuf::from("/Applications/任务 面板.app/Contents/Resources");

        let system_bin = PathBuf::from("system bin");
        let user_bin = PathBuf::from("用户 tools");
        let inherited = env::join_paths([&system_bin, &PathBuf::new(), &user_bin])
            .expect("construct inherited PATH");

        let result =
            launcher_path(&resource_directory, Some(&inherited)).expect("construct launcher PATH");
        let directories = env::split_paths(&result).collect::<Vec<_>>();

        assert_eq!(
            directories,
            vec![resource_directory.join("bin"), system_bin, user_bin]
        );
    }

    #[test]
    fn launcher_path_is_valid_when_the_parent_has_no_path() {
        let resource_directory = PathBuf::from("resources with spaces");
        let result = launcher_path(&resource_directory, None).expect("construct launcher PATH");

        assert_eq!(
            env::split_paths(&result).collect::<Vec<_>>(),
            vec![resource_directory.join("bin")]
        );
    }

    #[test]
    fn codex_profiles_keep_the_official_source_separate_from_taskboard_data() {
        #[cfg(target_os = "windows")]
        let roaming_data = PathBuf::from(r"C:\Users\示例 User\AppData\Roaming");
        #[cfg(not(target_os = "windows"))]
        let roaming_data = PathBuf::from("/Users/示例 User/Library/Application Support");
        let taskboard_data = roaming_data.join("Codex Taskboard");

        let profiles = codex_profile_directories(&taskboard_data, &roaming_data);

        assert_eq!(profiles.source, roaming_data.join("Codex"));
        assert_eq!(profiles.independent, taskboard_data.join("codex-profile"));
        assert_ne!(profiles.source, profiles.independent);
    }
}
