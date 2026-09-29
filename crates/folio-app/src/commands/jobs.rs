//! Job and problem commands (ipc-m1.md §13 and §14).

use tauri::State;

use super::blocking;
use crate::error::AppError;
use crate::ipc::jobs::{CancelJob, Job};
use crate::ipc::problems::{ListProblems, ProblemItem};
use crate::ipc::types::Page;
use crate::library::LibraryState;

#[tauri::command]
#[specta::specta]
pub async fn list_jobs(state: State<'_, LibraryState>) -> Result<Vec<Job>, AppError> {
    blocking(state, "list jobs", |state| state.list_jobs()).await
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_job(
    state: State<'_, LibraryState>,
    request: CancelJob,
) -> Result<(), AppError> {
    blocking(state, "cancel job", |state| state.cancel(request)).await
}

/// Replaces the catalog and scans the library from scratch; returns the job id.
#[tauri::command]
#[specta::specta]
pub async fn rebuild_catalog(state: State<'_, LibraryState>) -> Result<String, AppError> {
    blocking(state, "rebuild catalog", |state| state.rebuild()).await
}

#[tauri::command]
#[specta::specta]
pub async fn list_problems(
    state: State<'_, LibraryState>,
    request: ListProblems,
) -> Result<Page<ProblemItem>, AppError> {
    blocking(state, "list problems", |state| state.problems(request)).await
}
