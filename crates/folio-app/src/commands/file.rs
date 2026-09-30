//! File opening commands (ipc-m1.md §11).

use tauri::State;

use crate::error::AppError;
use crate::ipc::entries::{OpenEntry, Opened, RevealEntry};
use crate::library::LibraryState;
use crate::open::{self, PinnedEntry};

#[tauri::command]
#[specta::specta]
pub async fn open_entry(
    state: State<'_, LibraryState>,
    request: OpenEntry,
) -> Result<Opened, AppError> {
    super::blocking(state, "open entry", move |state| {
        // The check and the pin hold the catalog writer; the launch runs after, holding nothing.
        open::open(&state.with_entry(&request.entry, PinnedEntry::resolve)?)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn reveal_entry(
    state: State<'_, LibraryState>,
    request: RevealEntry,
) -> Result<(), AppError> {
    super::blocking(state, "reveal entry", move |state| {
        open::reveal(&state.with_entry(&request.entry, PinnedEntry::resolve)?)
    })
    .await
}
