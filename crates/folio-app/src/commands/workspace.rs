//! Workspace commands (ipc-m2.md §6, §7, §9).

// Stubs exist only for bindings; implementing a command removes its stub from this module.
#[cfg(test)]
pub(crate) use planned::*;

#[cfg(test)]
mod planned {
    use crate::commands::planned;
    use crate::error::AppError;
    use crate::ipc::diff::{Diff, GetWorkspaceDiff};
    use crate::ipc::types::Page;
    use crate::ipc::workspace::{
        CommitChanges, ListMetadataChanges, ListWorkspaceItems, MetadataChange, SelectionSummary,
        StartHistory, SummarizeSelection, WorkspaceItem, WorkspaceSummary,
    };

    #[tauri::command]
    #[specta::specta]
    pub fn get_workspace() -> Result<WorkspaceSummary, AppError> {
        planned("get_workspace", ())
    }

    #[tauri::command]
    #[specta::specta]
    pub fn list_workspace_items(
        request: ListWorkspaceItems,
    ) -> Result<Page<WorkspaceItem>, AppError> {
        planned("list_workspace_items", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn list_metadata_changes(
        request: ListMetadataChanges,
    ) -> Result<Page<MetadataChange>, AppError> {
        planned("list_metadata_changes", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn summarize_selection(request: SummarizeSelection) -> Result<SelectionSummary, AppError> {
        planned("summarize_selection", request)
    }

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
