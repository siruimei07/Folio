//! Library operations (ipc-m1.md §7, §8 and §9.2).

use tauri::State;

use crate::error::AppError;
use crate::ipc::entries::{CreateFolder, DeleteEntries, MoveEntries, RenameEntry};
use crate::ipc::groups::{
    Course, CreateCourse, CreateSemester, ListCourses, ReorderCourses, ReorderSemesters, Semester,
    UpdateCourse, UpdateSemester,
};
use crate::ipc::tags::{
    CreateTag, DeleteTag, ReorderTags, SetEntryTags, Tag, TagDeleted, UpdateTag,
};
use crate::ipc::types::{BatchResult, EntryRow};
use crate::library::LibraryState;

#[tauri::command]
#[specta::specta]
pub async fn list_semesters(state: State<'_, LibraryState>) -> Result<Vec<Semester>, AppError> {
    super::blocking(state, "list semesters", |state| state.list_semesters()).await
}

#[tauri::command]
#[specta::specta]
pub async fn create_semester(
    state: State<'_, LibraryState>,
    request: CreateSemester,
) -> Result<Semester, AppError> {
    super::blocking(state, "create semester", move |state| {
        state.create_semester(request)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn update_semester(
    state: State<'_, LibraryState>,
    request: UpdateSemester,
) -> Result<Semester, AppError> {
    super::blocking(state, "update semester", move |state| {
        state.update_semester(request)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn reorder_semesters(
    state: State<'_, LibraryState>,
    request: ReorderSemesters,
) -> Result<Vec<Semester>, AppError> {
    super::blocking(state, "reorder semesters", move |state| {
        state.reorder_semesters(request)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_courses(
    state: State<'_, LibraryState>,
    request: ListCourses,
) -> Result<Vec<Course>, AppError> {
    super::blocking(state, "list courses", move |state| {
        state.list_courses(request)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn create_course(
    state: State<'_, LibraryState>,
    request: CreateCourse,
) -> Result<Course, AppError> {
    super::blocking(state, "create course", move |state| {
        state.create_course(request)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn update_course(
    state: State<'_, LibraryState>,
    request: UpdateCourse,
) -> Result<Course, AppError> {
    super::blocking(state, "update course", move |state| {
        state.update_course(request)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn reorder_courses(
    state: State<'_, LibraryState>,
    request: ReorderCourses,
) -> Result<Vec<Course>, AppError> {
    super::blocking(state, "reorder courses", move |state| {
        state.reorder_courses(request)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn list_tags(state: State<'_, LibraryState>) -> Result<Vec<Tag>, AppError> {
    super::blocking(state, "list tags", |state| state.list_tags()).await
}

#[tauri::command]
#[specta::specta]
pub async fn create_tag(
    state: State<'_, LibraryState>,
    request: CreateTag,
) -> Result<Tag, AppError> {
    super::blocking(state, "create tag", move |state| state.create_tag(request)).await
}

#[tauri::command]
#[specta::specta]
pub async fn update_tag(
    state: State<'_, LibraryState>,
    request: UpdateTag,
) -> Result<Tag, AppError> {
    super::blocking(state, "update tag", move |state| state.update_tag(request)).await
}

#[tauri::command]
#[specta::specta]
pub async fn reorder_tags(
    state: State<'_, LibraryState>,
    request: ReorderTags,
) -> Result<Vec<Tag>, AppError> {
    super::blocking(state, "reorder tags", move |state| {
        state.reorder_tags(request)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_tag(
    state: State<'_, LibraryState>,
    request: DeleteTag,
) -> Result<TagDeleted, AppError> {
    super::blocking(state, "delete tag", move |state| state.delete_tag(request)).await
}

#[tauri::command]
#[specta::specta]
pub async fn set_entry_tags(
    state: State<'_, LibraryState>,
    request: SetEntryTags,
) -> Result<BatchResult, AppError> {
    super::blocking(state, "set entry tags", move |state| {
        state.set_entry_tags(request)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn create_folder(
    state: State<'_, LibraryState>,
    request: CreateFolder,
) -> Result<EntryRow, AppError> {
    super::blocking(state, "create folder", move |state| {
        state.create_folder(request)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn rename_entry(
    state: State<'_, LibraryState>,
    request: RenameEntry,
) -> Result<EntryRow, AppError> {
    super::blocking(state, "rename entry", move |state| {
        state.rename_entry(request)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn move_entries(
    state: State<'_, LibraryState>,
    request: MoveEntries,
) -> Result<BatchResult, AppError> {
    super::blocking(state, "move entries", move |state| {
        state.move_entries(request)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn delete_entries(
    state: State<'_, LibraryState>,
    request: DeleteEntries,
) -> Result<BatchResult, AppError> {
    super::blocking(state, "delete entries", move |state| {
        state.delete_entries(request)
    })
    .await
}
