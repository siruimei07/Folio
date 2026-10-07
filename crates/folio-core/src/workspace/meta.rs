//! Metadata changes (versioning.md §6.4, ipc-m2.md §6.3): the library's metadata as `HEAD`
//! committed it, compared with the disk's, read as data rather than compared as files.
//!
//! - [`HeadMeta`] is `HEAD`'s side: its `.folio/` files read with the metadata readers, tags and
//!   settings resolved to the paths of `HEAD`'s tree the way the catalog's mirror resolves them to
//!   entries (library-scan.md §7.2: exactly, else by the one path NTFS takes for it; a tag only
//!   where the file and key are where that path's tags belong; a file whose folder is missing, or
//!   that another file of the same folder outranks, holds nothing).
//! - [`DiskMeta`] is the disk's side, as the loader reads it: the catalog's mirror of `.folio/`,
//!   with `library.json` and `.folio/ignore` read from the disk, and the pairing of §6.1 for the
//!   entries and folders the comparison follows.
//! - The comparison gives each entry's own tags through its pairing ([`TagChange`]: part of the
//!   entry's item when it has one, a row of its own otherwise), the settings of each semester and
//!   course through the pairing of its folder, the tag definitions, the library settings (name and
//!   versioning rules) and the ignore rules, as text. Tags and settings follow moves: a moved entry
//!   with the same tags is no change. A deleted row reports no tag change; a semester or course
//!   whose folder is gone reports its settings deleted, with no folder.
//! - A file the disk cannot read keeps its committed content in every commit (§6.4), so nothing it
//!   holds is a change: the tags of an entry, or of the row it is paired with, that it holds, the
//!   settings of its folder, or the whole file for `tags.json`, `library.json` and
//!   `.folio/ignore`. The catalog's mirror keeps what such a file gave it before, which is never
//!   compared (lane decision 11).

use std::cell::OnceCell;
use std::collections::{BTreeMap, BTreeSet, HashMap, HashSet};

use super::HeadRow;
use super::keys;
use crate::catalog::EntryId;
use crate::meta::{
    self, Content, CourseCode, CourseMeta, CourseSettings, EntryKind, FORMAT_VERSION, FolioFile,
    GroupMeta, GroupSettings, LibraryConfig, MetaFile, Owners, RootMeta, Settings, TagDefinitions,
    TagFile, TagFileKey, TagId, VersioningRules, folio_file, is_folio_owned, tag_location,
};
use crate::paths::{CoursePath, PathKey, RelPath, SemesterPath};
use crate::store::ChangeOp;

/// Why `HEAD`'s metadata cannot be read (versioning.md §4.2; lane decision 15).
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HeadMetaError {
    /// A newer Folio wrote it: the history is read-only.
    #[error("`{path}` in HEAD has format version {found}; this Folio reads up to {FORMAT_VERSION}")]
    Newer { path: RelPath, found: u64 },
    /// It is not a valid metadata file: the history is damaged.
    #[error("`{path}` in HEAD is not valid: {reason}")]
    Invalid { path: RelPath, reason: String },
    /// `HEAD` has no `.folio/library.json`, which every commit holds: the history is damaged.
    #[error("HEAD has no library settings")]
    NoLibrary,
}

/// The metadata of `HEAD`'s commit (versioning.md §6.4).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HeadMeta {
    library: LibraryConfig,
    definitions: TagDefinitions,
    ignore: Option<String>,
    /// The own tags of every tagged row, by its path in `HEAD`, with its kind.
    tags: HashMap<RelPath, (EntryKind, BTreeSet<TagId>)>,
    /// Settings by the path in `HEAD` of the semester's folder.
    semesters: BTreeMap<RelPath, GroupSettings>,
    /// Settings by the path in `HEAD` of the course's folder.
    courses: BTreeMap<RelPath, CourseSettings>,
}

