//! The workspace (versioning.md §6): the disk, as the catalog knows it, compared with `HEAD`'s
//! tree.
//!
//! It reuses M1's scan and hashing: the catalog's entries are the disk, and the catalog's
//! `head_files` hold `HEAD`'s tree flattened, each row paired with the entry that is that file or
//! folder (§6.1). A [`Comparison`] is what a read of the two gives; [`Workspace::new`] derives
//! from it:
//!
//! - the changes of §6.3 ([`Change`]): files added, deleted, modified or moved; folders moved,
//!   covering what moved with them, folders deleted, covering what was deleted with them, and
//!   empty folders added; each with its sides, its readiness (§6.2) and its key;
//! - the items ([`Item`]): changes that cannot be committed without each other are bound into
//!   one row (§6.3, `bind`), sorted by path like the `path` sort key (ipc-m1.md §5.3: UTF-8 byte
//!   order), then by key;
//! - the metadata changes of §6.4 ([`MetadataChange`], `meta`): tags through the pairing (part of
//!   an entry's item when it has one), semester and course settings, tag definitions, library
//!   settings and ignore rules, from `HEAD`'s metadata ([`HeadMeta`]) and the disk's
//!   ([`DiskMeta`]); a change of the versioning rules makes the items it is bound to required;
//! - the totals of `get_workspace` ([`Totals`]) and its fingerprint ([`Fingerprint`], §6.5), and
//!   pages of the items and metadata changes ([`Workspace::item_page`],
//!   [`Workspace::metadata_page`]);
//! - what a selection commits: the items it names ([`Workspace::resolve`], ipc-m2.md §5.1), the
//!   commit's flattened tree ([`Workspace::apply`], §7.2) and its summary per place
//!   ([`Workspace::summarize`], §6.6).
//!
//! All of that is pure: no catalog, no file system, no store. What feeds it is not:
//!
//! - the head sync ([`sync`], `head`) brings `HEAD` into the catalog: it indexes the packs,
//!   flattens `HEAD`'s tree into `head_files` with each folder's tree id ([`encode_trees`],
//!   `trees`), reads `HEAD`'s metadata, and says what state the history is in ([`HeadState`]);
//! - [`Workspace::load`] (`load`) pairs again by path, reads what may differ in one stamped read of
//!   the catalog and the disk's side of the metadata, and derives the workspace ([`Snapshot`]).

mod apply;
#[cfg(test)]
mod bench;
mod bind;
mod changes;
mod head;
mod keys;
mod load;
mod meta;
mod summary;
#[cfg(test)]
pub(crate) mod testing;
#[cfg(test)]
mod tests;
mod trees;

use std::collections::HashMap;

pub use apply::{Applied, ApplyError, ApplyProblem, Chosen, Selection, SelectionError, Source};
pub use changes::{
    Blocked, Change, Code, Comparison, DiskRow, HeadFile, HeadRow, ItemSide, Readiness,
};
pub use head::{
    HeadProblem, HeadState, HistoryStatus, MAX_HEAD_PATH_BYTES, MAX_META_BYTES,
    MAX_META_FILE_BYTES, MAX_META_FILES, SyncError, sync,
};
pub use keys::{Fingerprint, MAX_KEY_CHARS};
pub use load::{LoadError, Snapshot};
pub use meta::{
    DiskMeta, HeadMeta, HeadMetaError, MetadataChange, OnDisk, PairedEntry, SettingsChange,
    Subject, TagChange,
};
pub use summary::{ChangeCounts, Place, SelectionSummary, SummaryGroup};
pub use trees::{TreeError, encode_trees};

use crate::catalog::EntryId;
use crate::catalog::queries::{PageRequest, QueryError, check_page};
use crate::meta::VersioningRules;
use crate::paths::RelPath;
use changes::{Compared, DiskFolder, Fate};
use meta::Places;

/// One row of the workspace's items (ipc-m2.md §6.2): a change the user can include or leave out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    change: Change,
    /// The changes bound to it (versioning.md §6.3), committed with it, by path and key.
    parts: Vec<Change>,
    /// Bound to the change of the versioning rules, which every commit records (bound rule 4):
    /// every selection includes it.
    required: bool,
    /// The changes of the own tags of its entries, by path (versioning.md §6.4).
    tags: Vec<TagChange>,
}

impl Item {
    /// The main change: its key, kind, paths and sides are the item's.
    pub fn change(&self) -> &Change {
        &self.change
    }

    /// The other changes bound to it.
    pub fn parts(&self) -> &[Change] {
        &self.parts
    }

    pub fn key(&self) -> &str {
        self.change.key()
    }

