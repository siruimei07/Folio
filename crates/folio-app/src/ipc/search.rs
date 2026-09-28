//! Search (docs/specs/ipc-m1.md §10).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::types::{EntryRef, EntryRow, PageRequest};

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct Search {
    /// At most `LIMITS.queryChars` characters. Text without searchable words finds nothing.
    pub text: String,
    /// `null`: the whole library.
    pub scope: Option<EntryRef>,
    /// `offset + limit` at most `LIMITS.searchResults`.
    pub page: PageRequest,
}

/// A window into the best matches at one revision; windows of one revision never overlap.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct SearchPage {
    pub items: Vec<SearchHit>,
    pub offset: u32,
    /// More matches follow this page.
    pub more: bool,
    pub revision: u32,
}

/// A match with its highlights. Render spans as text, never as HTML.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct SearchHit {
    pub entry: EntryRow,
    /// The whole name, matches marked.
    pub name: Vec<Span>,
    /// Body text around a match, or `null` when the body did not match or there is none.
    pub snippet: Option<Vec<Span>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Span {
    pub text: String,
    pub matched: bool,
}