impl HeadMeta {
    /// `HEAD`'s metadata from its `.folio/` files and its rows. `files` holds each file's path,
    /// relative to the library root, and bytes: names Folio does not know are skipped, as on the
    /// disk, and so is any path outside `.folio/`. `rows` is every row of `HEAD`'s tree
    /// (`head_files`), against which tags and settings are resolved.
    ///
    /// A file a newer Folio wrote is [`HeadMetaError::Newer`] even when another is invalid
    /// (updating Folio is the way out, and its files may read then); else the first invalid file
    /// by path is [`HeadMetaError::Invalid`].
    pub fn parse(files: &[(RelPath, Vec<u8>)], rows: &[HeadRow]) -> Result<Self, HeadMetaError> {
        let mut files: Vec<&(RelPath, Vec<u8>)> = files.iter().collect();
        files.sort_unstable_by(|a, b| a.0.cmp(&b.0));
        let mut reader = Reader::default();
        let mut library = None;
        let mut definitions = None;
        let mut ignore = None;
        let mut loaded = BTreeMap::new();
        for (path, bytes) in files {
            match folio_file(path) {
                None => {}
                Some(FolioFile::Library) => library = reader.read::<LibraryConfig>(path, bytes),
                Some(FolioFile::Tags) => definitions = reader.read::<TagDefinitions>(path, bytes),
                Some(FolioFile::Ignore) => ignore = Some(crate::files::lossy_text(bytes)),
                Some(FolioFile::Meta(file)) => {
                    let content = match &file {
                        TagFile::Root => reader.read::<RootMeta>(path, bytes).map(Content::from),
                        TagFile::Group(_) => {
                            reader.read::<GroupMeta>(path, bytes).map(Content::from)
                        }
                        TagFile::Course(_) => {
                            reader.read::<CourseMeta>(path, bytes).map(Content::from)
                        }
                    };
                    if let Some(content) = content {
                        loaded.insert(file, content);
                    }
                }
            }
        }
        reader.finish()?;
        let mut meta = Self {
            library: library.ok_or(HeadMetaError::NoLibrary)?,
            definitions: definitions.unwrap_or_default(),
            ignore,
            tags: HashMap::new(),
            semesters: BTreeMap::new(),
            courses: BTreeMap::new(),
        };
        meta.resolve(&loaded, &Rows::new(rows));
        Ok(meta)
    }

    /// Takes the settings and tags of `loaded` to the rows they belong to, as the catalog's
    /// mirror takes the disk's to entries (`library::mirror`).
    fn resolve(&mut self, loaded: &BTreeMap<TagFile, Content>, rows: &Rows<'_>) {
        let owners = Owners::new(loaded.keys());
        for (file, content) in loaded {
            // The file as `HEAD` spells its folder, which may differ in case from its name.
            let resolved = match file.folder() {
                None => file.clone(),
                Some(folder) => match rows.find(folder) {
                    Some(row) if row.kind() == EntryKind::Folder => {
                        match file.with_folder(row.path.clone()) {
                            Some(resolved) => resolved,
                            None => continue,
                        }
                    }
                    // Orphaned: its folder is not in the tree.
                    _ => continue,
                },
            };
            if owners.of(&resolved) != Some(file) {
                continue;
            }
            match (&resolved, &content.settings) {
                (TagFile::Group(semester), Some(Settings::Group(settings))) => {
                    self.semesters
                        .insert(semester.path().clone(), settings.clone());
                }
                (TagFile::Course(course), Some(Settings::Course(settings))) => {
                    self.courses.insert(course.path().clone(), settings.clone());
                }
                _ => {}
            }
            let file_key = file.key();
            for (key, ids) in content.tags.iter() {
                // A key too long to name anything below its folder names no row.
                let Ok(path) = key.below(resolved.folder()) else {
                    continue;
                };
                let Some(row) = rows.find(&path) else {
                    continue;
                };
                // Only if this file and key are where the row's tags belong.
                let holds =
                    tag_location(&row.path, row.kind()).is_some_and(|(holder, holder_key)| {
                        (holder == *file || holder.key() == file_key)
                            && (holder_key == *key || holder_key.key() == key.key())
                    });
                if holds {
                    self.tags
                        .insert(row.path.clone(), (row.kind(), ids.clone()));
                }
            }
        }
    }

