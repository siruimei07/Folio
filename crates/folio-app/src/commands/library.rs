//! Library lifecycle commands (ipc-m1.md §6).

use tauri::{State, WebviewWindow};

use super::blocking;
use crate::dialogs;
use crate::error::AppError;
use crate::ipc::library::{CreateLibrary, FolderChoice, LibraryOpened, LibraryStatus, OpenLibrary};
use crate::library::LibraryState;

#[tauri::command]
#[specta::specta]
pub async fn library_status(state: State<'_, LibraryState>) -> Result<LibraryStatus, AppError> {
    blocking(state, "library status", |state| state.retry_status()).await
}

/// Opens the folder dialog; `null` when the user cancels.
#[tauri::command]
#[specta::specta]
pub async fn pick_library_folder(
    window: WebviewWindow,
    state: State<'_, LibraryState>,
) -> Result<Option<FolderChoice>, AppError> {
    let owner = window
        .hwnd()
        .map_err(|error| AppError::Internal(format!("get folder dialog owner: {error}")))?
        .0 as isize;
    blocking(state, "folder dialog", move |state| {
        dialogs::pick_folder(Some(owner))?
            .map(|path| state.choose(path))
            .transpose()
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn create_library(
    state: State<'_, LibraryState>,
    request: CreateLibrary,
) -> Result<LibraryOpened, AppError> {
    blocking(state, "create library", |state| state.create(request)).await
}

#[tauri::command]
#[specta::specta]
pub async fn open_library(
    state: State<'_, LibraryState>,
    request: OpenLibrary,
) -> Result<LibraryOpened, AppError> {
    blocking(state, "open library", |state| state.open(request)).await
}
