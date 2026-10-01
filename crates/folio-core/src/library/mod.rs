//! The library folder, and the catalog kept in line with it: scans, the metadata mirror and
//! content hashes (docs/specs/library-scan.md).

mod hashing;
mod mirror;
pub mod operations;
mod plan;
mod rules;
pub mod state;
mod walk;

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

pub use hashing::HashReport;
pub use rules::{DEFAULT_IGNORE_RULES, invalid_ignore_lines};

use crate::catalog::{self, Catalog, CatalogError, EntryId};
use crate::files;
use crate::fs::{FileSystem, Metadata};
use crate::meta::{
    EntryKind, Layout, MetaError, MetaTree, ScanJournal, StrandedCause, is_folio_owned,
};
use crate::paths::{PathError, RelPath};
use crate::watch::Rescan;

/// One library: its folder, its `.folio/` files and the adapter that reads its files. The
/// shell passes the library's catalog to each call.
pub struct Library {
    layout: Layout,
    fs: Arc<dyn FileSystem>,
}

#[derive(Debug, thiserror::Error)]
pub enum LibraryError {
    #[error("could not list the library folder {}: {source}", path.display())]
    Root {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{} is missing, so this folder is not a Folio library", path.display())]
    NotALibrary { path: PathBuf },
    #[error(transparent)]
    Meta(#[from] MetaError),
    #[error(transparent)]
    Catalog(#[from] CatalogError),
}

/// A change a scan made to the catalog.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
pub enum Change {
    Added(RelPath),
    /// Its size, modification time or file id changed, so its content may have too.
    Modified(RelPath),
    Moved {
        from: RelPath,
        to: RelPath,
    },
    Removed(RelPath),
}

/// Something the user should know about; the scan went on (docs/specs/library-scan.md §9).
/// `detail` strings are for logs; the UI words each case from its variant.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Problem {
    /// A name that is not valid Unicode, left out with everything below it.
    NotUnicode {
        folder: Option<RelPath>,
        name: String,
    },
    /// A name Windows does not allow, left out with everything below it.
    InvalidName {
        folder: Option<RelPath>,
        name: String,
        error: PathError,
    },
    /// A name in another Unicode normalization form than NFC, left out with everything below it
    /// until it is renamed. `twin`: the NFC form of the name is there too.
    NotNfc {
        folder: Option<RelPath>,
        name: String,
        twin: bool,
    },
    /// Names in one folder that differ only in case. All of them are in the catalog.
    CaseTwins { paths: Vec<RelPath> },
    /// A symbolic link or a junction, never followed.
    Link {
        folder: Option<RelPath>,
        name: String,
    },
    /// Neither a file nor a folder.
    Special {
        folder: Option<RelPath>,
        name: String,
    },
    /// A folder that could not be listed, whose catalog entries stay as they were, or a file
    /// that could not be read.
    Unreadable {
        path: RelPath,
        failure: ReadFailure,
        detail: String,
    },
    /// A line of `.folio/ignore` (`file` is `None`) or of a `.gitignore` that is not a valid
    /// pattern; the other lines apply. Line 0 is the whole file.
    InvalidIgnoreRule {
        file: Option<RelPath>,
        line: usize,
        detail: String,
    },
    /// A metadata file (its path below the library, with `/`) that could not be read. None of
    /// its content changes the catalog, which keeps what the file gave it before.
    Metadata {
        file: String,
        failure: MetadataFailure,
        detail: String,
    },
    /// Settings or tags in `.folio/meta/` for a semester or course folder that does not exist.
    OrphanedMetadata { folder: RelPath },
    /// Tags or settings that could not follow a moved entry.
    NotRelocated {
        from: RelPath,
        to: RelPath,
        cause: StrandedCause,
    },
}

/// Why a file or folder could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadFailure {
    /// Access is denied.
    Denied,
    /// Another program holds it open.
    InUse,
    /// It is larger than Folio reads.
    TooLarge,
    /// Anything else; the detail says what.
    Other,
}

impl ReadFailure {
    fn of(error: &io::Error) -> Self {
        if files::is_in_use(error) {
            Self::InUse
        } else if error.kind() == io::ErrorKind::PermissionDenied {
            Self::Denied
        } else {
            Self::Other
        }
    }
}

/// Why a metadata file could not be read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetadataFailure {
    /// A newer Folio wrote it: the metadata is read-only until Folio is updated.
    Newer,
    /// It is not a valid metadata file.
    Invalid,
    Unreadable(ReadFailure),
}

