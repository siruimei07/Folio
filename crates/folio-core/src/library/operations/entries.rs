use std::fs;
use std::io;
use std::path::Path;

use rusqlite::Connection;

use super::{
    BatchResult, EntryRef, OperationError, Outcome, batch_limit, folder, name, resolve, run_batch,
};
use crate::catalog::{self, Catalog, Entry, EntryChanges, EntryRecord};
use crate::files;
use crate::fs::{FileKind, Metadata};
use crate::library::{
    Change, CommittedScan, EntryChange, EntryChangeKind, Library, Problem, is_group,
};
use crate::meta::{
    EntryKind, FileClass, MetaTree, Moves, ScanJournal, StrandedCause, is_folio_owned, tag_location,
};
use crate::paths::{MAX_PATH_UNITS, PathError, RelPath, same_name};
use crate::recycle::RecycleBin;

impl Library {
    pub fn create_folder(
        &self,
        catalog: &Catalog,
        parent: &EntryRef,
        text: &str,
        now_ns: i64,
    ) -> Result<Outcome<Entry>, OperationError> {
        let tail = name(text)?;
        let mut changed = None;
        let result = catalog.write_with(|tx| {
            let parent = folder(tx, parent)?;
            if parent.record.path.depth() < 2 {
                return Err(OperationError::InvalidArgument(
                    "parent is not inside a course",
                ));
            }
            self.entry_disk(&parent)?;
            self.read_meta(tx)?;
            let path = parent.record.path.join(&tail)?;
            let entry = self.create_at(tx, &path, now_ns)?;
            changed = Some(path.clone());
            let mut committed = self.mirror_operation(tx)?;
            committed.entries.push(EntryChange {
                id: entry.id,
                path: path.clone(),
                kind: EntryChangeKind::Added,
            });
            committed.report.changes.push(Change::Added(path));
            Ok(Outcome {
                value: entry,
                committed,
            })
        });
        self.after_disk_write(catalog, changed, result)
    }

    /// Creates one directory without replacing a disk item, for the group commands too.
    pub(super) fn create_at(
        &self,
        tx: &Connection,
        path: &RelPath,
        now_ns: i64,
    ) -> Result<Entry, OperationError> {
        self.destination(tx, path, None)?;
        let native = path.to_native(self.root());
        fs::create_dir(&native).map_err(|source| io_error(native.clone(), source))?;
        let inserted = (|| {
            let metadata = self.disk_path(path, EntryKind::Folder)?;
            let record = EntryRecord {
                path: path.clone(),
                kind: EntryKind::Folder,
                class: FileClass::Other,
                size: 0,
                mtime_ns: metadata.modified_ns,
                file_id: metadata.file_id,
                hash: None,
            };
            let id = catalog::upsert_entry(tx, &record, now_ns)?;
            Ok(Entry {
                id,
                record,
                added_ns: now_ns,
            })
        })();
        inserted.map_err(|source| OperationError::DiskChanged {
            path: path.clone(),
            source: Box::new(source),
        })
    }

    pub fn rename_entry(
        &self,
        catalog: &Catalog,
        reference: &EntryRef,
        text: &str,
        _now_ns: i64,
    ) -> Result<Outcome<Entry>, OperationError> {
        let tail = name(text)?;
        let mut changed = None;
        let result = catalog.write_with(|tx| {
            let entry = resolve(tx, reference)?;
            let path = tail.below(entry.record.path.parent().as_ref())?;
            let committed = self.relocate_entry(tx, &entry, &path, &mut changed)?;
            let value = catalog::entry_by_id(tx, entry.id)?.ok_or(OperationError::NotFound)?;
            Ok(Outcome { value, committed })
        });
        self.after_disk_write(catalog, changed, result)
    }

