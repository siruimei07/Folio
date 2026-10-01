//! Browse and search commands (ipc-m1.md §9.1 and §10).
mod read;
use crate::error::AppError;
use crate::ipc::entries::{GetEntry, ListChildren, ListFiles, ResolvePaths};
use crate::ipc::search::{Search, SearchPage};
use crate::ipc::types::{EntryRow, Page};
use crate::library::LibraryState;
use read::{children, files, find, get, paths};
use tauri::State;

#[tauri::command]
#[specta::specta]
pub async fn list_children(
    state: State<'_, LibraryState>,
    request: ListChildren,
) -> Result<Page<EntryRow>, AppError> {
    super::blocking(state, "list children", move |state| {
        children(&state, request)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_files(
    state: State<'_, LibraryState>,
    request: ListFiles,
) -> Result<Page<EntryRow>, AppError> {
    super::blocking(state, "list files", move |state| files(&state, request)).await
}

#[tauri::command]
#[specta::specta]
pub async fn get_entry(
    state: State<'_, LibraryState>,
    request: GetEntry,
) -> Result<EntryRow, AppError> {
    super::blocking(state, "get entry", move |state| get(&state, request)).await
}

#[tauri::command]
#[specta::specta]
pub async fn search(
    state: State<'_, LibraryState>,
    request: Search,
) -> Result<SearchPage, AppError> {
    super::blocking(state, "search", move |state| find(&state, request)).await
}

/// The file each path names, or `null`, in the order of `paths`.
#[tauri::command]
#[specta::specta]
pub async fn resolve_paths(
    state: State<'_, LibraryState>,
    request: ResolvePaths,
) -> Result<Vec<Option<EntryRow>>, AppError> {
    super::blocking(state, "resolve paths", move |state| paths(&state, request)).await
}

#[cfg(test)]
mod tests;
