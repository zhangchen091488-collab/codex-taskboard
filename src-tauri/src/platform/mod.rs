use std::path::PathBuf;

pub struct AppDirectories {
    pub data: PathBuf,
    pub logs: PathBuf,
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "macos")]
pub use macos::{app_directories, configure_app};
#[cfg(target_os = "windows")]
pub use windows::{app_directories, configure_app};