    pub fn move_entries(
        &self,
        catalog: &Catalog,
        references: &[EntryRef],
        to: Option<&EntryRef>,
        _now_ns: i64,
    ) -> Result<Outcome<BatchResult>, OperationError> {
        batch_limit(references)?;
        // A bad target is a command error, including an empty batch. Each item revalidates it.
        catalog.write_with(|tx| -> Result<(), OperationError> {
            if let Some(to) = to {
                let target = folder(tx, to)?;
                self.entry_disk(&target)?;
            }
            Ok(())
        })?;
        Ok(run_batch(references, |reference| {
            let mut changed = None;
            let result = catalog.write_with(|tx| {
                let entry = resolve(tx, reference)?;
                let target = to.map(|to| folder(tx, to)).transpose()?;
                if let Some(target) = &target {
                    self.entry_disk(target)?;
                }
                if entry.record.kind == EntryKind::Folder
                    && (entry.record.path.depth() == 1
                        || target.as_ref().is_some_and(|target| {
                            target
                                .record
                                .path
                                .ancestors()
                                .any(|ancestor| ancestor.key() == entry.record.path.key())
                        }))
                {
                    return Err(OperationError::InvalidMove);
                }
                let tail = RelPath::parse(entry.record.path.name())?;
                let path = tail.below(target.as_ref().map(|entry| &entry.record.path))?;
                let committed = self.relocate_entry(tx, &entry, &path, &mut changed)?;
                Ok(Outcome {
                    value: (),
                    committed,
                })
            });
            self.after_disk_write(catalog, changed, result)
        }))
    }

    pub fn delete_entries(
        &self,
        catalog: &Catalog,
        references: &[EntryRef],
        bin: &dyn RecycleBin,
    ) -> Result<Outcome<BatchResult>, OperationError> {
        batch_limit(references)?;
        Ok(run_batch(references, |reference| {
            let mut changed = None;
            let result = catalog.write_with(|tx| {
                let entry = resolve(tx, reference)?;
                self.entry_disk(&entry)?;
                let entries = catalog::entries_in(tx, Some(&entry.record.path))?;
                let changes = EntryChanges {
                    removed: entries
                        .iter()
                        .map(|entry| (entry.id, entry.record.path.clone()))
                        .collect(),
                    ..EntryChanges::default()
                };
                catalog::apply_changes(tx, &changes)?;
                let mut committed = self.mirror_operation(tx)?;
                for entry in entries {
                    let path = entry.record.path;
                    committed.groups |= is_group(&path, entry.record.kind);
                    committed.entries.push(EntryChange {
                        id: entry.id,
                        path: path.clone(),
                        kind: EntryChangeKind::Removed,
                    });
                    committed.report.changes.push(Change::Removed(path));
                }
                // No metadata deletion: a restored file gets its authored tags/settings back.
                // Either destination counts: the Recycle Bin or, for a file only in the cloud,
                // its provider's trash.
                self.entry_disk(&entry)?;
                bin.recycle(&entry.record.path.to_native(self.root()))?;
                changed = Some(entry.record.path);
                Ok(Outcome {
                    value: (),
                    committed,
                })
            });
            self.after_disk_write(catalog, changed, result)
        }))
    }

