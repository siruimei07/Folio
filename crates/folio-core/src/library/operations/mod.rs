//! Synchronous M1 library operations. The shell serializes these with the worker's entire
//! disk walk, not merely its catalog commit, and emits each returned committed report.

mod entries;
mod groups;
mod tags;

use std::path::PathBuf;

use rusqlite::Connection;
use unicode_normalization::UnicodeNormalization;

use super::{CommittedScan, Library, LibraryError};
use crate::catalog::{self, CatalogError, Entry, EntryId};
use crate::meta::{
    Content, EntryKind, MetaError, MetaTree, Settings, TagFile, ValueError, is_folio_owned,
};
use crate::paths::{PathError, RelPath};
use crate::recycle::RecycleError;

pub use groups::{Course, CourseFields, Semester};
pub use tags::Tag;

pub const MAX_BATCH: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryRef {
    pub id: EntryId,
    pub path: RelPath,
}

impl From<&Entry> for EntryRef {
    fn from(entry: &Entry) -> Self {
        Self {
            id: entry.id,
            path: entry.record.path.clone(),
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum OperationError {
    #[error("the entry or tag is no longer at the supplied identity")]
    NotFound,
    #[error("invalid operation argument: {0}")]
    InvalidArgument(&'static str),
    #[error("the name is already taken")]
    AlreadyExists,
    #[error("library metadata is read-only")]
    ReadOnly,
    #[error("a semester cannot move, or the target is inside the source")]
    InvalidMove,
    #[error("metadata cannot be safely changed: {0}")]
    UnreadableMetadata(String),
    /// The OS action succeeded but reconciliation failed. A caller must schedule a full scan;
    /// a SQLite rollback cannot undo a filesystem action.
    #[error("`{path}` changed on disk and needs reconciliation: {source}")]
    DiskChanged {
        path: RelPath,
        #[source]
        source: Box<OperationError>,
    },
    /// `source` is what failed; `cleanup` is the journal cleanup that failed after it, if any.
    #[error(
        "recovery is required before further work: {source}{}",
        cleanup.as_ref().map(|cleanup| format!("; cleaning up also failed: {cleanup}")).unwrap_or_default()
    )]
    RecoveryRequired {
        #[source]
        source: Box<OperationError>,
        cleanup: Option<Box<OperationError>>,
    },
    #[error("item not attempted because an earlier item requires recovery")]
    NotAttempted,
    #[error(transparent)]
    Path(#[from] PathError),
    #[error(transparent)]
    Value(#[from] ValueError),
    #[error(transparent)]
    Meta(#[from] MetaError),
    #[error(transparent)]
    Catalog(#[from] CatalogError),
    #[error(transparent)]
    Library(#[from] LibraryError),
    /// Another program still held the item after the retries.
    #[error("{} is open in another program", path.display())]
    InUse { path: PathBuf },
    #[error("could not change {}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error(transparent)]
    Recycle(#[from] RecycleError),
}

#[derive(Debug)]
pub struct Outcome<T> {
    pub value: T,
    pub committed: CommittedScan,
}

#[derive(Debug, Default)]
pub struct BatchResult {
    pub done: u32,
    pub failures: Vec<(EntryRef, OperationError)>,
}

impl OperationError {
    fn recovery(source: OperationError) -> Self {
        Self::RecoveryRequired {
            source: Box::new(source),
            cleanup: None,
        }
    }
}

fn recovery_required(error: &OperationError) -> bool {
    match error {
        OperationError::RecoveryRequired { .. } => true,
        OperationError::DiskChanged { source, .. } => recovery_required(source),
        _ => false,
    }
}

/// Runs `item` for each reference, one transaction each. After a failure that needs recovery,
/// the remaining references are reported as not attempted.
fn run_batch(
    references: &[EntryRef],
    mut item: impl FnMut(&EntryRef) -> Result<Outcome<()>, OperationError>,
) -> Outcome<BatchResult> {
    let mut outcome = Outcome {
        value: BatchResult::default(),
        committed: CommittedScan::default(),
    };
    let mut blocked = false;
    for reference in references {
        let result = if blocked {
            Err(OperationError::NotAttempted)
        } else {
            item(reference)
        };
        match result {
            Ok(done) => {
                outcome.value.done += 1;
                outcome.committed.merge(done.committed);
            }
            Err(error) => {
                blocked |= recovery_required(&error);
                outcome.value.failures.push((reference.clone(), error));
            }
        }
    }
    outcome
}

pub fn normalize_text(text: &str) -> String {
    text.trim().nfc().collect()
}

fn name(text: &str) -> Result<RelPath, OperationError> {
    let normalized = normalize_text(text);
    crate::paths::check_name(&normalized)?;
    Ok(RelPath::parse(&normalized)?)
}

fn resolve(tx: &Connection, reference: &EntryRef) -> Result<Entry, OperationError> {
    if reference.id.0 <= 0 || is_folio_owned(&reference.path) {
        return Err(OperationError::InvalidArgument("invalid entry reference"));
    }
    catalog::entry_by_id(tx, reference.id)?
        .filter(|entry| entry.record.path == reference.path)
        .ok_or(OperationError::NotFound)
}

fn folder(tx: &Connection, reference: &EntryRef) -> Result<Entry, OperationError> {
    let entry = resolve(tx, reference)?;
    if entry.record.kind != EntryKind::Folder {
        return Err(OperationError::InvalidArgument("expected a folder"));
    }
    Ok(entry)
}

fn batch_limit(entries: &[EntryRef]) -> Result<(), OperationError> {
    if entries.len() > MAX_BATCH {
        return Err(OperationError::InvalidArgument("batch limit exceeded"));
    }
    Ok(())
}

fn writable(tree: &MetaTree) -> Result<(), OperationError> {
    if tree.is_read_only() {
        Err(OperationError::ReadOnly)
    } else {
        Ok(())
    }
}

/// The file that holds `file`'s metadata: on a disk that tells case apart, the one of several
/// spellings that owns it.
fn owner(tree: &MetaTree, file: &TagFile) -> TagFile {
    tree.owners()
        .of(file)
        .cloned()
        .unwrap_or_else(|| file.clone())
}

/// Whether the file that holds `file`'s metadata cannot be read.
fn unreadable(tree: &MetaTree, file: &TagFile) -> bool {
    tree.broken().contains_key(&owner(tree, file))
}

fn content(tree: &MetaTree, file: &TagFile) -> Result<(TagFile, Content), OperationError> {
    let file = owner(tree, file);
    if let Some(error) = tree.broken().get(&file) {
        return Err(OperationError::UnreadableMetadata(error.to_string()));
    }
    let value = tree.loaded().get(&file).cloned().unwrap_or_default();
    Ok((file, value))
}

impl Library {
    fn after_metadata_write<T>(
        &self,
        written: bool,
        result: Result<Outcome<T>, OperationError>,
    ) -> Result<Outcome<T>, OperationError> {
        result.map_err(|source| {
            if written {
                OperationError::recovery(source)
            } else {
                source
            }
        })
    }

    fn write_content(&self, file: &TagFile, value: &Content) -> Result<(), OperationError> {
        Ok(crate::meta::write_content(&self.layout, file, value)?)
    }

    fn mirror_operation(&self, tx: &Connection) -> Result<CommittedScan, OperationError> {
        let tree = self.read_meta(tx)?;
        Ok(self.mirror_commit(tx, &tree, Vec::new())?)
    }
}

#[cfg(test)]
mod tests;
