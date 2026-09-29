//! The library folder, and the catalog kept in line with it: scans, the metadata mirror and
//! content hashes (docs/specs/library-scan.md).

mod hashing;
mod mirror;
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
pub use rules::DEFAULT_IGNORE_RULES;

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

    /// Returns `None` when cancelled before writing. Progress counts visited entries; the
    /// total is unknown while walking. Once the write starts, journal and catalog work finish
    /// without cancellation. Callers serialize scans so snapshots cannot commit out of order.
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
        state::validate_metadata(self.root())?;
        let config = self
            .layout
            .read_library()?
            .ok_or_else(|| LibraryError::NotALibrary {
                path: self.layout.library_file(),
            })?;
        let scope = match scope {
            Some(scope) if is_folio_owned(scope) => return Ok(Some(CommittedScan::default())),
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
            return Ok(None);
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
            return Ok(None);
        };
        if journal.is_some()
            && let Err(error) = self.finish_journal(catalog)
        {
            // Another scan may have run since this commit. Settle its journal under the writer
            // mutex too; never delete an uncommitted writer's journal after releasing that lock.
            let problem = match error {
                LibraryError::Meta(error) => Problem::metadata(self.root(), &error),
                error => Problem::Metadata {
                    file: ".folio/local/journal/scan.json".to_owned(),
                    failure: MetadataFailure::Unreadable(ReadFailure::Other),
                    detail: error.to_string(),
                },
            };
            committed.report.problems.push(problem);
        }
        Ok(Some(committed))
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
        // A new catalog knows no paths to go back to: the files stay as the scan left them,
        // and a journal that cannot be read does not stand in the way of a rebuild.
        if catalog::has_no_entries(tx)? {
            return Ok(ScanJournal::remove(&self.layout)?);
        }
        let Some(journal) = ScanJournal::read(&self.layout)? else {
            return Ok(());
        };
        if catalog::committed_scan_journal(tx)?.as_deref() == Some(journal.id()) {
            ScanJournal::remove(&self.layout)?;
        } else {
            journal.undo(&self.layout)?;
        }
        Ok(())
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
        catalog.write_with(|tx| {
            if cancel.load(Ordering::Relaxed) {
                return Ok(None);
            }
            let tree = self.read_meta(tx)?;
            let mut problems = Vec::new();
            let mirrored = mirror::mirror(tx, &tree, self.root(), &mut problems)?;
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
            Ok(Some(committed))
        })
    }

    /// Settles recoverable metadata writes before clearing derived rows. The same catalog
    /// remains usable by readers, and the next scan rebuilds it with fresh entry identities.
    pub fn reset_catalog(&self, catalog: &Catalog) -> Result<(), LibraryError> {
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