    /// `library.json`.
    pub fn library(&self) -> &LibraryConfig {
        &self.library
    }

    /// `tags.json`; none when `HEAD` has no such file.
    pub fn definitions(&self) -> &TagDefinitions {
        &self.definitions
    }

    /// `.folio/ignore` as text; `None` when `HEAD` has none.
    pub fn ignore(&self) -> Option<&str> {
        self.ignore.as_deref()
    }

    /// The own tags of `HEAD`'s row at `path`; none for a row without tags.
    pub fn tags_of(&self, path: &RelPath) -> Option<&BTreeSet<TagId>> {
        self.tags.get(path).map(|(_, tags)| tags)
    }

    /// The paths of the rows that have tags: the loader passes the entries paired with them
    /// ([`DiskMeta::tags`]).
    pub fn tagged(&self) -> impl Iterator<Item = &RelPath> {
        self.tags.keys()
    }

    /// The settings of each semester, by its folder's path in `HEAD`.
    pub fn semesters(&self) -> &BTreeMap<RelPath, GroupSettings> {
        &self.semesters
    }

    /// The settings of each course, by its folder's path in `HEAD`.
    pub fn courses(&self) -> &BTreeMap<RelPath, CourseSettings> {
        &self.courses
    }
}

/// Reads metadata files, keeping the first problem of each kind.
#[derive(Default)]
struct Reader {
    newer: Option<HeadMetaError>,
    invalid: Option<HeadMetaError>,
}

impl Reader {
    fn read<T: MetaFile>(&mut self, path: &RelPath, bytes: &[u8]) -> Option<T> {
        match meta::from_bytes::<T>(bytes) {
            Ok(value) => Some(value),
            Err(meta::Problem::Newer(found)) => {
                self.newer.get_or_insert(HeadMetaError::Newer {
                    path: path.clone(),
                    found,
                });
                None
            }
            Err(meta::Problem::Invalid(reason)) => {
                self.invalid.get_or_insert(HeadMetaError::Invalid {
                    path: path.clone(),
                    reason: format!("{}: {reason}", T::WHAT),
                });
                None
            }
        }
    }

    fn finish(self) -> Result<(), HeadMetaError> {
        match self.newer.or(self.invalid) {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

/// `HEAD`'s rows, found as the catalog's mirror finds entries: exactly, else the only one whose
/// path NTFS takes for the one asked. `.folio/` is not looked in: it holds no entry.
struct Rows<'a> {
    rows: &'a [HeadRow],
    exact: HashMap<&'a str, usize>,
    /// Built at the first path not found exactly; `None` where two paths share a key.
    by_key: OnceCell<HashMap<PathKey, Option<usize>>>,
}

impl<'a> Rows<'a> {
    fn new(rows: &'a [HeadRow]) -> Self {
        let exact = rows
            .iter()
            .enumerate()
            .filter(|(_, row)| !is_folio_owned(&row.path))
            .map(|(index, row)| (row.path.as_str(), index))
            .collect();
        Self {
            rows,
            exact,
            by_key: OnceCell::new(),
        }
    }

    fn find(&self, path: &RelPath) -> Option<&'a HeadRow> {
        if let Some(&index) = self.exact.get(path.as_str()) {
            return self.rows.get(index);
        }
        let by_key = self.by_key.get_or_init(|| {
            let mut by_key = HashMap::new();
            for &index in self.exact.values() {
                by_key
                    .entry(self.rows[index].path.key())
                    .and_modify(|found| *found = None)
                    .or_insert(Some(index));
            }
            by_key
        });
        let index = by_key.get(&path.key()).copied().flatten()?;
        self.rows.get(index)
    }
}

/// A file of `.folio/` on the disk, as the workspace compares it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OnDisk<T> {
    /// What it holds; a missing file holds its default (no tag definitions, no ignore rules).
    Read(T),
    /// It cannot be read: it keeps its committed content, so nothing it holds is a change.
    Unreadable,
}

