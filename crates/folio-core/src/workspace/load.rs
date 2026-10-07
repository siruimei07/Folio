//! Loading the workspace from the catalog (versioning.md §6): the read that the pure model of this
//! module's parent derives everything from.
//!
//! [`Workspace::load`] reads in one stamped read what may differ between `HEAD`'s tree and the disk
//! ([`head_files::comparison`]) and, while `HEAD`'s metadata reads, the disk's side of the metadata:
//! the catalog's mirror, with the pairing of the entries and folders it follows. The disk's
//! `library.json`, `.folio/ignore` and the metadata files that cannot be read come from the disk
//! (lane decision 11), after the check for links every reader of the metadata makes; a digest of
//! them is kept in the catalog (`info`'s `workspace_disk_files`) and written when it changes, so
//! that they move the catalog revision too. When the read finds a row without an entry and an
//! entry without a row that pair by path (§6.1,
//! [`Comparison::pairable`](super::Comparison::pairable)), it pairs them and reads again. The
//! snapshot carries the catalog revision of its read (§6.5): two loads at one revision read the
//! same rows and the same files.

use std::sync::atomic::AtomicBool;

use super::Workspace;
use super::head::{Cancel, HeadState};
use super::meta::{DiskMeta, OnDisk};
use crate::catalog::head_files::{self, group_folders, history_marks};
use crate::catalog::{Catalog, CatalogError, ReadStamp, all_courses, semesters, tag_definitions};
use crate::library::state::validate_metadata;
use crate::meta::{Layout, MetaError, MetaTree, TagFile, VersioningRules};

/// The workspace at one catalog revision.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    /// The catalog revision of the read it comes from.
    pub stamp: ReadStamp,
    pub workspace: Workspace,
}

impl Snapshot {
    /// A workspace that lists nothing, at the catalog's current revision.
    pub fn empty(catalog: &Catalog) -> Result<Self, CatalogError> {
        let stamp = catalog.read_stamped(|_, stamp| Ok::<_, CatalogError>(stamp))?;
        Ok(Self {
            stamp,
            workspace: Workspace::empty(),
        })
    }
}

