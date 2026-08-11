#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "windows")]
mod windows;

#[cfg(target_os = "macos")]
pub use macos::configure_app;
#[cfg(target_os = "windows")]
pub use windows::configure_app;
