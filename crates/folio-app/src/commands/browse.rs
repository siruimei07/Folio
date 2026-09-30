//! Browse and search commands (ipc-m1.md §9.1 and §10).

// Stubs exist only for bindings; implementing a command removes its stub from this module.
#[cfg(test)]
pub(crate) use planned::*;

#[cfg(test)]
mod planned {
    use crate::commands::planned;
    use crate::error::AppError;
    use crate::ipc::entries::{GetEntry, ListChildren, ListFiles, ResolvePaths};
    use crate::ipc::search::{Search, SearchPage};
    use crate::ipc::types::{EntryRow, Page};

    #[tauri::command]
    #[specta::specta]
    pub fn list_children(request: ListChildren) -> Result<Page<EntryRow>, AppError> {
        planned("list_children", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn list_files(request: ListFiles) -> Result<Page<EntryRow>, AppError> {
        planned("list_files", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn get_entry(request: GetEntry) -> Result<EntryRow, AppError> {
        planned("get_entry", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn search(request: Search) -> Result<SearchPage, AppError> {
        planned("search", request)
    }

    /// The file each path names, or `null`, in the order of `paths`.
    #[tauri::command]
    #[specta::specta]
    pub fn resolve_paths(request: ResolvePaths) -> Result<Vec<Option<EntryRow>>, AppError> {
        planned("resolve_paths", request)
    }
}
