use serde::Serialize;
use specta::Type;
use tauri::{AppHandle, State, WebviewWindow};

use crate::error::AppError;
use crate::paths::DataDir;
use crate::window_chrome::{self, ButtonBounds};

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

/// Tells the shell where the title bar's maximize button is, so the snap layouts overlay covers
/// it. Synchronous on purpose: Tauri runs synchronous commands on the UI thread, which owns the
/// windows.
#[tauri::command]
#[specta::specta]
pub fn set_maximize_button_bounds(
    window: WebviewWindow,
    bounds: Option<ButtonBounds>,
) -> Result<(), AppError> {
    window_chrome::set_maximize_button_bounds(&window, bounds)
}