/// A catalog entry with the row of `HEAD`'s tree it is paired with (versioning.md §6.1).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PairedEntry {
    pub entry: EntryId,
    pub path: RelPath,
    pub kind: EntryKind,
    /// The path of `HEAD`'s row paired with it, when that row is of its kind; `None` otherwise.
    pub head: Option<RelPath>,
}

/// The disk's side of the metadata (versioning.md §6.4), as the loader reads it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiskMeta {
    /// `library.json`, read from the disk.
    pub library: OnDisk<LibraryConfig>,
    /// `tags.json`, as the catalog mirrors it.
    pub definitions: OnDisk<TagDefinitions>,
    /// `.folio/ignore` as text (`Layout::read_ignore`); `None` without one.
    pub ignore: OnDisk<Option<String>>,
    /// The files of `.folio/meta/` that cannot be read (`MetaTree::broken`).
    pub broken: Vec<TagFile>,
    /// The own tags of every entry that has some in the catalog's mirror (none for an entry
    /// with none), and of every entry paired with a row that has some in `HEAD`
    /// ([`HeadMeta::tagged`]), each once.
    pub tags: Vec<(PairedEntry, BTreeSet<TagId>)>,
    /// Settings by the path of the semester's folder, as the catalog mirrors them.
    pub semesters: BTreeMap<RelPath, GroupSettings>,
    /// Settings by the path of the course's folder, as the catalog mirrors them.
    pub courses: BTreeMap<RelPath, CourseSettings>,
    /// Every folder entry directly in the library or in a folder there: the semesters' and
    /// courses' folders.
    pub folders: Vec<PairedEntry>,
}

impl DiskMeta {
    /// The versioning rules the next commit records: the disk's, or `HEAD`'s while
    /// `library.json` cannot be read, since it keeps its committed content.
    pub fn rules<'a>(&'a self, head: &'a HeadMeta) -> &'a VersioningRules {
        match &self.library {
            OnDisk::Read(library) => &library.versioning,
            OnDisk::Unreadable => &head.library.versioning,
        }
    }
}

/// A change of an entry's own tags: as `HEAD` has them at the row it is paired with (none for an
/// entry without one), and as the disk has them now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TagChange {
    pub entry: EntryId,
    /// The entry's path on the disk.
    pub path: RelPath,
    pub kind: EntryKind,
    pub before: BTreeSet<TagId>,
    pub after: BTreeSet<TagId>,
}

impl TagChange {
    /// Added when it had none, deleted when none are left, else modified.
    pub fn op(&self) -> ChangeOp {
        op_of(!self.before.is_empty(), !self.after.is_empty())
    }
}

/// A change of a semester's or a course's settings.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettingsChange<S> {
    /// The folder's path on the disk; `HEAD`'s path when the folder is gone.
    pub path: RelPath,
    /// The folder's entry; `None` when the folder is gone.
    pub folder: Option<EntryId>,
    pub before: Option<S>,
    pub after: Option<S>,
}

impl<S> SettingsChange<S> {
    /// Added when nothing was committed, deleted when nothing is left, else modified.
    pub fn op(&self) -> ChangeOp {
        op_of(self.before.is_some(), self.after.is_some())
    }
}

