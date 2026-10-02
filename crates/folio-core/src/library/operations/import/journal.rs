//! One verified copy at a time. The intent never contains an outside source path.

use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;

use serde::{Deserialize, Serialize};

use super::{OperationError, io_at};
use crate::catalog::{self, Catalog, EntryRecord};
use crate::files;
use crate::fs::{FileKind, Metadata, Presence};
use crate::hash::ContentHash;
use crate::library::{
    Change, CommittedScan, EntryChange, EntryChangeKind, Library, LibraryError, ScanCoverage, state,
};
use crate::meta::{EntryKind, LibraryId, MetaError, TagId, tag_location};
use crate::paths::RelPath;

const MAX_INTENT_BYTES: u64 = 1 << 20;

pub(super) fn path(library: &Library) -> PathBuf {
    library.layout.import_journal_file()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Identity {
    size: u64,
    modified_ns: Option<i64>,
    created_ns: Option<i64>,
    file_id: Option<String>,
}

impl Identity {
    fn of(metadata: &Metadata) -> Self {
        Self {
            size: metadata.size,
            modified_ns: metadata.modified_ns,
            created_ns: metadata.created_ns,
            file_id: metadata.file_id.clone(),
        }
    }

    fn matches(&self, metadata: &Metadata) -> bool {
        metadata.kind == FileKind::File
            && metadata.presence == Presence::Local
            && self.size == metadata.size
            && self.modified_ns == metadata.modified_ns
            && self.created_ns == metadata.created_ns
            && self.file_id == metadata.file_id
    }

    fn published_matches(&self, metadata: &Metadata) -> bool {
        if self.file_id.is_none() {
            // Non-NTFS adapters have no file IDs: retain every available identity field.
            return self.matches(metadata);
        }
        // NTFS name tunneling may restore the old destination's creation time when this
        // verified stage is renamed into it. Its volume/file ID must still be present and
        // unchanged; callers also verify the complete content hash before accepting it.
        metadata.kind == FileKind::File
            && metadata.presence == Presence::Local
            && self.size == metadata.size
            && self.modified_ns == metadata.modified_ns
            && self.file_id.is_some()
            && self.file_id == metadata.file_id
    }

    fn parent_matches(&self, metadata: &Metadata) -> bool {
        metadata.kind == FileKind::Folder
            && self.created_ns == metadata.created_ns
            && self.file_id == metadata.file_id
    }
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Intent {
    format_version: u32,
    library: LibraryId,
    stage: String,
    destination: RelPath,
    hash: ContentHash,
    identity: Identity,
    parent: Identity,
    old: Option<Identity>,
    tags: BTreeSet<TagId>,
    added_ns: i64,
}

impl Intent {
    pub(super) fn new(
        library: &Library,
        stage: &Path,
        destination: &RelPath,
        hash: &ContentHash,
        old: Option<&Metadata>,
        tags: &BTreeSet<TagId>,
        added_ns: i64,
    ) -> Result<Self, OperationError> {
        let config = library
            .layout
            .read_library()?
            .ok_or_else(|| LibraryError::NotALibrary {
                path: library.layout.library_file(),
            })?;
        let parent = destination.parent().ok_or(OperationError::InvalidArgument(
            "import destination has no parent",
        ))?;
        let parent = library.disk_path(&parent, EntryKind::Folder)?;
        let identity = library
            .fs
            .metadata(stage)
            .map_err(|error| io_at(stage, error))?;
        Ok(Self {
            format_version: 1,
            library: config.id,
            stage: stage
                .file_name()
                .and_then(|name| name.to_str())
                .ok_or(OperationError::InvalidArgument("invalid import stage"))?
                .to_owned(),
            destination: destination.clone(),
            hash: hash.clone(),
            identity: Identity::of(&identity),
            parent: Identity::of(&parent),
            old: old.map(Identity::of),
            tags: tags.clone(),
            added_ns,
        })
    }

    pub(super) fn write(&self, library: &Library) -> Result<(), OperationError> {
        state::validate_metadata(library.root())?;
        match fs::symlink_metadata(library.layout.scan_journal_file()) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_at(&library.layout.scan_journal_file(), error)),
            Ok(_) => {
                return Err(OperationError::recovery(
                    invalid(
                        library,
                        "settle the metadata or move intent before importing",
                    )
                    .into(),
                ));
            }
        }
        let target = path(library);
        match fs::symlink_metadata(&target) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(io_at(&target, error)),
            Ok(_) => {
                return Err(OperationError::recovery(
                    invalid(library, "an unsettled import intent cannot be replaced").into(),
                ));
            }
        }
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| invalid(library, error))?;
        if bytes.len() as u64 > MAX_INTENT_BYTES {
            return Err(invalid(library, "import intent is too large").into());
        }
        files::write_atomically(&library.layout.staging_dir(), &target, &bytes)
            .map_err(|error| io_at(&target, error))
    }

    /// An unsuccessful recycle left the old item intact; the temporary copy is not a user file.
    pub(super) fn abandon(&self, library: &Library) -> Result<(), OperationError> {
        let target = path(library);
        fs::remove_file(&target).map_err(|error| io_at(&target, error))
    }

    fn stage_path(&self, library: &Library) -> Result<PathBuf, LibraryError> {
        let random = self
            .stage
            .strip_prefix("import-")
            .and_then(|name| name.strip_suffix(".part"));
        if self.format_version != 1
            || !random.is_some_and(|random| random.len() == 32 && crate::is_lower_hex(random))
            || self.destination.depth() < 3
            || crate::meta::is_folio_owned(&self.destination)
        {
            return Err(invalid(
                library,
                "invalid import intent version, stage or destination",
            )
            .into());
        }
        let config = library
            .layout
            .read_library()?
            .ok_or_else(|| LibraryError::NotALibrary {
                path: library.layout.library_file(),
            })?;
        if config.id != self.library {
            return Err(invalid(library, "import intent belongs to another library").into());
        }
        Ok(library.layout.staging_dir().join(&self.stage))
    }
}

