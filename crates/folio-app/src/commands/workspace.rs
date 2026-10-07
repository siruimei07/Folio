//! Workspace commands (ipc-m2.md §6, §7, §9). The four of §6 answer from the library session's
//! workspace tracker (`library::workspace`); `commit`, `start_history` and `get_workspace_diff`
//! are still test-only stubs.

mod read;

use tauri::State;

use crate::error::AppError;
use crate::ipc::types::Page;
use crate::ipc::workspace::{
    ListMetadataChanges, ListWorkspaceItems, MetadataChange, SelectionSummary, SummarizeSelection,
    WorkspaceItem, WorkspaceSummary,
};
use crate::library::LibraryState;

// The Changes view's totals (§6.1). Plain comments: doc comments would change the bindings.
#[tauri::command]
#[specta::specta]
pub async fn get_workspace(state: State<'_, LibraryState>) -> Result<WorkspaceSummary, AppError> {
    super::blocking(state, "get workspace", |state| read::summary(&state)).await
}

// One page of the items (§6.2).
#[tauri::command]
#[specta::specta]
pub async fn list_workspace_items(
    state: State<'_, LibraryState>,
    request: ListWorkspaceItems,
) -> Result<Page<WorkspaceItem>, AppError> {
    super::blocking(state, "list workspace items", move |state| {
        read::items(&state, request)
    })
    .await
}

// One page of the tag and settings changes (§6.3).
#[tauri::command]
#[specta::specta]
pub async fn list_metadata_changes(
    state: State<'_, LibraryState>,
    request: ListMetadataChanges,
) -> Result<Page<MetadataChange>, AppError> {
    super::blocking(state, "list metadata changes", move |state| {
        read::metadata(&state, request)
    })
    .await
}

// What a selection commits, per place (§6.4).
#[tauri::command]
#[specta::specta]
pub async fn summarize_selection(
    state: State<'_, LibraryState>,
    request: SummarizeSelection,
) -> Result<SelectionSummary, AppError> {
    super::blocking(state, "summarize selection", move |state| {
        read::summarize(&state, request)
    })
    .await
}

// Stubs exist only for bindings; implementing a command removes its stub from this module.
#[cfg(test)]
pub(crate) use planned::*;

#[cfg(test)]
mod planned {
    use crate::commands::planned;
    use crate::error::AppError;
    use crate::ipc::diff::{Diff, GetWorkspaceDiff};
    use crate::ipc::workspace::{CommitChanges, StartHistory};

    /// Starts a commit job (kind `commit`); returns its id.
    #[tauri::command]
    #[specta::specta]
    pub fn commit(request: CommitChanges) -> Result<String, AppError> {
        planned("commit", request)
    }

    /// Starts the first commit (job kind `firstCommit`); returns its id.
    #[tauri::command]
    #[specta::specta]
    pub fn start_history(request: StartHistory) -> Result<String, AppError> {
        planned("start_history", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn get_workspace_diff(request: GetWorkspaceDiff) -> Result<Diff, AppError> {
        planned("get_workspace_diff", request)
    }
}

#[cfg(test)]
mod tests;