impl Problem {
    fn unreadable(path: RelPath, error: &io::Error) -> Self {
        Self::Unreadable {
            path,
            failure: ReadFailure::of(error),
            detail: error.to_string(),
        }
    }

    fn metadata(root: &Path, error: &MetaError) -> Self {
        let (path, failure) = match error {
            MetaError::NewerFormat { path, .. } => (Some(path), MetadataFailure::Newer),
            MetaError::Invalid { path, .. } => (Some(path), MetadataFailure::Invalid),
            MetaError::TooLarge { path } => (
                Some(path),
                MetadataFailure::Unreadable(ReadFailure::TooLarge),
            ),
            MetaError::Io { path, source } => (
                Some(path),
                MetadataFailure::Unreadable(ReadFailure::of(source)),
            ),
            MetaError::NameTooLong { .. } | MetaError::Random(_) => {
                (None, MetadataFailure::Unreadable(ReadFailure::Other))
            }
        };
        let file = path.map_or_else(String::new, |path| match path.strip_prefix(root) {
            Ok(below) => below
                .iter()
                .map(|name| name.to_string_lossy())
                .collect::<Vec<_>>()
                .join("/"),
            Err(_) => path.display().to_string(),
        });
        Self::Metadata {
            file,
            failure,
            detail: error.to_string(),
        }
    }
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ScanReport {
    pub changes: Vec<Change>,
    pub problems: Vec<Problem>,
}

/// Which filesystem problems this committed pass replaced. Every non-ignored pass also
/// refreshes metadata problems across the library, including a scoped filesystem scan.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub enum ScanCoverage {
    Full,
    Scope(RelPath),
    Metadata,
    #[default]
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum EntryChangeKind {
    Added,
    Modified,
    Removed,
    Moved { from: RelPath },
    Tagged,
}

/// A committed entry identity; removals carry the former path and identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EntryChange {
    pub id: EntryId,
    pub path: RelPath,
    pub kind: EntryChangeKind,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CommittedScan {
    pub coverage: ScanCoverage,
    pub report: ScanReport,
    pub entries: Vec<EntryChange>,
    pub tags: bool,
    pub groups: bool,
    pub read_only: bool,
}

impl CommittedScan {
    pub fn changed(&self) -> bool {
        !self.entries.is_empty() || self.tags || self.groups
    }
}

impl Library {
    pub fn new(root: impl Into<PathBuf>, fs: Arc<dyn FileSystem>) -> Self {
        Self {
            layout: Layout::new(root),
            fs,
        }
    }

    pub fn root(&self) -> &Path {
        self.layout.root()
    }

    pub fn layout(&self) -> &Layout {
        &self.layout
    }

    /// Walks the library, or `scope` and everything below it (the folder of a `.gitignore` or
    /// `pyvenv.cfg`), and brings the catalog and the `.folio/meta/` files in line with it:
    /// entries, moves with their tags and settings, and the metadata mirror
    /// (docs/specs/library-scan.md §4–§7). `now_ns` is the current time in
    /// nanoseconds since the Unix epoch, recorded for new entries. Hashes are left to
    /// [`Library::hash_pending`].
    pub fn scan(
        &self,
        catalog: &Catalog,
        scope: Option<&RelPath>,
        now_ns: i64,
    ) -> Result<ScanReport, LibraryError> {
        Ok(self
            .scan_with_control(catalog, scope, now_ns, &AtomicBool::new(false), &mut |_| {})?
            .map_or_else(ScanReport::default, |committed| committed.report))
    }

