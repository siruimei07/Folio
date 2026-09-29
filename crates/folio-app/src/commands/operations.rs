//! Library operations (ipc-m1.md §7, §8 and §9.2).

// Stubs exist only for bindings; implementing a command removes its stub from this module.
#[cfg(test)]
pub(crate) use planned::*;

#[cfg(test)]
mod planned {
    use crate::commands::planned;
    use crate::error::AppError;
    use crate::ipc::entries::{CreateFolder, DeleteEntries, MoveEntries, RenameEntry};
    use crate::ipc::groups::{
        Course, CreateCourse, CreateSemester, ListCourses, ReorderCourses, ReorderSemesters,
        Semester, UpdateCourse, UpdateSemester,
    };
    use crate::ipc::tags::{
        CreateTag, DeleteTag, ReorderTags, SetEntryTags, Tag, TagDeleted, UpdateTag,
    };
    use crate::ipc::types::{BatchResult, EntryRow};

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
}
