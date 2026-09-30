//! Errors the UI writes to the shell's log (docs/specs/ipc-m1.md §16.4).

use serde::{Deserialize, Serialize};
use specta::Type;

/// One error the UI caught or failed to catch. Error text only: never file content, search text
/// or other data the user typed.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct LogUiError {
    pub kind: UiErrorKind,
    /// Where the UI met it: a view, dialog or command, such as `preview` or
    /// `windowControls.minimize`. 1 to 64 ASCII letters, digits, `.`, `-` and `_`.
    pub source: String,
    /// At most `LIMITS.logChars` characters, cut at a character boundary: a lone surrogate
    /// fails the whole call.
    pub message: String,
    /// The error's stack, and React's component stack when there is one; limited as `message`.
    pub stack: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum UiErrorKind {
    /// Nothing caught it: React's `onUncaughtError`, `window` `error` or `unhandledrejection`.
    Uncaught,
    /// An error boundary caught it and shows "Reload this view" (React's `onCaughtError`).
    Boundary,
    /// A command or event subscription failed, and the UI shows the failure itself.
    Command,
}
