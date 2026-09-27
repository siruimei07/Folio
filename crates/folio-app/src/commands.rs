use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, State};

use crate::error::AppError;
use crate::paths::DataDir;

/// Versions and the data directory, for the placeholder screen and for bug reports.
#[derive(Debug, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub app_version: String,
    pub core_version: String,
    pub data_dir: String,
}

#[tauri::command]
#[specta::specta]
pub fn app_info(app: AppHandle, data_dir: State<'_, DataDir>) -> Result<AppInfo, AppError> {
    Ok(AppInfo {
        app_version: app.package_info().version.to_string(),
        core_version: folio_core::VERSION.to_owned(),
        data_dir: data_dir.path()?.display().to_string(),
    })
}
