use serde::Serialize;
use specta::Type;

/// The error every command returns (CLAUDE.md §5, "No silent failures").
///
/// Serialised as `{ code, detail }`. The UI maps `code` to a message under `errors` in
/// `apps/desktop/src/i18n/locales/zh-CN.json`; `tsc` fails if a code has no message.
/// `detail` is for logs and bug reports, never shown to users on its own.
#[derive(Debug, Clone, thiserror::Error, Serialize, Type)]
#[serde(tag = "code", content = "detail")]
pub enum AppError {
    /// The data directory could not be determined or is invalid.
    #[error("data directory unavailable: {0}")]
    DataDirUnavailable(String),
}
