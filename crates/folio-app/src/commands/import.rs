//! Import commands (ipc-m1.md §12).

// Stubs exist only for bindings; implementing a command removes its stub from this module.
#[cfg(test)]
pub(crate) use planned::*;

#[cfg(test)]
mod planned {
    use crate::commands::planned;
    use crate::error::AppError;
    use crate::ipc::import::{CheckImport, ImportCheck, ImportFiles, ImportSource};

    /// Opens the file dialog; `null` when the user cancels.
    #[tauri::command]
    #[specta::specta]
    pub fn pick_import_files() -> Result<Option<ImportSource>, AppError> {
        planned("pick_import_files", ())
    }

    #[tauri::command]
    #[specta::specta]
    pub fn check_import(request: CheckImport) -> Result<ImportCheck, AppError> {
        planned("check_import", request)
    }

    /// Starts an import job; returns its id.
    #[tauri::command]
    #[specta::specta]
    pub fn import_files(request: ImportFiles) -> Result<String, AppError> {
        planned("import_files", request)
    }
}
