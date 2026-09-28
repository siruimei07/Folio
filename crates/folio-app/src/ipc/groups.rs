//! Semesters and courses: the first two folder levels of the library (docs/specs/ipc-m1.md §7).
//!
//! Renaming, moving and deleting one is `rename_entry`, `move_entries` and `delete_entries` on
//! its folder.

use serde::{Deserialize, Serialize};
use specta::Type;

use super::types::EntryRef;

/// A folder directly in the library: a semester or another group, such as "Personal".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Semester {
    pub folder: EntryRef,
    pub name: String,
    pub archived: bool,
}

/// A folder directly in a semester.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Course {
    pub folder: EntryRef,
    pub name: String,
    /// Badge text, 1–3 characters; `null`: the UI derives it from the name.
    pub abbr: Option<String>,
    /// A code the user typed, such as `MAT232`.
    pub code: Option<String>,
    /// A key of the tag and course palette; `null`: the UI's default.
    pub color: Option<String>,
    pub archived: bool,
    /// Files inside the course, at any depth.
    pub files: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CreateSemester {
    pub name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct UpdateSemester {
    pub semester: EntryRef,
    pub archived: bool,
}

/// The new order: every semester exactly once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ReorderSemesters {
    pub semesters: Vec<EntryRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ListCourses {
    /// `null`: the courses of every semester, by semester, for showing course codes in paths.
    pub semester: Option<EntryRef>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CreateCourse {
    pub semester: EntryRef,
    pub name: String,
    pub abbr: Option<String>,
    pub code: Option<String>,
    pub color: Option<String>,
}

/// Replaces all four fields: send what the dialog shows.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct UpdateCourse {
    pub course: EntryRef,
    pub abbr: Option<String>,
    pub code: Option<String>,
    pub color: Option<String>,
    pub archived: bool,
}

/// The new order: every course of the semester exactly once.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct ReorderCourses {
    pub semester: EntryRef,
    pub courses: Vec<EntryRef>,
}
