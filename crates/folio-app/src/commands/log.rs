//! Log commands (ipc-m1.md §16.4).

// Stubs exist only for bindings; implementing a command removes its stub from this module.
#[cfg(test)]
pub(crate) use planned::*;

#[cfg(test)]
mod planned {
    use crate::commands::planned;
    use crate::error::AppError;
    use crate::ipc::log::LogUiError;

    /// Writes one UI error to the shell's log.
    #[tauri::command]
    #[specta::specta]
    pub fn log_ui_error(request: LogUiError) -> Result<(), AppError> {
        planned("log_ui_error", request)
    }
}