impl Library {
    /// Recovers a verified staged copy without recycling anything, or commits one already
    /// published copy. This deliberately does not call a scan, which itself starts with
    /// `recover_pending`.
    pub fn recover_import(&self, catalog: &Catalog) -> Result<CommittedScan, LibraryError> {
        self.settle_import(catalog).map(|(committed, _)| committed)
    }

    /// Like `recover_import`, and also says whether the copy was abandoned instead of published.
    /// A destination that changed under the import (an edited old file, a new arrival, a moved
    /// or replaced folder) abandons the copy: that only removes Folio's own verified stage and
    /// the intent, never a user file, and the original was not recycled yet. A tampered intent
    /// or stage still fails closed and keeps its evidence.
    pub(super) fn settle_import(
        &self,
        catalog: &Catalog,
    ) -> Result<(CommittedScan, bool), LibraryError> {
        let intent_path = path(self);
        match fs::symlink_metadata(&intent_path) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Ok((CommittedScan::default(), false));
            }
            Err(source) => {
                return Err(MetaError::Io {
                    path: intent_path,
                    source,
                }
                .into());
            }
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(invalid(self, "import intent is not a regular file").into());
            }
            Ok(_) => {}
        }
        state::validate_metadata(self.root())?;
        match fs::symlink_metadata(self.layout.scan_journal_file()) {
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(source) => {
                return Err(MetaError::Io {
                    path: self.layout.scan_journal_file(),
                    source,
                }
                .into());
            }
            Ok(_) => {
                return Err(
                    invalid(self, "import and metadata/move intents cannot coexist").into(),
                );
            }
        }
        let bytes = files::retry_transient(|| {
            files::read_capped(File::open(&intent_path)?, MAX_INTENT_BYTES)
        })
        .map_err(|source| io_error(&intent_path, source))?
        .ok_or_else(|| invalid(self, "import intent is too large"))?;
        let intent: Intent =
            serde_json::from_slice(&bytes).map_err(|error| invalid(self, error))?;
        let stage = intent.stage_path(self)?;
        let mut abandoned = false;
        let committed = catalog.write_with(|tx| -> Result<_, LibraryError> {
            state::validate_metadata(self.root())?;
            let tree = self.read_meta(tx)?;
            let parent = intent
                .destination
                .parent()
                .ok_or_else(|| invalid(self, "import has no parent"))?;
            self.native_length(&intent.destination)
                .map_err(|error| invalid(self, error))?;
            let parent_unchanged = match self.disk_path(&parent, EntryKind::Folder) {
                Ok(actual) => intent.parent.parent_matches(&actual),
                Err(OperationError::NotFound) => false,
                Err(error) => {
                    return Err(operation_error(self, &parent.to_native(self.root()), error));
                }
            };
            let staged = match files::retry_transient(|| fs::symlink_metadata(&stage)) {
                Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                    return Err(invalid(self, "import stage is not a regular file").into());
                }
                Ok(_) => Some(
                    files::retry_transient(|| self.fs.metadata(&stage))
                        .map_err(|source| io_error(&stage, source))?,
                ),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(source) => return Err(io_error(&stage, source).into()),
            };
            if let Some(metadata) = &staged
                && (!intent.identity.matches(metadata)
                    || !matching_hash(self, &stage, &intent.hash)?)
            {
                return Err(invalid(self, "verified import stage changed").into());
            }
            if !parent_unchanged {
                // Nothing can be published into a moved or replaced folder; a copy published
                // before it moved travels with it and the next scan finds it.
                abandoned = true;
                return Ok(CommittedScan::default());
            }
            let occupied = self
                .import_collision(&intent.destination)
                .map_err(|error| {
                    operation_error(self, &intent.destination.to_native(self.root()), error)
                })?;
            match (&staged, occupied) {
                (Some(_), None) => {
                    match rename_no_replace(&stage, &intent.destination.to_native(self.root())) {
                        Ok(()) => {}
                        // Something arrived after the check: never overwrite it.
                        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                            abandoned = true;
                            return Ok(CommittedScan::default());
                        }
                        Err(source) => {
                            return Err(io_error(
                                &intent.destination.to_native(self.root()),
                                source,
                            )
                            .into());
                        }
                    }
                }
                (None, Some(occupied))
                    if occupied.path.as_ref() == Some(&intent.destination)
                        && intent.identity.published_matches(&occupied.metadata)
                        && matching_hash(
                            self,
                            &intent.destination.to_native(self.root()),
                            &intent.hash,
                        )? => {}
                _ => {
                    // The old file is still there (the process stopped before recycling it) or
                    // was edited, something else arrived, or the published copy was changed or
                    // removed. Abandon rather than repeat a destructive action or overwrite.
                    abandoned = true;
                    return Ok(CommittedScan::default());
                }
            }
            let native = intent.destination.to_native(self.root());
            let disk = self
                .disk_path(&intent.destination, EntryKind::File)
                .map_err(|error| operation_error(self, &native, error))?;
            if !intent.identity.published_matches(&disk)
                || !matching_hash(self, &native, &intent.hash)?
            {
                return Err(invalid(self, "published import changed").into());
            }
            if !intent.tags.is_empty() {
                if tree.is_read_only() {
                    return Err(
                        invalid(self, "import tags cannot modify read-only metadata").into(),
                    );
                }
                let definitions = self
                    .layout
                    .read_tags()?
                    .ok_or_else(|| invalid(self, "import tag definitions are missing"))?;
                if intent
                    .tags
                    .iter()
                    .any(|tag| !definitions.tags.contains_key(tag))
                {
                    return Err(invalid(self, "import tags are no longer defined").into());
                }
                let (holder, key) = tag_location(&intent.destination, EntryKind::File)
                    .ok_or_else(|| invalid(self, "import tags have no holder"))?;
                // MetaTree retains per-file read errors; content() otherwise stringifies them.
                let holder = super::super::owner(&tree, &holder);
                if let Some(MetaError::Io { path, source }) = tree.broken().get(&holder) {
                    let source = source.raw_os_error().map_or_else(
                        || io::Error::new(source.kind(), source.to_string()),
                        io::Error::from_raw_os_error,
                    );
                    return Err(io_error(path, source).into());
                }
                let (holder, mut value) =
                    super::super::content(&tree, &holder).map_err(|error| invalid(self, error))?;
                let mut assigned = value
                    .tags
                    .iter()
                    .find(|(path, _)| path.key() == key.key())
                    .map(|(_, tags)| tags.clone())
                    .unwrap_or_default();
                assigned.extend(intent.tags.iter().cloned());
                value.tags.set(key, assigned);
                self.write_content(&holder, &value)
                    .map_err(|error| operation_error(self, &native, error))?;
            }
            let config = self
                .layout
                .read_library()?
                .ok_or_else(|| LibraryError::NotALibrary {
                    path: self.layout.library_file(),
                })?;
            let previous = catalog::entry(tx, &intent.destination)?;
            let record = EntryRecord {
                path: intent.destination.clone(),
                kind: EntryKind::File,
                class: config.versioning.class_of(&intent.destination),
                size: disk.size,
                mtime_ns: disk.modified_ns,
                file_id: disk.file_id,
                hash: Some(intent.hash.clone()),
            };
            let id = catalog::upsert_entry(tx, &record, intent.added_ns)?;
            let mut committed = self
                .mirror_operation(tx)
                .map_err(|error| operation_error(self, &native, error))?;
            if previous.as_ref().is_none_or(|entry| entry.record != record) {
                committed.entries.push(EntryChange {
                    id,
                    path: intent.destination.clone(),
                    kind: if previous.is_some() {
                        EntryChangeKind::Modified
                    } else {
                        EntryChangeKind::Added
                    },
                });
                committed.report.changes.push(if previous.is_some() {
                    Change::Modified(intent.destination.clone())
                } else {
                    Change::Added(intent.destination.clone())
                });
            }
            committed.coverage = ScanCoverage::Metadata;
            Ok(committed)
        })?;
        // The complete catalog/tag commit precedes cleanup. If cleanup fails, its marker and
        // verified destination make retry idempotent; do not hide this committed report.
        if let Err(error) = fs::remove_file(&intent_path) {
            let mut committed = committed;
            committed
                .report
                .problems
                .push(crate::library::Problem::metadata(
                    self.root(),
                    &MetaError::Io {
                        path: intent_path,
                        source: error,
                    },
                ));
            return Ok((committed, abandoned));
        }
        if abandoned {
            match fs::remove_file(&stage) {
                Err(error) if error.kind() != io::ErrorKind::NotFound => {
                    return Err(MetaError::Io {
                        path: stage,
                        source: error,
                    }
                    .into());
                }
                _ => {}
            }
        }
        Ok((committed, abandoned))
    }
}

