//! Discarding an in-app move that recovery cannot reconcile (docs/specs/library-scan.md §7.1;
//! Sirui's decision of 2026-09-30 in docs/specs/library-state.md).

use super::{Library, LibraryError, state};
use crate::catalog::{self, Catalog};
use crate::fs::FileKind;
use crate::meta::{EntryKind, MetaError, ScanJournal};
use crate::paths::RelPath;

/// What [`Library::discard_move`] let go of.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscardedMove {
    pub from: RelPath,
    pub to: RelPath,
    /// The metadata files the move changed got back what they held before it.
    pub restored: bool,
}

impl Library {
    /// Lets go of the pending in-app move or rename that recovery reports as
    /// [`LibraryError::UnfinishedMove`]. The user's files are never moved, deleted or opened.
    /// The metadata files the move changed get their before-images back only when the item is
    /// still at its source and each of them holds one of the journal's images; otherwise none
    /// of them changes. Then the journal goes, and the caller runs a full scan, which brings
    /// the catalog in line with the disk and the metadata files.
    ///
    /// `None`, changing nothing, when no move is pending: no journal, or a scan's, which the
    /// next scan settles. A failure keeps the journal, and calling again is safe: the images
    /// are checked again, restoring them twice writes the same bytes, and the journal goes last.
    pub fn discard_move(&self, catalog: &Catalog) -> Result<Option<DiscardedMove>, LibraryError> {
        // The writer's lock serializes every writer of `.folio/` (library-scan.md §7.4).
        catalog.with_writer(|tx| {
            state::validate_metadata(self.root())?;
            let Some(journal) = ScanJournal::read(&self.layout)? else {
                return Ok(None);
            };
            let Some((from, to)) = journal.moved() else {
                return Ok(None);
            };
            // A move whose catalog update committed keeps its metadata; only its journal is left.
            let committed = catalog::committed_scan_journal(tx)?.as_deref() == Some(journal.id());
            let unmoved = if committed {
                false
            } else {
                let expected = match journal.move_entries() {
                    // `ScanJournal::read` refuses an intent whose first entry is not the moved
                    // item itself, so that entry is the root.
                    Some(entries) => entries.first().map(|(_, _, disk)| disk.kind),
                    None => catalog::entry(tx, from)?.map(|entry| match entry.record.kind {
                        EntryKind::File => FileKind::File,
                        EntryKind::Folder => FileKind::Folder,
                    }),
                };
                let locations = self.exact_listed_entry(from).and_then(|source| {
                    self.exact_listed_entry(to)
                        .map(|destination| (source, destination))
                });
                match locations {
                    Ok((Some(source), None)) => {
                        matches!(source.kind, FileKind::File | FileKind::Folder)
                            && Some(source.kind) == expected
                    }
                    // A link or another kind on the way: leave the metadata where it is.
                    Ok(_) | Err(LibraryError::UnfinishedMove { .. }) => false,
                    // A folder that cannot be listed: fail rather than guess.
                    Err(error) => return Err(error),
                }
            };
            let restored = unmoved
                && match journal.validate_images(false) {
                    Ok(()) => {
                        journal.restore(&self.layout)?;
                        true
                    }
                    // A competing image is detected before any restoration starts.
                    Err(MetaError::Invalid { .. }) => false,
                    Err(error) => return Err(error.into()),
                };
            let discarded = DiscardedMove {
                from: from.clone(),
                to: to.clone(),
                restored,
            };
            ScanJournal::remove(&self.layout)?;
            Ok(Some(discarded))
        })
    }
}
