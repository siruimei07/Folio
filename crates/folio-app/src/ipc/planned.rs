//! Planned commands: declared with their final signatures so the bindings give the UI typed
//! functions, but never registered with Tauri (docs/specs/ipc-m1.md §3). This module compiles
//! in test builds only, for `export_bindings`.
//!
//! To implement a command, write its handler in `commands`, delete its stub here, and add it to
//! `ipc::implemented_commands!`, `build.rs` and the capability in the same change.

use super::entries::{
    CreateFolder, DeleteEntries, GetEntry, ListChildren, ListFiles, MoveEntries, OpenEntry, Opened,
    RenameEntry, RevealEntry,
};
use super::groups::{
    Course, CreateCourse, CreateSemester, ListCourses, ReorderCourses, ReorderSemesters, Semester,
    UpdateCourse, UpdateSemester,
};
use super::import::{CheckImport, ImportCheck, ImportFiles, ImportSource};
use super::jobs::{CancelJob, Job};
use super::library::{CreateLibrary, FolderChoice, LibraryOpened, LibraryStatus, OpenLibrary};
use super::problems::{ListProblems, ProblemItem};
use super::search::{Search, SearchPage};
use super::tags::{CreateTag, DeleteTag, ReorderTags, SetEntryTags, Tag, TagDeleted, UpdateTag};
use super::types::{BatchResult, EntryRow, Page};
use crate::error::AppError;

/// What a stub would answer. No call reaches one: Tauri's ACL rejects commands it was not given.
fn planned<T>(command: &str, _request: impl Sized) -> Result<T, AppError> {
    Err(AppError::Internal(format!(
        "`{command}` is declared for the bindings only"
    )))
}

// Library (spec §6)

#[tauri::command]
#[specta::specta]
pub fn library_status() -> Result<LibraryStatus, AppError> {
    planned("library_status", ())
}

/// Opens the folder dialog; `null` when the user cancels.
#[tauri::command]
#[specta::specta]
pub fn pick_library_folder() -> Result<Option<FolderChoice>, AppError> {
    planned("pick_library_folder", ())
}

#[tauri::command]
#[specta::specta]
pub fn create_library(request: CreateLibrary) -> Result<LibraryOpened, AppError> {
    planned("create_library", request)
}

#[tauri::command]
#[specta::specta]
pub fn open_library(request: OpenLibrary) -> Result<LibraryOpened, AppError> {
    planned("open_library", request)
}

// Semesters and courses (spec §7)

#[tauri::command]
#[specta::specta]
pub fn list_semesters() -> Result<Vec<Semester>, AppError> {
    planned("list_semesters", ())
}

#[tauri::command]
#[specta::specta]
pub fn create_semester(request: CreateSemester) -> Result<Semester, AppError> {
    planned("create_semester", request)
}

#[tauri::command]
#[specta::specta]
pub fn update_semester(request: UpdateSemester) -> Result<Semester, AppError> {
    planned("update_semester", request)
}

#[tauri::command]
#[specta::specta]
pub fn reorder_semesters(request: ReorderSemesters) -> Result<Vec<Semester>, AppError> {
    planned("reorder_semesters", request)
}

#[tauri::command]
#[specta::specta]
pub fn list_courses(request: ListCourses) -> Result<Vec<Course>, AppError> {
    planned("list_courses", request)
}

#[tauri::command]
#[specta::specta]
pub fn create_course(request: CreateCourse) -> Result<Course, AppError> {
    planned("create_course", request)
}

#[tauri::command]
#[specta::specta]
pub fn update_course(request: UpdateCourse) -> Result<Course, AppError> {
    planned("update_course", request)
}

#[tauri::command]
#[specta::specta]
pub fn reorder_courses(request: ReorderCourses) -> Result<Vec<Course>, AppError> {
    planned("reorder_courses", request)
}

// Tags (spec §8)

#[tauri::command]
#[specta::specta]
pub fn list_tags() -> Result<Vec<Tag>, AppError> {
    planned("list_tags", ())
}