/// Why the workspace could not be loaded.
#[derive(Debug, thiserror::Error)]
pub enum LoadError {
    #[error(transparent)]
    Catalog(#[from] CatalogError),
    /// `.folio/` holds a link, or `.folio/meta/` could not be listed.
    #[error(transparent)]
    Meta(#[from] MetaError),
    /// The catalog holds another `HEAD` than the head state names: a head sync is due.
    #[error("the catalog holds another HEAD than the one the workspace was loaded for")]
    HeadChanged,
    #[error("the workspace's computation was cancelled")]
    Cancelled,
}

/// What the disk's `.folio/` gives that the catalog does not mirror.
struct DiskFiles {
    library: OnDisk<crate::meta::LibraryConfig>,
    ignore: OnDisk<Option<String>>,
    broken: Vec<TagFile>,
    /// `tags.json` cannot be read: the mirror's definitions are stale.
    definitions_broken: bool,
}

impl DiskFiles {
    fn read(layout: &Layout) -> Result<Self, MetaError> {
        // Links in `.folio/` are refused before anything there is read, as by every reader of
        // the metadata.
        validate_metadata(layout.root())?;
        let tree = MetaTree::read(layout)?;
        Ok(Self {
            library: match layout.read_library() {
                Ok(Some(library)) => OnDisk::Read(library),
                // Without `library.json` the folder is no library, and its settings keep their
                // committed content like any file that cannot be read.
                Ok(None) | Err(_) => OnDisk::Unreadable,
            },
            ignore: layout
                .read_ignore()
                .map_or(OnDisk::Unreadable, OnDisk::Read),
            broken: tree.broken().keys().cloned().collect(),
            definitions_broken: matches!(tree.tag_definitions(), Some(Err(_))),
        })
    }

    /// A digest of everything the workspace takes from these files. The load keeps it in the
    /// catalog, so that a change of them moves the catalog revision like a change of the catalog's
    /// own rows, and the pages of one revision agree (versioning.md §6.5, ipc-m1.md §15.2).
    fn digest(&self) -> String {
        let mut broken = self.broken.clone();
        broken.sort_unstable();
        // `Debug` quotes every string, so no two inputs give one text.
        let text = format!(
            "{:?}",
            (&self.library, &self.ignore, broken, self.definitions_broken)
        );
        blake3::hash(text.as_bytes()).to_hex().to_string()
    }

    /// The versioning rules a commit would record, when `HEAD`'s metadata cannot be read: the
    /// disk's, or the defaults when the disk's do not read either.
    fn rules(&self) -> VersioningRules {
        match &self.library {
            OnDisk::Read(library) => library.versioning.clone(),
            OnDisk::Unreadable => VersioningRules::default(),
        }
    }
}

impl Workspace {
    /// The workspace of the library whose `.folio/` `layout` describes, against the `HEAD` that
    /// `head` found (versioning.md §6): nothing while `head_files` holds no tree of it (no
    /// history, a damaged or too large one), the items whenever it does, and the metadata changes
    /// too while `HEAD`'s metadata reads (lane decision 6). `cancel` stops it between its reads,
    /// before each of its writes and before the workspace is derived, so that a library that
    /// closes need not wait for it.
    pub fn load(
        catalog: &Catalog,
        layout: &Layout,
        head: &HeadState,
        cancel: &AtomicBool,
    ) -> Result<Snapshot, LoadError> {
        Self::load_asking(catalog, layout, head, cancel)
    }

    /// [`Workspace::load`], asking `cancel` whether to stop.
    pub(crate) fn load_asking(
        catalog: &Catalog,
        layout: &Layout,
        head: &HeadState,
        cancel: &dyn Cancel,
    ) -> Result<Snapshot, LoadError> {
        let check = || {
            if cancel.cancelled() {
                Err(LoadError::Cancelled)
            } else {
                Ok(())
            }
        };
        if !head.lists_items() {
            return Ok(Snapshot::empty(catalog)?);
        }
        check()?;
        let files = DiskFiles::read(layout)?;
        let digest = files.digest();
        if catalog.read(|tx| head_files::disk_files(tx))?.as_deref() != Some(digest.as_str()) {
            check()?;
            catalog.write(|tx| head_files::set_disk_files(tx, &digest))?;
        }
        let expected = head.head();
        let head_meta = head.meta();
        let read = || {
            catalog.read_stamped(|tx, stamp| -> Result<_, LoadError> {
                if history_marks(tx)?.head != expected {
                    return Err(LoadError::HeadChanged);
                }
                let (comparison, tags) = match head_meta {
                    None => (head_files::comparison(tx)?, Vec::new()),
                    Some(meta) => head_files::comparison_and_tags(tx, meta.tagged())?,
                };
                let disk = match head_meta {
                    None => None,
                    Some(_) => Some(DiskMeta {
                        library: files.library.clone(),
                        definitions: if files.definitions_broken {
                            OnDisk::Unreadable
                        } else {
                            OnDisk::Read(tag_definitions(tx)?)
                        },
                        ignore: files.ignore.clone(),
                        broken: files.broken.clone(),
                        tags,
                        semesters: semesters(tx)?
                            .into_iter()
                            .map(|(semester, settings)| (semester.path().clone(), settings))
                            .collect(),
                        courses: all_courses(tx)?
                            .into_iter()
                            .map(|(course, settings)| (course.path().clone(), settings))
                            .collect(),
                        folders: group_folders(tx)?,
                    }),
                };
                Ok((stamp, comparison, disk))
            })
        };
        check()?;
        let mut found = read()?;
        // Most loads find nothing to pair, and the read tells without the writer.
        if found.1.pairable() {
            check()?;
            catalog.write(|tx| head_files::pair_by_path(tx))?;
            found = read()?;
        }
        check()?;
        let (stamp, comparison, disk) = found;
        let workspace = match (head_meta, disk) {
            (Some(meta), Some(disk)) => Workspace::with_metadata(comparison, meta, &disk),
            _ => Workspace::new(comparison, &files.rules()),
        };
        Ok(Snapshot { stamp, workspace })
    }
}

#[cfg(test)]
mod tests;
