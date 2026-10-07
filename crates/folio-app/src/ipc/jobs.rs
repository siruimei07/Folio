//! Background work the user can see: scans, hashing, imports, catalog rebuilds and commits
//! (docs/specs/ipc-m1.md §13, ipc-m2.md §13).

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
    /// A commit of the workspace (`commit`).
    #[expect(
        dead_code,
        reason = "constructed once feat/core-commit-history lands (ipc-m2.md §13)"
    )]
    Commit,
    /// The library's first commit (`start_history`): "Starting history".
    #[expect(
        dead_code,
        reason = "constructed once feat/core-commit-history lands (ipc-m2.md §13)"
    )]
    FirstCommit,
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
        /// The library path of the file the job failed on, when one file caused it (a commit's
        /// `FileChanged`, `NotLocal`, `InUse`, `AccessDenied`); for `HistoryTooLarge` the folder
        /// that holds too many files, `null` when the library as a whole does; `null` otherwise.
        file: Option<String>,
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
    /// Bytes done and in all, for jobs that measure bytes ("12.4 of 48.0 MB"); `null` for the
    /// M1 kinds for now.
    pub bytes: Option<ByteProgress>,
    /// The item in progress, for display.
    pub current: Option<String>,
}

/// Bytes in decimal.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
pub struct ByteProgress {
    pub done: String,
    pub total: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum JobResult {
    Scan {
        changes: u32,
        problems: u32,
    },
    Hash {
        hashed: u32,
        deferred: u32,
    },
    Import(ImportResult),
    Rebuild {
        entries: u32,
    },
    /// The new commit, its summary, and the items plus metadata changes it holds.
    #[expect(
        dead_code,
        reason = "constructed once feat/core-commit-history lands (ipc-m2.md §13)"
    )]
    Commit {
        commit: String,
        summary: String,
        changes: u32,
    },
    /// The first commit, the files it holds, and the items it left out (not local or
    /// unreadable), which stay in the workspace.
    #[expect(
        dead_code,
        reason = "constructed once feat/core-commit-history lands (ipc-m2.md §13)"
    )]
    FirstCommit {
        commit: String,
        files: u32,
        left: u32,
    },
}

/// Stops a queued or running job between files.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Type)]
pub struct CancelJob {
    pub job: String,
}