    /// Returns `None` when cancelled before writing, or a recovery-only report if recovery
    /// already committed. Publish recovery separately before work that might fail; `rescan`
    /// does this through its callback. Progress counts visited entries; the total is unknown
    /// while walking. Once writing starts, journal and catalog work finish without cancellation.
    /// Callers serialize scans so snapshots cannot commit out of order.
    pub fn scan_with_control(
        &self,
        catalog: &Catalog,
        scope: Option<&RelPath>,
        now_ns: i64,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
    ) -> Result<Option<CommittedScan>, LibraryError> {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let mut recovered = self.recover_pending(catalog)?;
        state::validate_metadata(self.root())?;
        let config = self
            .layout
            .read_library()?
            .ok_or_else(|| LibraryError::NotALibrary {
                path: self.layout.library_file(),
            })?;
        let scope = match scope {
            Some(scope) if is_folio_owned(scope) => return Ok(Some(recovered)),
            // A rules file decides what its folder keeps.
            Some(scope) if rules::is_rules_file(scope.name()) => match scope.parent() {
                Some(folder) => self.widen(catalog, &folder)?,
                None => None,
            },
            Some(scope) => self.widen(catalog, scope)?,
            None => None,
        };
        let mut problems = Vec::new();
        let rules = rules::Rules::load(&self.layout, &mut problems)?;
        let Some(snapshot) = walk::walk(
            &*self.fs,
            self.root(),
            &rules,
            scope.as_ref(),
            &mut problems,
            cancel,
            progress,
        )?
        else {
            return Ok(recovered.completed_recovery());
        };
        let Some((mut committed, journal)) =
            catalog.write_with(|tx| -> Result<_, LibraryError> {
                if cancel.load(Ordering::Relaxed) {
                    return Ok(None);
                }
                let mut tree = self.read_meta(tx)?;
                let read_only = tree.is_read_only();
                // A catalog no scan has committed to, a new library's or a rebuilt one, dates entries
                // by their files; later scans by when they first saw them (docs/specs/library-scan.md
                // §6.3).
                let first = !catalog::was_scanned(tx)?;
                let added_ns = |metadata: &Metadata| {
                    let created = metadata.created_ns.or(metadata.modified_ns);
                    if first {
                        created.map_or(now_ns, |created| created.min(now_ns))
                    } else {
                        now_ns
                    }
                };
                let current = catalog::entries_in(tx, scope.as_ref())?;
                let before: HashMap<_, _> = current
                    .iter()
                    .map(|entry| (entry.id, (entry.record.path.clone(), entry.record.kind)))
                    .collect();
                let plan = plan::plan(&snapshot, current, &config.versioning, added_ns);
                // The metadata files first, then the catalog (ADR-0002 §1), with a journal in
                // between (§7.1).
                for stranded in tree.relocate(&plan.moves) {
                    problems.push(Problem::NotRelocated {
                        from: stranded.from,
                        to: stranded.to,
                        cause: stranded.cause,
                    });
                }
                let journal = tree.save(&self.layout)?;
                let added_ids = catalog::apply_changes(tx, &plan.entries)?;
                if let Some(id) = &journal {
                    catalog::set_committed_scan_journal(tx, id)?;
                }
                if first {
                    catalog::set_first_scan(tx, now_ns)?;
                }
                let mirrored = mirror::mirror(tx, &tree, self.root(), &mut problems)?;
                let mut committed = CommittedScan {
                    coverage: scope
                        .clone()
                        .map_or(ScanCoverage::Full, ScanCoverage::Scope),
                    tags: mirrored.tags,
                    groups: mirrored.groups,
                    read_only,
                    ..CommittedScan::default()
                };
                for (id, path) in &plan.entries.removed {
                    committed.entries.push(EntryChange {
                        id: *id,
                        path: path.clone(),
                        kind: EntryChangeKind::Removed,
                    });
                    committed.groups |= before
                        .get(id)
                        .is_some_and(|(path, kind)| is_group(path, *kind));
                }
                for (id, path) in &plan.entries.moved {
                    let (from, kind) = before.get(id).ok_or(CatalogError::NoEntry(*id))?;
                    committed.groups |= is_group(from, *kind) || is_group(path, *kind);
                    committed.entries.push(EntryChange {
                        id: *id,
                        path: path.clone(),
                        kind: EntryChangeKind::Moved { from: from.clone() },
                    });
                }
                for (id, (record, _)) in added_ids.into_iter().zip(&plan.entries.added) {
                    committed.groups |= is_group(&record.path, record.kind);
                    committed.entries.push(EntryChange {
                        id,
                        path: record.path.clone(),
                        kind: EntryChangeKind::Added,
                    });
                }
                for (id, record) in &plan.entries.updated {
                    committed.entries.push(EntryChange {
                        id: *id,
                        path: record.path.clone(),
                        kind: EntryChangeKind::Modified,
                    });
                }
                committed.add_tagged(tx, mirrored.tagged)?;
                committed.report = ScanReport {
                    changes: plan.changes,
                    problems,
                };
                Ok(Some((committed, journal)))
            })?
        else {
            return Ok(recovered.completed_recovery());
        };
        if journal.is_some()
            && let Err(error) = self.finish_journal(catalog)
        {
            // Another scan may have run since this commit. Settle its journal under the writer
            // mutex too; never delete an uncommitted writer's journal after releasing that lock.
            committed.report.problems.push(self.journal_problem(error));
        }
        recovered.merge(committed);
        Ok(Some(recovered))
    }

