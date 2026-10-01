//! Log commands (ipc-m1.md §16.4).

use std::sync::Arc;

use tauri::State;

use crate::diagnostics::Logger;
use crate::error::AppError;
use crate::ipc::log::LogUiError;

/// Writes one UI error to the shell's log.
#[tauri::command]
#[specta::specta]
pub async fn log_ui_error(
    state: State<'_, Arc<Logger>>,
    request: LogUiError,
) -> Result<(), AppError> {
    state.ui_error(request).await
}