/// What a metadata change is about, with both sides.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Subject {
    /// The own tags of an entry without an item.
    Tags(TagChange),
    Semester(SettingsChange<GroupSettings>),
    Course(SettingsChange<CourseSettings>),
    /// `tags.json`.
    TagDefinitions {
        before: TagDefinitions,
        after: TagDefinitions,
    },
    /// `library.json`: its name or its versioning rules. Its id is the library's identity, which
    /// a `HEAD` of another library does not share: that history is damaged, not changed.
    Library {
        before: LibraryConfig,
        after: LibraryConfig,
    },
    /// `.folio/ignore`, as text; `None` without one.
    IgnoreRules {
        before: Option<String>,
        after: Option<String>,
    },
}

/// One row of `list_metadata_changes` (ipc-m2.md §6.3): a change every commit records.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MetadataChange {
    key: String,
    op: ChangeOp,
    subject: Subject,
}

impl MetadataChange {
    pub(super) fn new(subject: Subject) -> Self {
        let (key, op) = match &subject {
            Subject::Tags(change) => (keys::tags_key(&change.path), change.op()),
            Subject::Semester(change) => (
                keys::settings_key(false, change.folder.is_none(), &change.path),
                change.op(),
            ),
            Subject::Course(change) => (
                keys::settings_key(true, change.folder.is_none(), &change.path),
                change.op(),
            ),
            Subject::TagDefinitions { before, after } => (
                keys::TAG_DEFINITIONS_KEY.to_owned(),
                definitions_op(before, after),
            ),
            Subject::Library { .. } => (keys::LIBRARY_KEY.to_owned(), ChangeOp::Modify),
            Subject::IgnoreRules { before, after } => (
                keys::IGNORE_KEY.to_owned(),
                op_of(before.is_some(), after.is_some()),
            ),
        };
        Self { key, op, subject }
    }

    /// Names the change while it exists, like an item's key.
    pub fn key(&self) -> &str {
        &self.key
    }

    /// Added, deleted or modified; never moved.
    pub fn op(&self) -> ChangeOp {
        self.op
    }

    pub fn subject(&self) -> &Subject {
        &self.subject
    }

    /// Where the row goes (ipc-m2.md §6.3): tags by path, then semester and course settings by
    /// path, then tag definitions, library settings and ignore rules; the key settles equal
    /// paths (a folder renamed onto the place of a deleted one).
    pub(super) fn order(&self) -> (u8, Option<&RelPath>, &str) {
        let (rank, path) = match &self.subject {
            Subject::Tags(change) => (0, Some(&change.path)),
            Subject::Semester(SettingsChange { path, .. })
            | Subject::Course(SettingsChange { path, .. }) => (1, Some(path)),
            Subject::TagDefinitions { .. } => (2, None),
            Subject::Library { .. } => (3, None),
            Subject::IgnoreRules { .. } => (4, None),
        };
        (rank, path, &self.key)
    }
}

/// Added when there was nothing, deleted when nothing is left, else modified.
fn op_of(had: bool, has: bool) -> ChangeOp {
    match (had, has) {
        (false, _) => ChangeOp::Add,
        (_, false) => ChangeOp::Delete,
        _ => ChangeOp::Modify,
    }
}

/// Added when tags were only added, deleted when they were only deleted, else modified.
fn definitions_op(before: &TagDefinitions, after: &TagDefinitions) -> ChangeOp {
    let added = after.tags.keys().any(|id| !before.tags.contains_key(id));
    let deleted = before.tags.keys().any(|id| !after.tags.contains_key(id));
    let modified = before
        .tags
        .iter()
        .any(|(id, tag)| after.tags.get(id).is_some_and(|now| now != tag));
    match (added, deleted, modified) {
        (true, false, false) => ChangeOp::Add,
        (false, true, false) => ChangeOp::Delete,
        _ => ChangeOp::Modify,
    }
}

/// What summaries need to name a place (ipc-m2.md §6.4).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub(super) struct Places {
    /// The disk's semester and course folders, by path.
    folders: HashMap<RelPath, EntryId>,
    /// Course codes by the course's path: the disk's settings for a course folder there (unless
    /// its file cannot be read), else `HEAD`'s, so a deleted course keeps its committed code.
    codes: HashMap<RelPath, CourseCode>,
}