    /// The worst readiness of its changes.
    pub fn readiness(&self) -> Readiness {
        self.changes()
            .map(Change::readiness)
            .max()
            .unwrap_or(Readiness::Ready)
    }

    /// Ready or hashing: an `allExcept` selection includes it.
    pub fn is_includable(&self) -> bool {
        self.readiness().is_includable()
    }

    /// Every selection includes it (ipc-m2.md §6.2): it is bound to the change of the versioning
    /// rules, which the shell shows as the part `versioningRules`.
    pub fn is_required(&self) -> bool {
        self.required
    }

    /// The tag changes of its entries, which are part of it rather than rows of their own.
    pub fn tag_changes(&self) -> &[TagChange] {
        &self.tags
    }

    /// One of its entries' tags changed too (ipc-m2.md §6.2, `tagsChanged`).
    pub fn tags_changed(&self) -> bool {
        !self.tags.is_empty()
    }

    /// The main change, then the parts.
    pub fn changes(&self) -> impl Iterator<Item = &Change> {
        std::iter::once(&self.change).chain(&self.parts)
    }
}

/// The counts of `get_workspace` (ipc-m2.md §6.1) that come from the items.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Totals {
    /// Rows: a bound item counts once.
    pub items: u32,
    /// Rows of the metadata changes.
    pub metadata: u32,
    /// Items that are ready or hashing.
    pub includable: u32,
    pub hashing: u32,
    pub not_local: u32,
    pub unreadable: u32,
}

/// A page of a list: its rows from the page's offset, and how many rows the list has.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Window<'a, T> {
    pub rows: &'a [T],
    pub total: u32,
}

/// Where a change is in the items: the item's index, and 0 for its main change or 1 + the index
/// of the part.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct ChangeAt {
    item: usize,
    part: usize,
}

/// What the workspace lists at one catalog revision.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Workspace {
    items: Vec<Item>,
    totals: Totals,
    fingerprint: Fingerprint,
    /// What happens to `HEAD`'s rows that are not in place, for [`Workspace::apply`].
    fates: HashMap<RelPath, Fate<ChangeAt>>,
    /// The disk's folders that are not where `HEAD` has them.
    folders: HashMap<RelPath, DiskFolder>,
    /// The metadata changes that are not part of an item, in their order (ipc-m2.md §6.3).
    metadata: Vec<MetadataChange>,
    /// What summaries need to name places.
    places: Places,
}

impl Workspace {
    /// The items of a comparison, under the disk's versioning rules, without metadata changes:
    /// what the workspace lists while `HEAD`'s metadata cannot be read (lane decision 6). Its
    /// summaries name no folder and no course code.
    pub fn new(comparison: Comparison, rules: &VersioningRules) -> Self {
        Self::build(comparison, rules, None)
    }

    /// The items and metadata changes of a comparison (versioning.md §6.3–§6.4), with `HEAD`'s
    /// metadata and the disk's; the disk's versioning rules decide what is stored
    /// ([`DiskMeta::rules`]).
    pub fn with_metadata(comparison: Comparison, head: &HeadMeta, disk: &DiskMeta) -> Self {
        Self::build(comparison, disk.rules(head), Some((head, disk)))
    }

    fn build(
        comparison: Comparison,
        rules: &VersioningRules,
        metadata: Option<(&HeadMeta, &DiskMeta)>,
    ) -> Self {
        let rules_changed = metadata.is_some_and(|(head, _)| head.library().versioning != *rules);
        let compared = changes::compare(comparison, rules, rules_changed);
        let groups = bind::groups(&compared);
        let required = bind::required(&groups, &compared);
        let Compared {
            changes,
            fates,
            folders,
            ..
        } = compared;
        let count = changes.len();
        let mut slots: Vec<Option<Change>> = changes.into_iter().map(Some).collect();
        let mut rows = Vec::with_capacity(groups.len());
        for (group, required) in groups.into_iter().zip(required) {
            let mut changes = group.iter().filter_map(|&index| slots[index].take());
            if let Some(change) = changes.next() {
                let item = Item {
                    change,
                    parts: changes.collect(),
                    required,
                    tags: Vec::new(),
                };
                rows.push((item, group));
            }
        }
        rows.sort_unstable_by(|(a, _), (b, _)| {
            (a.change.path(), a.key()).cmp(&(b.change.path(), b.key()))
        });
        let mut at = vec![ChangeAt { item: 0, part: 0 }; count];
        let mut items = Vec::with_capacity(rows.len());
        for (item, (row, group)) in rows.into_iter().enumerate() {
            for (part, index) in group.into_iter().enumerate() {
                at[index] = ChangeAt { item, part };
            }
            items.push(row);
        }
        let fates = fates
            .into_iter()
            .map(|(path, fate)| (path, fate.map(|change| at[change])))
            .collect();
        let mut workspace = Self {
            items,
            fates,
            folders,
            ..Self::default()
        };
        if let Some((head, disk)) = metadata {
            workspace.add_metadata(meta::compare(head, disk));
        }
        workspace.tally();
        workspace
    }

