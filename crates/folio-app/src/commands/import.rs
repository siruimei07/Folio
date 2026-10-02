//! Import commands (ipc-m1.md §12).

use tauri::{State, WebviewWindow};

use super::blocking;
use crate::dialogs;
use crate::error::AppError;
use crate::ipc::import::{CheckImport, ImportCheck, ImportFiles, ImportSource};
use crate::library::LibraryState;

/// Opens the file dialog; `null` when the user cancels.
#[tauri::command]
#[specta::specta]
pub async fn pick_import_files(
    window: WebviewWindow,
    state: State<'_, LibraryState>,
) -> Result<Option<ImportSource>, AppError> {
    let owner = window
        .hwnd()
        .map_err(|error| AppError::Internal(format!("get import dialog owner: {error}")))?
        .0 as isize;
    blocking(state, "import dialog", move |state| {
        dialogs::pick_import_files(Some(owner))?
            .map(|paths| state.choose_import(paths))
            .transpose()
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn check_import(
    state: State<'_, LibraryState>,
    request: CheckImport,
) -> Result<ImportCheck, AppError> {
    blocking(state, "check import", |state| state.check_import(request)).await
}

/// Starts an import job; returns its id.
#[tauri::command]
#[specta::specta]
pub async fn import_files(
    state: State<'_, LibraryState>,
    request: ImportFiles,
) -> Result<String, AppError> {
    blocking(state, "queue import", |state| state.import_files(request)).await
}