    /// The problem to report when a committed change could not remove its journal.
    fn journal_problem(&self, error: LibraryError) -> Problem {
        match error {
            LibraryError::Meta(error) => Problem::metadata(self.root(), &error),
            error => Problem::Metadata {
                file: ".folio/local/journal/scan.json".to_owned(),
                failure: MetadataFailure::Unreadable(ReadFailure::Other),
                detail: error.to_string(),
            },
        }
    }

    /// Mirrors `tree` into the catalog as a metadata commit that reports `problems` too.
    fn mirror_commit(
        &self,
        tx: &rusqlite::Connection,
        tree: &MetaTree,
        mut problems: Vec<Problem>,
    ) -> Result<CommittedScan, CatalogError> {
        let mirrored = mirror::mirror(tx, tree, self.root(), &mut problems)?;
        let mut committed = CommittedScan {
            coverage: ScanCoverage::Metadata,
            report: ScanReport {
                changes: Vec::new(),
                problems,
            },
            tags: mirrored.tags,
            groups: mirrored.groups,
            read_only: tree.is_read_only(),
            ..CommittedScan::default()
        };
        committed.add_tagged(tx, mirrored.tagged)?;
        Ok(committed)
    }

    fn finish_journal(&self, catalog: &Catalog) -> Result<(), LibraryError> {
        catalog.with_writer(|tx| self.settle_journal(tx))
    }

    /// Reads `.folio/meta/` as the catalog knows it: an interrupted scan's journal is settled
    /// first. Everything that reads the metadata files into the catalog goes through here.
    fn read_meta(&self, tx: &rusqlite::Connection) -> Result<MetaTree, LibraryError> {
        self.settle_journal(tx)?;
        Ok(MetaTree::read(&self.layout)?)
    }

    /// Settles the journal of an earlier scan that changed metadata files: if its catalog
    /// update never committed, the files go back to what they held, so that what reads them
    /// next starts from the state the catalog knows (docs/specs/library-scan.md §7.1).
    fn settle_journal(&self, tx: &rusqlite::Connection) -> Result<(), LibraryError> {
        state::validate_metadata(self.root())?;
        let Some(journal) = ScanJournal::read(&self.layout)? else {
            return Ok(());
        };
        if catalog::committed_scan_journal(tx)?.as_deref() == Some(journal.id()) {
            ScanJournal::remove(&self.layout)?;
        } else if journal.moved().is_some() {
            // Operations must reconcile in their own transaction before another writer can
            // publish a new journal. Never erase an intent inside an uncommitted writer.
            return Err(self.recovery_error("a pending explicit move needs reconciliation"));
        } else if catalog::has_no_entries(tx)? {
            ScanJournal::remove(&self.layout)?;
        } else {
            journal.undo(&self.layout)?;
        }
        Ok(())
    }

    fn recovery_error(&self, reason: impl Into<String>) -> LibraryError {
        MetaError::Invalid {
            path: self.layout.scan_journal_file(),
            reason: reason.into(),
        }
        .into()
    }

    fn recovery_metadata_error(&self, error: MetaError) -> LibraryError {
        if matches!(error, MetaError::Invalid { .. }) {
            self.recovery_error(error.to_string())
        } else {
            error.into()
        }
    }

