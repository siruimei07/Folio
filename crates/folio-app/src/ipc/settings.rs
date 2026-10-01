//! Settings (docs/specs/ipc-m1.md §22): this computer's App settings, kept in `settings.json` in
//! the data directory, and the library's ignore rules, kept in `.folio/ignore` and synced with it.

use serde::{Deserialize, Serialize};
use specta::Type;

/// App settings → General and Appearance.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct AppSettings {
    /// The name History shows next to changes made on this computer: the one the user saved,
    /// else the computer's name in Windows; `null` only when Windows gives none either.
    pub device_name: Option<String>,
    pub theme: Theme,
    pub reduce_motion: ReduceMotion,
}

/// The colour mode: `light` and `dark` set `data-theme` on the root, `system` follows Windows'
/// app mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum Theme {
    System,
    Light,
    Dark,
}

/// `on` and `off` set `data-reduce-motion` on the root, `system` follows Windows' animation
/// effects.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum ReduceMotion {
    System,
    On,
    Off,
}

/// Changes App settings: each field that is not `null` replaces the stored value, so the
/// device name's Save and the appearance controls each send only their own field.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct UpdateAppSettings {
    /// A name the user typed: trimmed and converted to NFC, then 1 to
    /// `LIMITS.displayNameChars` characters without control characters.
    pub device_name: Option<String>,
    pub theme: Option<Theme>,
    pub reduce_motion: Option<ReduceMotion>,
}

/// Library settings → Ignore rules: what the library leaves out, in gitignore syntax, on top of
/// Folio's defaults (`DEFAULT_IGNORE_RULES`, which apply first; a `!` line takes one back).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub struct IgnoreRules {
    /// The text of `.folio/ignore`; `""` when the library has none.
    pub text: String,
    /// Lines of `text` that are not valid patterns, counted from 1 (the first 100). Scans skip
    /// them and list them as problems; the other lines apply. Line 0: the rules cannot be built
    /// as a whole, and none applies, the defaults included.
    pub invalid_lines: Vec<u32>,
}

/// Replaces the ignore rules. A change starts a full scan, which adds and removes what the new
/// rules keep and leave out.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SetIgnoreRules {
    /// At most `LIMITS.ignoreRulesChars` characters, trailing line breaks not counted. Line
    /// breaks are written as LF, with one at the end.
    pub text: String,
}
