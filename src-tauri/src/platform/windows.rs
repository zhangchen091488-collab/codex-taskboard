use tauri::Manager;

use super::AppDirectories;

pub fn configure_app(_app: &mut tauri::App) {}

pub fn app_directories(app: &tauri::App) -> tauri::Result<AppDirectories> {
    Ok(AppDirectories {
        data: app.path().app_data_dir()?,
        logs: app.path().app_log_dir()?,
    })
}