#[tauri::command]
#[specta::specta]
pub fn create_tag(request: CreateTag) -> Result<Tag, AppError> {
    planned("create_tag", request)
}

#[tauri::command]
#[specta::specta]
pub fn update_tag(request: UpdateTag) -> Result<Tag, AppError> {
    planned("update_tag", request)
}

#[tauri::command]
#[specta::specta]
pub fn reorder_tags(request: ReorderTags) -> Result<Vec<Tag>, AppError> {
    planned("reorder_tags", request)
}

#[tauri::command]
#[specta::specta]
pub fn delete_tag(request: DeleteTag) -> Result<TagDeleted, AppError> {
    planned("delete_tag", request)
}

#[tauri::command]
#[specta::specta]
pub fn set_entry_tags(request: SetEntryTags) -> Result<BatchResult, AppError> {
    planned("set_entry_tags", request)
}

// Entries (spec §9)

#[tauri::command]
#[specta::specta]
pub fn list_children(request: ListChildren) -> Result<Page<EntryRow>, AppError> {
    planned("list_children", request)
}

#[tauri::command]
#[specta::specta]
pub fn list_files(request: ListFiles) -> Result<Page<EntryRow>, AppError> {
    planned("list_files", request)
}

#[tauri::command]
#[specta::specta]
pub fn get_entry(request: GetEntry) -> Result<EntryRow, AppError> {
    planned("get_entry", request)
}

#[tauri::command]
#[specta::specta]
pub fn create_folder(request: CreateFolder) -> Result<EntryRow, AppError> {
    planned("create_folder", request)
}

#[tauri::command]
#[specta::specta]
pub fn rename_entry(request: RenameEntry) -> Result<EntryRow, AppError> {
    planned("rename_entry", request)
}

#[tauri::command]
#[specta::specta]
pub fn move_entries(request: MoveEntries) -> Result<BatchResult, AppError> {
    planned("move_entries", request)
}

#[tauri::command]
#[specta::specta]
pub fn delete_entries(request: DeleteEntries) -> Result<BatchResult, AppError> {
    planned("delete_entries", request)
}

// Search (spec §10)

#[tauri::command]
#[specta::specta]
pub fn search(request: Search) -> Result<SearchPage, AppError> {
    planned("search", request)
}

// Preview and opening files (spec §11)

#[tauri::command]
#[specta::specta]
pub fn open_entry(request: OpenEntry) -> Result<Opened, AppError> {
    planned("open_entry", request)
}

#[tauri::command]
#[specta::specta]
pub fn reveal_entry(request: RevealEntry) -> Result<(), AppError> {
    planned("reveal_entry", request)
}

// Import (spec §12)

/// Opens the file dialog; `null` when the user cancels.
#[tauri::command]
#[specta::specta]
pub fn pick_import_files() -> Result<Option<ImportSource>, AppError> {
    planned("pick_import_files", ())
}

#[tauri::command]
#[specta::specta]
pub fn check_import(request: CheckImport) -> Result<ImportCheck, AppError> {
    planned("check_import", request)
}

/// Starts an import job; returns its id.
#[tauri::command]
#[specta::specta]
pub fn import_files(request: ImportFiles) -> Result<String, AppError> {
    planned("import_files", request)
}

// Jobs and problems (spec §13, §14)

#[tauri::command]
#[specta::specta]
pub fn list_jobs() -> Result<Vec<Job>, AppError> {
    planned("list_jobs", ())
}

#[tauri::command]
#[specta::specta]
pub fn cancel_job(request: CancelJob) -> Result<(), AppError> {
    planned("cancel_job", request)
}

/// Replaces the catalog and scans the library from scratch; returns the job id.
#[tauri::command]
#[specta::specta]
pub fn rebuild_catalog() -> Result<String, AppError> {
    planned("rebuild_catalog", ())
}

#[tauri::command]
#[specta::specta]
pub fn list_problems(request: ListProblems) -> Result<Page<ProblemItem>, AppError> {
    planned("list_problems", request)
}