    /// Reconciles a durable in-app move before a scan's disk walk or another operation.
    /// The caller serializes the whole call with scans/operations and publishes this report
    /// immediately, even if its subsequent scan or operation fails or is cancelled.
    pub fn recover_pending(&self, catalog: &Catalog) -> Result<CommittedScan, LibraryError> {
        // Most calls find no journal: skip the writer transaction and the metadata checks. Only
        // writers serialized with this call publish one, and anything else gets the full path.
        if std::fs::symlink_metadata(self.layout.scan_journal_file())
            .is_err_and(|error| error.kind() == io::ErrorKind::NotFound)
        {
            return Ok(CommittedScan::default());
        }
        let mut report = catalog.write_with(|tx| -> Result<_, LibraryError> {
            state::validate_metadata(self.root())?;
            let Some(journal) = ScanJournal::read(&self.layout)? else {
                return Ok(CommittedScan::default());
            };
            if catalog::committed_scan_journal(tx)?.as_deref() == Some(journal.id()) {
                return Ok(CommittedScan::default());
            }
            let Some((from, to)) = journal.moved() else {
                self.settle_journal(tx)?;
                return Ok(CommittedScan::default());
            };
            let source = self.exact_disk_entry(from)?;
            let destination = self.exact_disk_entry(to)?;
            let completed = match (source.is_some(), destination.is_some()) {
                (true, false) => false,
                (false, true) => true,
                _ => {
                    return Err(
                        self.recovery_error("move source/destination are conflicting or absent")
                    );
                }
            };
            let explicit = journal.move_entries();
            let legacy = explicit.is_none();
            let snapshots = match explicit {
                Some(entries) => entries,
                None => {
                    // Legacy v2 stored only the pair. Existing catalog identities and their
                    // metadata still provide a guarded migration path; never guess missing IDs.
                    let entries = catalog::entries_in(tx, Some(from))?;
                    if entries.is_empty() {
                        return Err(self.recovery_error("legacy move has no catalog identity"));
                    }
                    let mut snapshots = Vec::new();
                    for entry in entries {
                        let target = match entry.record.path.strip_prefix(from) {
                            Some(tail) => to
                                .join(&tail)
                                .map_err(|error| self.recovery_error(error.to_string()))?,
                            None => to.clone(),
                        };
                        let disk = Metadata {
                            kind: if entry.record.kind == EntryKind::File {
                                crate::fs::FileKind::File
                            } else {
                                crate::fs::FileKind::Folder
                            },
                            size: entry.record.size,
                            modified_ns: entry.record.mtime_ns,
                            created_ns: None,
                            file_id: entry.record.file_id.clone(),
                            presence: crate::fs::Presence::Local,
                        };
                        snapshots.push((entry, target, disk));
                    }
                    snapshots
                }
            };
            let allowed: std::collections::HashSet<_> =
                snapshots.iter().map(|(entry, _, _)| entry.id).collect();
            let current_subtree = catalog::entries_in(tx, Some(from))?;
            if current_subtree.len() != snapshots.len()
                || current_subtree
                    .iter()
                    .any(|entry| !allowed.contains(&entry.id))
            {
                return Err(self.recovery_error("move catalog subtree conflicts with the journal"));
            }
            for (entry, target, expected) in &snapshots {
                if entry.record.kind == EntryKind::Folder
                    && entry.record.path.depth() == 1
                    && target.depth() != 1
                {
                    return Err(self.recovery_error("a semester move changes its hierarchy"));
                }
                let path = if completed {
                    target
                } else {
                    &entry.record.path
                };
                let actual = self
                    .exact_disk_entry(path)?
                    .ok_or_else(|| self.recovery_error("move subtree is incomplete"))?;
                if actual.kind != expected.kind
                    || actual.size != expected.size
                    || actual.modified_ns != expected.modified_ns
                    || (!legacy && actual.created_ns != expected.created_ns)
                    || expected
                        .file_id
                        .as_ref()
                        .is_some_and(|id| actual.file_id.as_ref() != Some(id))
                {
                    return Err(self.recovery_error("move subtree identity no longer matches"));
                }
                let current = catalog::entry_by_id(tx, entry.id)?
                    .ok_or_else(|| self.recovery_error("move catalog identity is missing"))?;
                if current != *entry {
                    return Err(
                        self.recovery_error("move catalog identity conflicts with the journal")
                    );
                }
            }
            let mut report = CommittedScan {
                coverage: ScanCoverage::Metadata,
                ..CommittedScan::default()
            };
            if completed {
                // Prior v2 journals lack after-images. They can reconnect a completed move
                // from existing catalog/disk identities, without modifying authored bytes.
                if !legacy || journal.has_after_images() {
                    journal
                        .validate_images(true)
                        .map_err(|error| self.recovery_metadata_error(error))?;
                }
                for (_, target, _) in &snapshots {
                    if catalog::entries_with_key(tx, &target.key())?
                        .iter()
                        .any(|entry| !allowed.contains(&entry.id))
                    {
                        return Err(
                            self.recovery_error("move destination catalog identity is occupied")
                        );
                    }
                }
                let config = self
                    .layout
                    .read_library()?
                    .ok_or_else(|| self.recovery_error("library settings are missing"))?;
                let mut changes = catalog::EntryChanges::default();
                for (entry, target, _) in &snapshots {
                    changes.moved.push((entry.id, target.clone()));
                    let mut record = entry.record.clone();
                    record.path = target.clone();
                    if entry.record.path == *from && record.kind == EntryKind::File {
                        record.class = config.versioning.class_of(target);
                    }
                    changes.updated.push((entry.id, record));
                    report.push_moved(entry.id, &entry.record.path, target, entry.record.kind);
                }
                catalog::apply_changes(tx, &changes)?;
            } else {
                journal
                    .validate_images(false)
                    .map_err(|error| self.recovery_metadata_error(error))?;
                journal
                    .restore(&self.layout)
                    .map_err(|error| self.recovery_metadata_error(error))?;
            }
            // The journal remains durable until the marker and all derived rows COMMIT.
            let tree = MetaTree::read(&self.layout)?;
            report.merge(self.mirror_commit(tx, &tree, Vec::new())?);
            catalog::set_committed_scan_journal(tx, journal.id())?;
            Ok(report)
        })?;
        // Cleanup failure does not invalidate a committed recovery or discard its report.
        if let Err(error) = self.finish_journal(catalog) {
            if report.coverage == ScanCoverage::None {
                report.read_only = MetaTree::read(&self.layout)?.is_read_only();
                report.coverage = ScanCoverage::Metadata;
            }
            report.report.problems.push(self.journal_problem(error));
        }
        Ok(report)
    }