    /// Adds the metadata changes: a tag change to the item of its entry when it has one, else as
    /// a row of its own; the rows in their order.
    fn add_metadata(&mut self, compared: meta::Compared) {
        let mut owners: HashMap<EntryId, usize> = HashMap::new();
        for (index, item) in self.items.iter().enumerate() {
            owners.extend(
                item.changes()
                    .filter_map(Change::entry)
                    .map(|entry| (entry, index)),
            );
        }
        let mut rows = compared.rows;
        for change in compared.tags {
            match owners.get(&change.entry) {
                Some(&index) => self.items[index].tags.push(change),
                None => rows.push(MetadataChange::new(Subject::Tags(change))),
            }
        }
        rows.sort_unstable_by(|a, b| a.order().cmp(&b.order()));
        self.metadata = rows;
        self.places = compared.places;
    }

    /// A workspace that lists nothing: before the first commit, while it runs, or while `HEAD`
    /// cannot be read (ipc-m2.md §6.1). Its fingerprint is 32 zeros.
    pub fn empty() -> Self {
        Self::default()
    }

    /// Counts the totals and the fingerprint of the items and metadata changes.
    fn tally(&mut self) {
        let mut totals = Totals::default();
        let mut fingerprint = Fingerprint::default();
        for item in &self.items {
            let readiness = item.readiness();
            let slot = match readiness {
                Readiness::Ready => None,
                Readiness::Hashing => Some(&mut totals.hashing),
                Readiness::NotLocal => Some(&mut totals.not_local),
                Readiness::Unreadable => Some(&mut totals.unreadable),
            };
            if let Some(slot) = slot {
                *slot = slot.saturating_add(1);
            }
            if readiness.is_includable() {
                totals.includable = totals.includable.saturating_add(1);
            }
            for change in item.changes() {
                fingerprint.add_change(change.key(), readiness.is_includable());
            }
            if item.required {
                fingerprint.add_required(item.key());
            }
            for tags in &item.tags {
                fingerprint.add_key(&keys::tags_key(&tags.path));
            }
        }
        for change in &self.metadata {
            fingerprint.add_key(change.key());
        }
        totals.items = count(self.items.len());
        totals.metadata = count(self.metadata.len());
        self.totals = totals;
        self.fingerprint = fingerprint;
    }

    /// The change at `at`.
    fn change(&self, at: ChangeAt) -> Option<&Change> {
        let item = self.items.get(at.item)?;
        match at.part {
            0 => Some(&item.change),
            part => item.parts.get(part - 1),
        }
    }

    /// Every item, sorted by path.
    pub fn items(&self) -> &[Item] {
        &self.items
    }

    /// The items of `page`; a limit over `pageSize` is `InvalidArgument`.
    pub fn item_page(&self, page: PageRequest) -> Result<Window<'_, Item>, QueryError> {
        window(&self.items, page)
    }

    /// Every metadata change that is not part of an item, in order (ipc-m2.md §6.3).
    pub fn metadata(&self) -> &[MetadataChange] {
        &self.metadata
    }

    /// The metadata changes of `page`; a limit over `pageSize` is `InvalidArgument`.
    pub fn metadata_page(
        &self,
        page: PageRequest,
    ) -> Result<Window<'_, MetadataChange>, QueryError> {
        window(&self.metadata, page)
    }

    pub fn totals(&self) -> Totals {
        self.totals
    }

    pub fn fingerprint(&self) -> Fingerprint {
        self.fingerprint
    }
}

/// The rows of `list` that `page` covers.
fn window<T>(list: &[T], page: PageRequest) -> Result<Window<'_, T>, QueryError> {
    check_page(page)?;
    let start = usize::try_from(page.offset).map_or(list.len(), |offset| offset.min(list.len()));
    let limit = usize::try_from(page.limit).unwrap_or(usize::MAX);
    let end = start.saturating_add(limit).min(list.len());
    Ok(Window {
        rows: &list[start..end],
        total: count(list.len()),
    })
}

/// A count as the contract sends it. Lists are bounded far below `u32::MAX` (the path budget,
/// the catalog's entries), so the saturation is never reached.
fn count(len: usize) -> u32 {
    u32::try_from(len).unwrap_or(u32::MAX)
}
