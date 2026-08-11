use std::{
    env::{join_paths, split_paths, JoinPathsError},
    ffi::{OsStr, OsString},
    path::{Path, PathBuf},
};

pub mod process_tree;

pub struct AppDirectories {
    pub data: PathBuf,
    pub logs: PathBuf,
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
pub use windows::{app_directories, configure_app, WindowsProcessTree as NativeProcessTree};

#[cfg(test)]
mod tests {
    use super::launcher_path;
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
}