fn matching_hash(
    library: &Library,
    path: &Path,
    expected: &ContentHash,
) -> Result<bool, LibraryError> {
    let metadata = files::retry_transient(|| library.fs.metadata(path))
        .map_err(|source| io_error(path, source))?;
    if metadata.kind != FileKind::File || metadata.presence != Presence::Local {
        return Ok(false);
    }
    let mut buffer = Vec::new();
    // Retry the complete read with a new handle/hash, never a partly consumed reader.
    let hash = files::retry_transient(|| {
        library
            .fs
            .open(path)
            .and_then(|reader| ContentHash::read(reader, &AtomicBool::new(false), &mut buffer))
    })
    .map_err(|source| io_error(path, source))?;
    let after = files::retry_transient(|| library.fs.metadata(path))
        .map_err(|source| io_error(path, source))?;
    Ok(hash.as_ref() == Some(expected) && metadata == after)
}

fn io_error(path: &Path, source: io::Error) -> MetaError {
    MetaError::Io {
        path: path.to_owned(),
        source,
    }
}

/// Preserve operational failures; only validation of journal-derived state fails closed.
fn operation_error(library: &Library, path: &Path, error: OperationError) -> LibraryError {
    match error {
        OperationError::Meta(error) => error.into(),
        OperationError::Catalog(error) => error.into(),
        OperationError::Library(error) => error,
        OperationError::Io { path, source } => io_error(&path, source).into(),
        OperationError::InUse { path } => {
            // The operation layer already classified a Windows sharing/lock violation.
            io_error(&path, io::Error::from_raw_os_error(32)).into()
        }
        OperationError::NotFound => io_error(path, io::ErrorKind::NotFound.into()).into(),
        error => invalid(library, error).into(),
    }
}

fn invalid(library: &Library, reason: impl std::fmt::Display) -> MetaError {
    MetaError::Invalid {
        path: path(library),
        reason: reason.to_string(),
    }
}

#[cfg(windows)]
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    files::retry_transient(|| crate::win::rename_no_replace(from, to))
}

#[cfg(not(windows))]
fn rename_no_replace(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "import publication requires Windows",
    ))
}
