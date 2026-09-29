//! File opening commands (ipc-m1.md §11).

// Stubs exist only for bindings; implementing a command removes its stub from this module.
#[cfg(test)]
pub(crate) use planned::*;

#[cfg(test)]
mod planned {
    use crate::commands::planned;
    use crate::error::AppError;
    use crate::ipc::entries::{OpenEntry, Opened, RevealEntry};

    #[tauri::command]
    #[specta::specta]
    pub fn open_entry(request: OpenEntry) -> Result<Opened, AppError> {
        planned("open_entry", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn reveal_entry(request: RevealEntry) -> Result<(), AppError> {
        planned("reveal_entry", request)
    }
}
