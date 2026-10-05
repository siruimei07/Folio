//! AI commands (ipc-m2.md §12).

// Stubs exist only for bindings; implementing a command removes its stub from this module.
#[cfg(test)]
pub(crate) use planned::*;

#[cfg(test)]
mod planned {
    use crate::commands::planned;
    use crate::error::AppError;
    use crate::ipc::ai::{
        AiSettings, CancelAiRequest, CommitMessage, GenerateCommitMessage, SetAiKey,
        UpdateAiSettings,
    };

    #[tauri::command]
    #[specta::specta]
    pub fn get_ai_settings() -> Result<AiSettings, AppError> {
        planned("get_ai_settings", ())
    }

    #[tauri::command]
    #[specta::specta]
    pub fn update_ai_settings(request: UpdateAiSettings) -> Result<AiSettings, AppError> {
        planned("update_ai_settings", request)
    }

    /// Stores the key; `null` when the user declined the confirmation for another service.
    #[tauri::command]
    #[specta::specta]
    pub fn set_ai_key(request: SetAiKey) -> Result<Option<AiSettings>, AppError> {
        planned("set_ai_key", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn clear_ai_key() -> Result<AiSettings, AppError> {
        planned("clear_ai_key", ())
    }

    /// Sends a minimal request with the stored key.
    #[tauri::command]
    #[specta::specta]
    pub fn test_ai() -> Result<(), AppError> {
        planned("test_ai", ())
    }

    /// A message for the selection; `null` when the request was stopped.
    #[tauri::command]
    #[specta::specta]
    pub fn generate_commit_message(
        request: GenerateCommitMessage,
    ) -> Result<Option<CommitMessage>, AppError> {
        planned("generate_commit_message", request)
    }

    #[tauri::command]
    #[specta::specta]
    pub fn cancel_ai_request(request: CancelAiRequest) -> Result<(), AppError> {
        planned("cancel_ai_request", request)
    }
}
