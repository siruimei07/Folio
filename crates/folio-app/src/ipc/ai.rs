//! AI commit messages: the settings, the write-only key, a test and generating a message
//! (docs/specs/ipc-m2.md §12, versioning.md §12).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::workspace::Selection;

/// The endpoint AI uses until the user changes it; the UI names it "DeepSeek". Moves into
/// `folio_core::ai` with `feat/core-ai-message`.
pub const DEFAULT_AI_ENDPOINT: &str = "https://api.deepseek.com";

/// App settings → AI. The key itself is never sent to the UI: only whether one is stored.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AiSettings {
    pub enabled: bool,
    /// An OpenAI-compatible service: requests go to `<endpoint>/chat/completions`.
    pub endpoint: String,
    pub model: String,
    /// Send the changed lines of text and Word files, not only the list of changes.
    pub send_content: bool,
    /// A key is stored for this endpoint's origin. AI is on when `enabled` and `hasKey`.
    pub has_key: bool,
}

/// Changes the AI settings: each field that is not `null` replaces the stored value. An
/// endpoint on another origin deletes the key in the same update.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAiSettings {
    pub enabled: Option<bool>,
    /// Trimmed, then at most `LIMITS.endpointChars` characters: `https`, a host, an optional
    /// port and path, no user name, query or fragment. Otherwise `AiEndpointInvalid`.
    pub endpoint: Option<String>,
    /// Trimmed, then 1 to `LIMITS.modelChars` visible ASCII characters. Otherwise
    /// `AiModelInvalid`.
    pub model: Option<String>,
    pub send_content: Option<bool>,
}

/// Stores the key for the current endpoint's origin. For an origin other than DeepSeek's, the
/// shell first asks the user in a Windows dialog; `null` answers a declined dialog.
#[derive(Clone, PartialEq, Eq, Deserialize, Type)]
pub struct SetAiKey {
    /// Trimmed, then 1 to `LIMITS.aiKeyChars` visible ASCII characters. Otherwise
    /// `AiKeyInvalid`. Never sent back, logged or shown.
    pub key: String,
}

/// Never prints the key, so a request formatted into a log or a panic message carries none of it.
impl std::fmt::Debug for SetAiKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("SetAiKey")
            .field("key", &"<redacted>")
            .finish()
    }
}

/// Asks the AI service for a commit message for a selection (versioning.md §12.3).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct GenerateCommitMessage {
    /// Chosen by the UI, to stop the request with `cancel_ai_request`: 1 to
    /// `LIMITS.requestIdChars` ASCII letters, digits, `-` and `_`.
    pub request_id: String,
    pub selection: Selection,
    /// `WorkspaceSummary.fingerprint`; a different one is `WorkspaceChanged`.
    pub fingerprint: String,
    /// What the user typed in the description, at most `LIMITS.descriptionChars` characters;
    /// `""` when none.
    pub description: String,
}

/// A message the commit box can use as it is: it already meets the rules of a commit message.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct CommitMessage {
    pub summary: String,
    pub body: Option<String>,
}

/// Stops a running `generate_commit_message`, which then answers `null`. An id that is not
/// running changes nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct CancelAiRequest {
    pub request_id: String,
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_key_request_never_prints_its_key() {
        let request = super::SetAiKey {
            key: "sk-secret".to_owned(),
        };
        assert!(!format!("{request:?}").contains("sk-secret"));
    }
}
