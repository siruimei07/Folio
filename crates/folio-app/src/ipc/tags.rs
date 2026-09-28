//! Tag definitions and assignments (docs/specs/ipc-m1.md §8).
//!
//! A file's effective tags are its own and those of every folder above it inside its course;
//! filters and "untagged" use them (spec §8.2).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::types::EntryRef;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Tag {
    pub id: String,
    pub name: String,
    /// A key of the tag and course palette.
    pub color: String,
    /// Entries that carry the tag themselves.
    pub usage: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CreateTag {
    pub name: String,
    pub color: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct UpdateTag {
    pub id: String,
    pub name: String,
    pub color: String,
}

/// The new order: every tag id exactly once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ReorderTags {
    pub tags: Vec<String>,
}

/// Removes the definition and every assignment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct DeleteTag {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct TagDeleted {
    /// Assignments removed with the tag.
    pub assignments: u32,
}

/// Adds and removes tags on each entry. `add` and `remove` do not overlap, and every tag in
/// `add` is defined. Removing a tag an entry only gets from a folder changes nothing.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct SetEntryTags {
    pub entries: Vec<EntryRef>,
    pub add: Vec<String>,
    pub remove: Vec<String>,
}