impl Places {
    /// The disk's folder entry at `path`, a semester's or a course's.
    pub(super) fn folder(&self, path: &RelPath) -> Option<EntryId> {
        self.folders.get(path).copied()
    }

    pub(super) fn code(&self, path: &RelPath) -> Option<&CourseCode> {
        self.codes.get(path)
    }
}

/// What comparing the metadata gives.
pub(super) struct Compared {
    /// Every entry whose own tags changed, by path: part of its item when it has one, else a
    /// row.
    pub(super) tags: Vec<TagChange>,
    /// The other rows, in no particular order.
    pub(super) rows: Vec<MetadataChange>,
    pub(super) places: Places,
}

/// The metadata changes between `HEAD` and the disk.
pub(super) fn compare(head: &HeadMeta, disk: &DiskMeta) -> Compared {
    let broken = Broken(disk.broken.iter().map(TagFile::key).collect());
    let mut rows: Vec<MetadataChange> = Vec::new();
    rows.extend(
        settings_changes(1, &head.semesters, &disk.semesters, &disk.folders, &broken)
            .into_iter()
            .map(|change| MetadataChange::new(Subject::Semester(change))),
    );
    rows.extend(
        settings_changes(2, &head.courses, &disk.courses, &disk.folders, &broken)
            .into_iter()
            .map(|change| MetadataChange::new(Subject::Course(change))),
    );
    if let OnDisk::Read(after) = &disk.definitions
        && *after != head.definitions
    {
        rows.push(MetadataChange::new(Subject::TagDefinitions {
            before: head.definitions.clone(),
            after: after.clone(),
        }));
    }
    if let OnDisk::Read(after) = &disk.library
        && (after.name != head.library.name || after.versioning != head.library.versioning)
    {
        rows.push(MetadataChange::new(Subject::Library {
            before: head.library.clone(),
            after: after.clone(),
        }));
    }
    if let OnDisk::Read(after) = &disk.ignore
        && *after != head.ignore
    {
        rows.push(MetadataChange::new(Subject::IgnoreRules {
            before: head.ignore.clone(),
            after: after.clone(),
        }));
    }
    Compared {
        tags: tag_changes(head, disk, &broken),
        rows,
        places: places(head, disk, &broken),
    }
}

/// The disk's files of `.folio/meta/` that cannot be read, by their identity on NTFS.
struct Broken(HashSet<TagFileKey>);

impl Broken {
    /// Whether the file that holds the tags of the entry or row at `path`, a `kind`, is one.
    fn holds_tags(&self, path: &RelPath, kind: EntryKind) -> bool {
        tag_location(path, kind).is_some_and(|(holder, _)| self.0.contains(&holder.key()))
    }

    /// Whether the file of the semester or course folder at `path` is one.
    fn holds_settings(&self, path: &RelPath) -> bool {
        let file = match path.depth() {
            1 => SemesterPath::new(path.clone()).ok().map(TagFile::Group),
            2 => CoursePath::new(path.clone()).ok().map(TagFile::Course),
            _ => None,
        };
        file.is_some_and(|file| self.0.contains(&file.key()))
    }
}

/// The entries whose own tags differ from those of the row they are paired with, by path.
fn tag_changes(head: &HeadMeta, disk: &DiskMeta, broken: &Broken) -> Vec<TagChange> {
    let mut seen = HashSet::new();
    let mut changes = Vec::new();
    for (entry, after) in &disk.tags {
        if !seen.insert(entry.entry) {
            continue;
        }
        // A row tagged as the other kind is not this entry: a deletion and an addition.
        let row = entry.head.as_ref().filter(|row| {
            head.tags
                .get(*row)
                .is_none_or(|(kind, _)| *kind == entry.kind)
        });
        if broken.holds_tags(&entry.path, entry.kind)
            || row.is_some_and(|row| broken.holds_tags(row, entry.kind))
        {
            continue;
        }
        let before = row
            .and_then(|row| head.tags_of(row))
            .cloned()
            .unwrap_or_default();
        if before != *after {
            changes.push(TagChange {
                entry: entry.entry,
                path: entry.path.clone(),
                kind: entry.kind,
                before,
                after: after.clone(),
            });
        }
    }
    changes.sort_unstable_by(|a, b| a.path.cmp(&b.path));
    changes
}