    fn relocate_entry(
        &self,
        tx: &Connection,
        entry: &Entry,
        to: &RelPath,
        changed: &mut Option<RelPath>,
    ) -> Result<CommittedScan, OperationError> {
        self.entry_disk(entry)?;
        self.destination(tx, to, Some(entry))?;
        if *to == entry.record.path {
            return Ok(CommittedScan::default());
        }
        let entries = catalog::entries_in(tx, Some(&entry.record.path))?;
        let mut moves = Moves::new();
        let mut changes = EntryChanges::default();
        let mut identities = Vec::new();
        for descendant in &entries {
            let path = match descendant.record.path.strip_prefix(&entry.record.path) {
                Some(tail) => to.join(&tail)?,
                None => to.clone(),
            };
            self.native_length(&path)?;
            identities.push((
                descendant.clone(),
                path.clone(),
                self.entry_disk(descendant)?,
            ));
            moves.insert(
                descendant.record.path.clone(),
                (path.clone(), descendant.record.kind),
            );
            changes.moved.push((descendant.id, path));
        }
        let mut tree = self.read_meta(tx)?;
        if tree.is_read_only() && metadata_follows(&tree, &entry.record.path, entry.record.kind) {
            return Err(OperationError::ReadOnly);
        }
        let stranded = tree.relocate(&moves);
        if stranded
            .iter()
            .any(|stranded| stranded.cause == StrandedCause::ReadOnly)
        {
            return Err(OperationError::ReadOnly);
        }
        if entry.record.kind == EntryKind::File {
            let config = self.layout.read_library()?.ok_or_else(|| {
                crate::library::LibraryError::NotALibrary {
                    path: self.layout.library_file(),
                }
            })?;
            let mut record = entry.record.clone();
            record.path = to.clone();
            record.class = config.versioning.class_of(to);
            changes.updated.push((entry.id, record));
        }
        // Catalog and metadata work before the OS change. If the OS rename fails, SQL rolls
        // back but the metadata stays changed: the retained intent makes the caller reconcile
        // (`recover_pending` restores the before-images). After a crash the journal does the same.
        catalog::apply_changes(tx, &changes)?;
        let journal = tree.save_operation(&self.layout, &entry.record.path, to, &identities)?;
        if let Some(id) = &journal {
            catalog::set_committed_scan_journal(tx, id)?;
        }
        let problems = stranded
            .into_iter()
            .map(|stranded| Problem::NotRelocated {
                from: stranded.from,
                to: stranded.to,
                cause: stranded.cause,
            })
            .collect();
        let mut committed = self.mirror_commit(tx, &tree, problems)?;
        for (descendant, (_, path)) in entries.iter().zip(&changes.moved) {
            committed.push_moved(
                descendant.id,
                &descendant.record.path,
                path,
                descendant.record.kind,
            );
        }
        // Recheck the path components immediately before the native call.
        // ponytail: pathname guards leave an external ancestor-replacement race; pin ancestor
        // handles if the OS boundary must exclude concurrent same-user writers.
        self.entry_disk(entry)?;
        self.destination(tx, to, Some(entry))?;
        rename_no_replace(
            &entry.record.path.to_native(self.root()),
            &to.to_native(self.root()),
        )
        .map_err(|source| io_error(entry.record.path.to_native(self.root()), source))?;
        *changed = Some(to.clone());
        Ok(committed)
    }

    /// Validates all existing ancestors below the selected root without following links.
    pub(super) fn entry_disk(&self, entry: &Entry) -> Result<Metadata, OperationError> {
        let metadata = self.disk_path(&entry.record.path, entry.record.kind)?;
        if let (Some(stored), Some(current)) = (&entry.record.file_id, &metadata.file_id)
            && stored != current
        {
            return Err(OperationError::NotFound);
        }
        Ok(metadata)
    }

    /// Validates all existing ancestors below the selected root without following links.
    pub(super) fn disk_path(
        &self,
        path: &RelPath,
        kind: EntryKind,
    ) -> Result<Metadata, OperationError> {
        if is_folio_owned(path) {
            return Err(OperationError::Path(PathError::ReservedName));
        }
        self.native_length(path)?;
        let mut ancestor = None;
        for segment in path.names() {
            let tail = RelPath::parse(segment)?;
            let current = tail.below(ancestor.as_ref())?;
            let native = current.to_native(self.root());
            let metadata = self
                .fs
                .metadata(&native)
                .map_err(|source| io_error(native, source))?;
            let expected = if current == *path && kind == EntryKind::File {
                FileKind::File
            } else {
                FileKind::Folder
            };
            if metadata.kind != expected {
                return Err(OperationError::InvalidArgument(
                    "path kind changed or contains a link",
                ));
            }
            ancestor = Some(current);
        }
        let native = path.to_native(self.root());
        self.fs
            .metadata(&native)
            .map_err(|source| io_error(native, source))
    }

    pub(super) fn native_length(&self, path: &RelPath) -> Result<(), OperationError> {
        let native = path.to_native(self.root());
        if !native.is_absolute() {
            return Err(OperationError::InvalidArgument(
                "library root is not absolute",
            ));
        }
        #[cfg(windows)]
        let units = {
            use std::os::windows::ffi::OsStrExt;
            native.as_os_str().encode_wide().count()
        };
        #[cfg(not(windows))]
        let units = native.to_string_lossy().encode_utf16().count();
        if units >= MAX_PATH_UNITS {
            Err(PathError::TooLong.into())
        } else {
            Ok(())
        }
    }