    fn exact_disk_entry(&self, path: &RelPath) -> Result<Option<Metadata>, LibraryError> {
        let mut parent = self.root().to_owned();
        let names: Vec<_> = path.names().collect();
        for (index, name) in names.iter().enumerate() {
            let entries = self.fs.read_dir(&parent).map_err(|error| {
                self.recovery_error(format!("cannot inspect move path: {error}"))
            })?;
            let Some(entry) = entries
                .into_iter()
                .find(|entry| entry.name.to_str() == Some(*name))
            else {
                return Ok(None);
            };
            parent.push(name);
            let metadata = self.fs.metadata(&parent).map_err(|error| {
                self.recovery_error(format!("cannot inspect move identity: {error}"))
            })?;
            if metadata.kind != entry.metadata.kind {
                return Err(self.recovery_error("move path changed during inspection"));
            }
            if index + 1 == names.len() {
                return Ok(Some(metadata));
            }
            if metadata.kind != crate::fs::FileKind::Folder {
                return Err(self.recovery_error("move path contains a link or special entry"));
            }
        }
        Err(self.recovery_error("empty move path"))
    }

    /// Carries out a watcher's rescan (docs/specs/windows-adapter.md §5.4): a scan of the whole
    /// library, a scan of each scope, or a metadata sync. Each report goes to `on_report` with its
    /// scope, `None` for the whole library, as soon as its scan commits. The first error stops
    /// the rest; a full rescan later makes up for them.
    pub fn rescan(
        &self,
        catalog: &Catalog,
        rescan: &Rescan,
        now_ns: i64,
        on_report: &mut dyn FnMut(Option<&RelPath>, ScanReport),
    ) -> Result<(), LibraryError> {
        self.rescan_with_control(
            catalog,
            rescan,
            now_ns,
            &AtomicBool::new(false),
            &mut |_| {},
            &mut |committed| {
                let scope = match &committed.coverage {
                    ScanCoverage::Scope(scope) => Some(scope),
                    _ => None,
                };
                on_report(scope, committed.report);
            },
        )?;
        Ok(())
    }

    /// As `rescan`, with cancellation and committed identities. `false` means a pass was
    /// cancelled; reports already delivered remain committed.
    pub fn rescan_with_control(
        &self,
        catalog: &Catalog,
        rescan: &Rescan,
        now_ns: i64,
        cancel: &AtomicBool,
        progress: &mut dyn FnMut(u64),
        on_report: &mut dyn FnMut(CommittedScan),
    ) -> Result<bool, LibraryError> {
        if let Some(recovered) = self.recover_pending(catalog)?.completed_recovery() {
            on_report(recovered);
        }
        match rescan {
            Rescan::Full => {
                let Some(report) =
                    self.scan_with_control(catalog, None, now_ns, cancel, progress)?
                else {
                    return Ok(false);
                };
                on_report(report);
            }
            Rescan::Scopes(scopes) => {
                for scope in scopes {
                    let Some(report) =
                        self.scan_with_control(catalog, Some(scope), now_ns, cancel, progress)?
                    else {
                        return Ok(false);
                    };
                    on_report(report);
                }
            }
            Rescan::Metadata => {
                let Some(report) = self.sync_metadata_with_control(catalog, cancel)? else {
                    return Ok(false);
                };
                on_report(report);
            }
        }
        Ok(true)
    }