/// The settings changes of the folders at `depth` (1: semesters, 2: courses): each folder of the
/// disk compared with the row it is paired with, if that row is at the same depth; then each
/// committed folder no such folder pairs with (gone, by `HEAD`'s path), with any settings the
/// mirror holds at that path without a folder there.
fn settings_changes<S: Clone + PartialEq>(
    depth: usize,
    head: &BTreeMap<RelPath, S>,
    disk: &BTreeMap<RelPath, S>,
    folders: &[PairedEntry],
    broken: &Broken,
) -> Vec<SettingsChange<S>> {
    let compare = |row: Option<&RelPath>, now: Option<&RelPath>| {
        if row.is_some_and(|row| broken.holds_settings(row))
            || now.is_some_and(|now| broken.holds_settings(now))
        {
            return None;
        }
        let before = row.and_then(|row| head.get(row)).cloned();
        let after = now.and_then(|now| disk.get(now)).cloned();
        (before != after).then_some((before, after))
    };
    let mut changes = Vec::new();
    let mut paired = HashSet::new();
    let mut present = HashSet::new();
    let at_depth = folders
        .iter()
        .filter(|folder| folder.kind == EntryKind::Folder && folder.path.depth() == depth);
    for folder in at_depth {
        // A row at another depth held no settings of this kind, whatever its file holds.
        let row = folder.head.as_ref().filter(|row| row.depth() == depth);
        paired.extend(row);
        present.insert(&folder.path);
        if let Some((before, after)) = compare(row, Some(&folder.path)) {
            changes.push(SettingsChange {
                path: folder.path.clone(),
                folder: Some(folder.entry),
                before,
                after,
            });
        }
    }
    let mut gone: BTreeMap<&RelPath, (Option<&RelPath>, Option<&RelPath>)> = BTreeMap::new();
    for row in head.keys().filter(|row| !paired.contains(row)) {
        gone.entry(row).or_default().0 = Some(row);
    }
    for now in disk.keys().filter(|now| !present.contains(now)) {
        gone.entry(now).or_default().1 = Some(now);
    }
    for (path, (row, now)) in gone {
        if let Some((before, after)) = compare(row, now) {
            changes.push(SettingsChange {
                path: path.clone(),
                folder: None,
                before,
                after,
            });
        }
    }
    changes
}

/// The disk's semester and course folders, and every course's code.
fn places(head: &HeadMeta, disk: &DiskMeta, broken: &Broken) -> Places {
    let folders: HashMap<RelPath, EntryId> = disk
        .folders
        .iter()
        .filter(|folder| folder.kind == EntryKind::Folder && matches!(folder.path.depth(), 1 | 2))
        .map(|folder| (folder.path.clone(), folder.entry))
        .collect();
    let mut codes: HashMap<RelPath, CourseCode> = head
        .courses
        .iter()
        .filter_map(|(path, settings)| Some((path.clone(), settings.code.clone()?)))
        .collect();
    let courses = folders
        .keys()
        .filter(|path| path.depth() == 2 && !broken.holds_settings(path));
    for path in courses {
        match disk
            .courses
            .get(path)
            .and_then(|settings| settings.code.clone())
        {
            Some(code) => {
                codes.insert(path.clone(), code);
            }
            None => {
                codes.remove(path);
            }
        }
    }
    Places { folders, codes }
}
