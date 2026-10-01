//! The library's ignore rules for Library settings (ipc-m1 §22): `.folio/ignore`, which every
//! scan reads after Folio's defaults (library scan §5).
//!
//! Saving does not scan by itself. The watcher sees `.folio/ignore` change, as it sees any edit
//! of the file, and asks for a full scan, which runs as a `scan` job: one path for Folio's own
//! saves and for edits made elsewhere, so a save never scans twice. A rebuild does not drop that
//! scan, which runs after it with the new rules.

use std::path::Path;

use folio_core::library::{invalid_ignore_lines, state};
use folio_core::meta::Layout;

use super::{LibraryState, errors};
use crate::error::AppError;
use crate::ipc::settings::{IgnoreRules, SetIgnoreRules};
use crate::ipc::types::LIMITS;
use crate::jobs::count;

/// Invalid lines listed at most.
const INVALID_LINES: usize = 100;

impl LibraryState {
    pub fn ignore_rules(&self) -> Result<IgnoreRules, AppError> {
        let text = self.with_reads(|session| read(session.root()))?;
        Ok(rules(text))
    }

    /// Saves the rules unless the file already holds them. Like a read, the write holds the
    /// library transition and never waits for the worker, and `saved` runs inside it: its event
    /// reaches the UI before the `LibraryStateChanged` of any later switch. The library's
    /// read-only state does not apply: `.folio/ignore` has no format version (ADR-0002 §3).
    pub fn set_ignore_rules(
        &self,
        request: SetIgnoreRules,
        saved: impl FnOnce(&IgnoreRules),
    ) -> Result<IgnoreRules, AppError> {
        let rules = rules(stored_text(&request.text)?);
        self.with_reads(|session| {
            if read(session.root())? != rules.text {
                Layout::new(session.root())
                    .write_ignore(&rules.text)
                    .map_err(errors::meta)?;
                saved(&rules);
            }
            Ok(())
        })?;
        Ok(rules)
    }
}

/// The text as `.folio/ignore` keeps it: LF line breaks, and one final line break in place of
/// any trailing ones. Those hold no rule, so the limit counts the text without them, and the
/// shell's own text always saves again. Scans convert each rule to NFC themselves.
fn stored_text(typed: &str) -> Result<String, AppError> {
    let rules = typed.trim_end_matches(['\r', '\n']);
    if rules.chars().count() > LIMITS.ignore_rules_chars as usize {
        return Err(AppError::InvalidArgument(
            "ignore rules over LIMITS.ignoreRulesChars".to_owned(),
        ));
    }
    let mut text = rules.replace("\r\n", "\n");
    if !text.is_empty() {
        text.push('\n');
    }
    Ok(text)
}

/// The text of `.folio/ignore`, `""` without one. Metadata is privileged input: links in
/// `.folio/` are refused before it is read or written.
fn read(root: &Path) -> Result<String, AppError> {
    state::validate_metadata(root).map_err(errors::meta)?;
    Ok(Layout::new(root)
        .read_ignore()
        .map_err(errors::meta)?
        .unwrap_or_default())
}

/// The rules as Library settings shows them. Builds a matcher: call it outside the transition.
fn rules(text: String) -> IgnoreRules {
    IgnoreRules {
        invalid_lines: invalid_ignore_lines(&text)
            .into_iter()
            .take(INVALID_LINES)
            .map(|line| count(line as u64))
            .collect(),
        text,
    }
}

#[cfg(test)]
mod tests;