    /// Brings the catalog's copy of `.folio/` in line with the files, for example after they
    /// changed outside Folio; every scan does this too.
    pub fn sync_metadata(&self, catalog: &Catalog) -> Result<Vec<Problem>, LibraryError> {
        Ok(self
            .sync_metadata_with_control(catalog, &AtomicBool::new(false))?
            .map_or_else(Vec::new, |committed| committed.report.problems))
    }

    pub fn sync_metadata_with_control(
        &self,
        catalog: &Catalog,
        cancel: &AtomicBool,
    ) -> Result<Option<CommittedScan>, LibraryError> {
        if cancel.load(Ordering::Relaxed) {
            return Ok(None);
        }
        let mut recovered = self.recover_pending(catalog)?;
        let report = catalog.write_with(|tx| -> Result<_, LibraryError> {
            if cancel.load(Ordering::Relaxed) {
                return Ok(None);
            }
            let tree = self.read_meta(tx)?;
            Ok(Some(self.mirror_commit(tx, &tree, Vec::new())?))
        })?;
        match report {
            Some(report) => {
                recovered.merge(report);
                Ok(Some(recovered))
            }
            None => Ok(recovered.completed_recovery()),
        }
    }

    /// Settles recoverable metadata writes before clearing derived rows. The same catalog
    /// remains usable by readers, and the next scan rebuilds it with fresh entry identities.
    pub fn reset_catalog(&self, catalog: &Catalog) -> Result<(), LibraryError> {
        self.recover_pending(catalog)?;
        catalog.write_with(|tx| {
            self.settle_journal(tx)?;
            catalog::reset_for_rebuild(tx)?;
            Ok(())
        })
    }

    /// `scope` if the catalog knows it, else its nearest folder that it knows, so that every
    /// entry the scan adds has its parent; `None` is the whole library.
    fn widen(&self, catalog: &Catalog, scope: &RelPath) -> Result<Option<RelPath>, CatalogError> {
        catalog.read(|tx| {
            for path in scope.ancestors() {
                if catalog::entry(tx, &path)?
                    .is_some_and(|entry| path == *scope || entry.record.kind == EntryKind::Folder)
                {
                    return Ok(Some(path));
                }
            }
            Ok(None)
        })
    }
}

impl CommittedScan {
    fn completed_recovery(self) -> Option<Self> {
        (self.coverage != ScanCoverage::None || !self.report.problems.is_empty()).then_some(self)
    }

    fn merge(&mut self, report: Self) {
        if report.coverage != ScanCoverage::None {
            self.coverage = report.coverage;
        }
        self.entries.extend(report.entries);
        self.tags |= report.tags;
        self.groups |= report.groups;
        self.read_only |= report.read_only;
        self.report.changes.extend(report.report.changes);
        self.report.problems.extend(report.report.problems);
    }

    /// Reports that entry `id`, a `kind`, moved from `from` to `to`.
    fn push_moved(&mut self, id: EntryId, from: &RelPath, to: &RelPath, kind: EntryKind) {
        self.groups |= is_group(from, kind) || is_group(to, kind);
        self.entries.push(EntryChange {
            id,
            path: to.clone(),
            kind: EntryChangeKind::Moved { from: from.clone() },
        });
        self.report.changes.push(Change::Moved {
            from: from.clone(),
            to: to.clone(),
        });
    }

    fn add_tagged(
        &mut self,
        tx: &rusqlite::Connection,
        ids: Vec<EntryId>,
    ) -> Result<(), CatalogError> {
        for id in ids {
            let entry = catalog::entry_by_id(tx, id)?.ok_or(CatalogError::NoEntry(id))?;
            self.entries.push(EntryChange {
                id,
                path: entry.record.path,
                kind: EntryChangeKind::Tagged,
            });
        }
        Ok(())
    }
}

fn is_group(path: &RelPath, kind: EntryKind) -> bool {
    kind == EntryKind::Folder && path.depth() <= 2
}

#[cfg(test)]
mod tests;
