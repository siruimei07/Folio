//! History commands (ipc-m2.md §8–§10).

// Stubs exist only for bindings; implementing a command removes its stub from this module.
#[cfg(test)]
pub(crate) use planned::*;

#[cfg(test)]
mod planned {
    use crate::commands::planned;
    use crate::error::AppError;
    use crate::ipc::diff::{Diff, GetVersionDiff};
    use crate::ipc::history::{
        ChangeRow, CommitInfo, FileVersion, GetCommit, HistoryItem, ListCommitChanges,
        ListCommitMetadata, ListFileHistory, ListHistory, RestorePlan, Restored, RewordCommit,
        Uncommit, VersionRef,
    };
    use crate::ipc::types::{EntryRow, Page};
    use crate::ipc::workspace::MetadataChange;

    #[tauri::command]
    #[specta::specta]
    pub fn list_history(request: ListHistory) -> Result<Page<HistoryItem>, AppError> {
        planned("list_history", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn get_commit(request: GetCommit) -> Result<CommitInfo, AppError> {
        planned("get_commit", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn list_commit_changes(request: ListCommitChanges) -> Result<Page<ChangeRow>, AppError> {
        planned("list_commit_changes", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn list_commit_metadata(
        request: ListCommitMetadata,
    ) -> Result<Page<MetadataChange>, AppError> {
        planned("list_commit_metadata", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn list_file_history(request: ListFileHistory) -> Result<Page<FileVersion>, AppError> {
        planned("list_file_history", request)
    }

    /// The file a version belongs to now; `null` when it was deleted since.
    #[tauri::command]
    #[specta::specta]
    pub fn locate_version(request: VersionRef) -> Result<Option<EntryRow>, AppError> {
        planned("locate_version", request)
    }

    /// Writes the commit again with a new message; returns its new id.
    #[tauri::command]
    #[specta::specta]
    pub fn reword_commit(request: RewordCommit) -> Result<String, AppError> {
        planned("reword_commit", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn uncommit(request: Uncommit) -> Result<(), AppError> {
        planned("uncommit", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn get_version_diff(request: GetVersionDiff) -> Result<Diff, AppError> {
        planned("get_version_diff", request)
    }

    /// What `restore_version` would do now; reads only.
    #[tauri::command]
    #[specta::specta]
    pub fn plan_restore(request: VersionRef) -> Result<RestorePlan, AppError> {
        planned("plan_restore", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn restore_version(request: VersionRef) -> Result<Restored, AppError> {
        planned("restore_version", request)
    }
}