    fn destination(
        &self,
        tx: &Connection,
        path: &RelPath,
        source: Option<&Entry>,
    ) -> Result<(), OperationError> {
        if is_folio_owned(path) {
            return Err(OperationError::Path(PathError::ReservedName));
        }
        self.native_length(path)?;
        let parent = path.parent();
        if let Some(parent) = &parent {
            self.disk_path(parent, EntryKind::Folder)?;
        }
        if catalog::entries_with_key(tx, &path.key())?
            .iter()
            .any(|entry| source.is_none_or(|source| source.id != entry.id))
        {
            return Err(OperationError::AlreadyExists);
        }
        let native_parent = parent.as_ref().map_or_else(
            || self.root().to_owned(),
            |parent| parent.to_native(self.root()),
        );
        let listed = self
            .fs
            .read_dir(&native_parent)
            .map_err(|source| io_error(native_parent, source))?;
        for candidate in listed {
            let Some(text) = candidate.name.to_str() else {
                continue;
            };
            if same_name(text, path.name()) {
                let is_source = source.is_some_and(|source| {
                    source.record.path.parent() == parent && source.record.path.name() == text
                });
                if !is_source {
                    return Err(OperationError::AlreadyExists);
                }
            }
        }
        Ok(())
    }

    pub(super) fn after_disk_write<T>(
        &self,
        catalog: &Catalog,
        changed: Option<RelPath>,
        result: Result<Outcome<T>, OperationError>,
    ) -> Result<Outcome<T>, OperationError> {
        let error = match result {
            Ok(mut outcome) => {
                if let Err(error) = self.finish_journal(catalog) {
                    outcome
                        .committed
                        .report
                        .problems
                        .push(self.journal_problem(error));
                }
                return Ok(outcome);
            }
            Err(error) => error,
        };
        // Explicit move intents survive a failed COMMIT. A separate recovery COMMIT must
        // reconcile them before any later writer can publish another intent.
        let error = match ScanJournal::read(&self.layout) {
            Ok(Some(journal)) if journal.moved().is_some() => OperationError::recovery(error),
            journal => {
                let cleanup = journal.map_err(OperationError::from).and_then(|_| {
                    if changed.is_some() {
                        catalog
                            .with_writer(|_| ScanJournal::remove(&self.layout))
                            .map_err(OperationError::from)
                    } else {
                        self.finish_journal(catalog).map_err(OperationError::from)
                    }
                });
                match cleanup {
                    Ok(()) => error,
                    Err(cleanup) => OperationError::RecoveryRequired {
                        source: Box::new(error),
                        cleanup: Some(Box::new(cleanup)),
                    },
                }
            }
        };
        Err(match changed {
            Some(path) => OperationError::DiskChanged {
                path,
                source: Box::new(error),
            },
            None => error,
        })
    }
}

fn metadata_follows(tree: &MetaTree, source: &RelPath, kind: EntryKind) -> bool {
    let under = |path: &RelPath| {
        path.ancestors()
            .any(|ancestor| ancestor.key() == source.key())
    };
    let holder = tag_location(source, kind).map(|(file, _)| file.key());
    tree.loaded().iter().any(|(file, content)| {
        (content.settings.is_some() && file.folder().is_some_and(under))
            || content
                .tags
                .iter()
                .any(|(key, _)| key.below(file.folder()).is_ok_and(|path| under(&path)))
    }) || tree
        .broken()
        .keys()
        .any(|file| file.folder().is_some_and(under) || holder.as_ref() == Some(&file.key()))
}

fn io_error(path: std::path::PathBuf, source: io::Error) -> OperationError {
    if source.kind() == io::ErrorKind::AlreadyExists {
        OperationError::AlreadyExists
    } else if source.kind() == io::ErrorKind::NotFound {
        OperationError::NotFound
    } else if files::is_in_use(&source) {
        OperationError::InUse { path }
    } else {
        OperationError::Io { path, source }
    }
}

/// Renames without replacing anything, retrying while another program holds the item
/// (antivirus, indexers, Explorer previews), like the metadata writes (library-core §4.3).
#[cfg(windows)]
fn rename_no_replace(from: &Path, to: &Path) -> io::Result<()> {
    files::retry_transient(|| crate::win::rename_no_replace(from, to))
}

#[cfg(not(windows))]
fn rename_no_replace(_from: &Path, _to: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "entry moves require the Windows adapter",
    ))
}

#[cfg(all(test, windows))]
#[path = "entries_tests.rs"]
mod tests;
