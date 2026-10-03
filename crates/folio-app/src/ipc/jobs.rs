//! Background work the user can see: scans, hashing, imports and catalog rebuilds
//! (docs/specs/ipc-m1.md §13).

use serde::{Deserialize, Serialize};
use specta::Type;

use super::import::ImportResult;
use crate::error::AppError;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Job {
    pub id: String,
    pub kind: JobKind,
    pub cancellable: bool,
    pub status: JobStatus,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Type)]
#[serde(rename_all = "camelCase")]
pub enum JobKind {
    Scan,
    Hash,
    Import,
    /// "Rebuild search index": a new catalog, scanned from scratch.
    Rebuild,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum JobStatus {
    Queued,
    Running {
        progress: Progress,
    },
    Done {
        result: JobResult,
    },
    Failed {
        error: AppError,
    },
    /// Stopped between files; what was done stays done. An import that had started reports
    /// what it did before it stopped; the other kinds, and a job cancelled while queued, have
    /// none.
    Cancelled {
        result: Option<JobResult>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct Progress {
    /// Items done: files or entries.
    pub done: u32,
    /// Items in all, once known.
    pub total: Option<u32>,
    /// 0–1000 of the work by bytes, for jobs that measure bytes.
    pub permille: Option<u32>,
    /// The item in progress, for display.
    pub current: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JobResult {
    Scan { changes: u32, problems: u32 },
    Hash { hashed: u32, deferred: u32 },
    Import(ImportResult),
    Rebuild { entries: u32 },
}

/// Stops a queued or running job between files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CancelJob {
    pub job: String,
}
