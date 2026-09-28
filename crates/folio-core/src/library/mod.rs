//! The library folder, and the catalog kept in line with it: scans, the metadata mirror and
//! content hashes (docs/specs/library-scan.md).

mod hashing;
mod mirror;
mod plan;
mod rules;
mod walk;

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub use hashing::HashReport;
pub use rules::DEFAULT_IGNORE_RULES;

use crate::catalog::{self, Catalog, CatalogError};
use crate::files;
use crate::fs::{FileSystem, Metadata};
use crate::meta::{
    EntryKind, Layout, MetaError, MetaTree, ScanJournal, StrandedCause, is_folio_owned,
};
use crate::paths::{PathError, RelPath};

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

    /// Walks the library, or `scope` and everything below it, and brings the catalog and the
    /// `.folio/meta/` files in line with it: entries, moves with their tags and settings, and
    /// the metadata mirror (docs/specs/library-scan.md §4–§7). `now_ns` is the current time in
    /// nanoseconds since the Unix epoch, recorded for new entries. Hashes are left to
    /// [`Library::hash_pending`].
    pub fn scan(
        &self,
        catalog: &Catalog,
        scope: Option<&RelPath>,
        now_ns: i64,
    ) -> Result<ScanReport, LibraryError> {
        let config = self
            .layout
            .read_library()?
            .ok_or_else(|| LibraryError::NotALibrary {
                path: self.layout.library_file(),
            })?;
        let scope = match scope {
            Some(scope) if is_folio_owned(scope) => return Ok(ScanReport::default()),
            Some(scope) => self.widen(catalog, scope)?,
            None => None,
        };
        let mut problems = Vec::new();
        let rules = rules::Rules::load(&self.layout, &mut problems)?;
        let snapshot = walk::walk(
            &*self.fs,
            self.root(),
            &rules,
            scope.as_ref(),
            &mut problems,
        )?;
        let (changes, journal) = catalog.write_with(|tx| -> Result<_, LibraryError> {
            let mut tree = self.read_meta(tx)?;
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
            catalog::apply_changes(tx, &plan.entries)?;
            if let Some(id) = &journal {
                catalog::set_committed_scan_journal(tx, id)?;
            }
            if first {
                catalog::set_first_scan(tx, now_ns)?;
            }
            mirror::mirror(tx, &tree, self.root(), &mut problems)?;
            Ok((plan.changes, journal))
        })?;
        if journal.is_some()
            && let Err(error) = ScanJournal::remove(&self.layout)
        {
            // The catalog committed: the next scan finds the journal settled and removes it.
            problems.push(Problem::metadata(self.root(), &error));
        }
        Ok(ScanReport { changes, problems })
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

    /// Brings the catalog's copy of `.folio/` in line with the files, for example after they
    /// changed outside Folio; every scan does this too.
    pub fn sync_metadata(&self, catalog: &Catalog) -> Result<Vec<Problem>, LibraryError> {
        catalog.write_with(|tx| {
            let tree = self.read_meta(tx)?;
            let mut problems = Vec::new();
            mirror::mirror(tx, &tree, self.root(), &mut problems)?;
            Ok(problems)
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

#[cfg(test)]
mod tests;
