//! Every file of `.folio/meta/` at once, so that tags and settings can follow moved entries and
//! the catalog can mirror them (docs/specs/library-scan.md §7).

use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use super::layout::{GROUP_FILE, ROOT_FILE, course_named, semester_named};
use super::model::random_hex;
use super::{
    Assignments, CourseMeta, CourseSettings, EntryKind, GroupMeta, GroupSettings, Layout,
    MetaError, MetaFile, RootMeta, TagDefinitions, TagFile, TagFileKey, TagId, io_error, read,
    read_bytes, tag_location, write,
};
use crate::files;
use crate::paths::{CoursePath, PathKey, RelPath, SemesterPath};

/// Entries that moved: old path → new path and kind. Entries below a moved folder are listed
/// too, or follow it (see [`relocated`]).
pub type Moves = BTreeMap<RelPath, (RelPath, EntryKind)>;

/// Settings that a semester or course file holds besides tags.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Settings {
    Group(GroupSettings),
    Course(CourseSettings),
}

/// What one file of `.folio/meta/` holds.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Content {
    pub settings: Option<Settings>,
    pub tags: Assignments,
}

impl Content {
    fn is_empty(&self) -> bool {
        self.settings.is_none() && self.tags.is_empty()
    }
}

impl From<RootMeta> for Content {
    fn from(meta: RootMeta) -> Self {
        Self {
            settings: None,
            tags: meta.tags,
        }
    }
}

impl From<GroupMeta> for Content {
    fn from(meta: GroupMeta) -> Self {
        Self {
            settings: meta.group.map(Settings::Group),
            tags: meta.tags,
        }
    }
}

impl From<CourseMeta> for Content {
    fn from(meta: CourseMeta) -> Self {
        Self {
            settings: meta.course.map(Settings::Course),
            tags: meta.tags,
        }
    }
}

/// Tags or settings that could not follow a move.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stranded {
    pub from: RelPath,
    pub to: RelPath,
    pub cause: StrandedCause,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StrandedCause {
    /// A newer Folio wrote the metadata, so nothing may change it (ADR-0002 §3).
    ReadOnly,
    /// The entry became a semester or course folder, which cannot have tags.
    FolderTags,
    /// The file that holds them, or would hold them, cannot be read.
    Unreadable,
    /// Their new path would be longer than Windows allows.
    TooLong,
}

/// `tags.json` and every file of `.folio/meta/`, each read, or with the reason it could not be.
/// A file that cannot be read is never written or deleted.
#[derive(Debug)]
pub struct MetaTree {
    tags: Option<Result<TagDefinitions, MetaError>>,
    loaded: BTreeMap<TagFile, Content>,
    broken: BTreeMap<TagFile, MetaError>,
    /// What [`MetaTree::save`] still has to do on disk: first renames of names that change
    /// only in case, which on NTFS only a rename does (a `Group` pair renames the semester's
    /// folder with every file in it), then writes and deletions.
    renames: Vec<(TagFile, TagFile)>,
    ops: Vec<Op>,
}

#[derive(Debug)]
enum Op {
    Write(TagFile),
    Delete(TagFile),
}

impl MetaTree {
    /// Reads `tags.json` and everything in `.folio/meta/`. Names there that are not metadata
    /// files are skipped. Fails only when a folder cannot be listed.
    pub fn read(layout: &Layout) -> Result<Self, MetaError> {
        let mut tree = Self {
            tags: layout.read_tags().transpose(),
            loaded: BTreeMap::new(),
            broken: BTreeMap::new(),
            renames: Vec::new(),
            ops: Vec::new(),
        };
        let meta = layout.meta_dir();
        for (name, is_dir) in list(&meta)? {
            if !is_dir {
                if name == ROOT_FILE {
                    tree.load::<RootMeta>(TagFile::Root, &meta.join(&name));
                }
                continue;
            }
            let Some(semester) = semester_named(&name) else {
                continue;
            };
            let folder = meta.join(&name);
            for (file, is_dir) in list(&folder)? {
                let path = folder.join(&file);
                if is_dir {
                    continue;
                } else if file == GROUP_FILE {
                    tree.load::<GroupMeta>(TagFile::Group(semester.clone()), &path);
                } else if let Some(course) = course_named(&semester, &file) {
                    tree.load::<CourseMeta>(TagFile::Course(course), &path);
                }
            }
        }
        Ok(tree)
    }

    fn load<T: MetaFile + Into<Content>>(&mut self, file: TagFile, path: &Path) {
        match read::<T>(path) {
            Ok(Some(value)) => {
                self.loaded.insert(file, value.into());
            }
            // Removed since the listing.
            Ok(None) => {}
            Err(error) => {
                self.broken.insert(file, error);
            }
        }
    }

    /// `tags.json`, or `None` when there is none.
    pub fn tag_definitions(&self) -> Option<&Result<TagDefinitions, MetaError>> {
        self.tags.as_ref()
    }

    /// Every file that could be read.
    pub fn loaded(&self) -> &BTreeMap<TagFile, Content> {
        &self.loaded
    }

    /// Every file that could not be read, and why.
    pub fn broken(&self) -> &BTreeMap<TagFile, MetaError> {
        &self.broken
    }

    /// Which file holds the metadata of each folder.
    pub fn owners(&self) -> Owners<'_> {
        Owners::new(self.loaded.keys().chain(self.broken.keys()))
    }

    /// Whether a newer Folio wrote one of the files: then none may be written (ADR-0002 §3).
    pub fn is_read_only(&self) -> bool {
        let newer = |error: &MetaError| matches!(error, MetaError::NewerFormat { .. });
        self.broken.values().any(newer) || matches!(&self.tags, Some(Err(error)) if newer(error))
    }

    /// Moves tags and settings along with moved entries (docs/specs/library-scan.md §7.1), in
    /// memory; [`MetaTree::save`] writes the result. Returns what could not follow. Nothing
    /// changes when the metadata is read-only.
    pub fn relocate(&mut self, moves: &Moves) -> Vec<Stranded> {
        if moves.is_empty() {
            return Vec::new();
        }
        let plan = self.plan(moves);
        if self.is_read_only() {
            return plan
                .followed
                .into_iter()
                .map(|(from, to)| Stranded {
                    from,
                    to,
                    cause: StrandedCause::ReadOnly,
                })
                .chain(plan.stranded)
                .collect();
        }

        let rekey = |file: TagFile| plan.rekey.get(&file).cloned().unwrap_or(file);
        let broken = std::mem::take(&mut self.broken);
        self.broken = broken
            .into_iter()
            .map(|(file, error)| (rekey(file), error))
            .collect();
        self.loaded = plan.loaded;

        self.renames.extend(plan.renames);
        let mut deletes = Vec::new();
        for file in plan.dirty {
            if self
                .loaded
                .get(&file)
                .is_some_and(|content| !content.is_empty())
            {
                self.ops.push(Op::Write(file));
            } else {
                // Every insertion leaves settings or tags, so only a file that held some is
                // left empty.
                self.loaded.remove(&file);
                deletes.push(Op::Delete(file));
            }
        }
        // Deletions last: a crash leaves tags in two places rather than in none.
        self.ops.extend(deletes);
        plan.stranded
    }

    /// Works out what [`MetaTree::relocate`] changes, without changing anything.
    fn plan(&self, moves: &Moves) -> Plan {
        let relocator = Relocator::new(moves);
        let mut plan = Plan::default();
        let identities: BTreeSet<&TagFile> = self.loaded.keys().chain(self.broken.keys()).collect();

        // Names that change only in case keep their file, renamed.
        let same_but_case = |path: &RelPath| match relocator.relocated(path) {
            Some(Ok(to)) if to != *path && to.key() == path.key() => Some(to),
            _ => None,
        };
        let semesters: BTreeSet<SemesterPath> = identities
            .iter()
            .filter_map(|file| semester_of(file))
            .collect();
        for semester in &semesters {
            let Some(to) = same_but_case(semester.path()) else {
                continue;
            };
            let to = SemesterPath::new(to).expect("one name");
            if semesters.contains(&to) {
                continue;
            }
            plan.renames
                .push((TagFile::Group(semester.clone()), TagFile::Group(to.clone())));
            for file in &identities {
                if semester_of(file).as_ref() == Some(semester) {
                    plan.rekey.insert((*file).clone(), with_semester(file, &to));
                }
            }
        }
        let renamed: BTreeSet<TagFile> = identities
            .iter()
            .map(|file| plan.rekey.get(*file).unwrap_or(file).clone())
            .collect();
        for file in &identities {
            let TagFile::Course(course) = file else {
                continue;
            };
            let current = plan.rekey.get(*file).unwrap_or(file).clone();
            let Some(to) = same_but_case(course.path()) else {
                continue;
            };
            let to = TagFile::Course(CoursePath::new(to).expect("two names"));
            if to != current && !renamed.contains(&to) {
                plan.renames.push((current, to.clone()));
                plan.rekey.insert((*file).clone(), to);
            }
        }
        let current = |file: &TagFile| plan.rekey.get(file).unwrap_or(file).clone();

        // Then tags and settings move between files. A target that differs only in case from
        // a file that exists is that file.
        plan.loaded = self
            .loaded
            .iter()
            .map(|(file, content)| (current(file), content.clone()))
            .collect();
        let broken: BTreeSet<TagFile> = self.broken.keys().map(current).collect();
        let owners = Owners::new(plan.loaded.keys().chain(&broken));
        let canonical = |file: TagFile| owners.of(&file).cloned().unwrap_or(file);
        let tops = top_moves(moves);
        let top_of = |path: &RelPath| {
            let (moved, _) = relocator.moved_ancestor(path)?;
            tops.iter()
                .find(|(from, _)| moved.starts_with(from))
                .map(|(from, (to, _))| ((*from).clone(), (*to).clone()))
        };
        let stranded = |from: &RelPath, to: RelPath, cause| Stranded {
            from: from.clone(),
            to,
            cause,
        };

        let mut removals = Vec::new();
        let mut insertions = Vec::new();
        for (file, content) in &self.loaded {
            let source = current(file);
            let folder = file.folder();
            if let (Some(folder), Some(settings)) = (folder, &content.settings) {
                match relocator.relocated(folder) {
                    None => {}
                    Some(Err(to)) => {
                        plan.stranded
                            .push(stranded(folder, to, StrandedCause::TooLong));
                    }
                    Some(Ok(to)) => {
                        // Settings of a folder that is no longer a semester or course stay
                        // behind: the mirror reports the file as orphaned.
                        if let Some(target) = file.with_folder(to.clone()).map(canonical)
                            && target != source
                        {
                            if broken.contains(&target) {
                                plan.stranded
                                    .push(stranded(folder, to, StrandedCause::Unreadable));
                            } else {
                                removals.push((source.clone(), None));
                                insertions.push((target, Insertion::Settings(settings.clone())));
                                plan.followed.extend(top_of(folder));
                            }
                        }
                    }
                }
            }
            for (key, ids) in content.tags.iter() {
                // A key too long to name anything below its folder names no entry.
                let Ok(from) = key.below(folder) else {
                    continue;
                };
                let to = match relocator.relocated(&from) {
                    None => continue,
                    Some(Err(to)) => {
                        plan.stranded
                            .push(stranded(&from, to, StrandedCause::TooLong));
                        continue;
                    }
                    Some(Ok(to)) => to,
                };
                let kind = relocator.kind(&from).unwrap_or(EntryKind::File);
                let Some((target, target_key)) = tag_location(&to, kind) else {
                    plan.stranded
                        .push(stranded(&from, to, StrandedCause::FolderTags));
                    continue;
                };
                let target = canonical(target);
                if target == source && target_key == *key {
                    continue;
                }
                if broken.contains(&target) {
                    plan.stranded
                        .push(stranded(&from, to, StrandedCause::Unreadable));
                    continue;
                }
                removals.push((source.clone(), Some(key.clone())));
                insertions.push((target, Insertion::Tags(target_key, ids.clone())));
                plan.followed.extend(top_of(&from));
            }
        }
        // Files that cannot be read hold tags nobody knows: report the moves they cover.
        for file in self.broken.keys() {
            let moved_folder = file
                .folder()
                .and_then(|folder| relocator.moved_ancestor(folder))
                .map(|(moved, _)| moved);
            for (from, (to, kind)) in &tops {
                let holds = tag_location(from, *kind)
                    .is_some_and(|(holder, _)| holder.key() == file.key())
                    || moved_folder.is_some_and(|moved| moved.starts_with(from));
                if holds {
                    plan.stranded
                        .push(stranded(from, (*to).clone(), StrandedCause::Unreadable));
                }
            }
        }

        // Every removal before any insertion, so that swaps work.
        for (file, key) in removals {
            let content = plan.loaded.get_mut(&file).expect("a file that was read");
            match key {
                None => content.settings = None,
                Some(key) => content.tags.set(key, BTreeSet::new()),
            }
            plan.dirty.insert(file);
        }
        for (file, insertion) in insertions {
            let content = plan.loaded.entry(file.clone()).or_default();
            match insertion {
                Insertion::Settings(settings) => content.settings = Some(settings),
                Insertion::Tags(key, ids) => content.tags.set(key, ids),
            }
            plan.dirty.insert(file);
        }
        plan
    }

    /// Carries out on disk what [`MetaTree::relocate`] decided, and returns the id of the
    /// journal it wrote if it changed any content.
    ///
    /// Renames only change the case of names, which the next plan finds done or does again,
    /// so they come first and need no journal. Before any content changes, the journal
    /// ([`Layout::scan_journal_file`]) records what each file held, so that a scan whose catalog
    /// update never committed can be undone ([`ScanJournal::undo`]). The caller stores the id
    /// in the catalog in the same transaction as its own changes, and removes the journal once
    /// they committed.
    pub fn save(&mut self, layout: &Layout) -> Result<Option<String>, MetaError> {
        for (from, to) in std::mem::take(&mut self.renames) {
            match (from, to) {
                (TagFile::Group(from), TagFile::Group(to)) => {
                    rename(&layout.semester_dir(&from)?, &layout.semester_dir(&to)?)?;
                }
                (from, to) => {
                    rename(&layout.tag_file_path(&from)?, &layout.tag_file_path(&to)?)?;
                }
            }
        }
        let ops = std::mem::take(&mut self.ops);
        if ops.is_empty() {
            return Ok(None);
        }

        let mut before = Vec::new();
        for op in &ops {
            let (Op::Write(file) | Op::Delete(file)) = op;
            let path = layout.tag_file_path(file)?;
            let content = match files::retry_transient(|| fs::read_to_string(&path)) {
                Ok(content) => Some(content),
                Err(error) if error.kind() == io::ErrorKind::NotFound => None,
                Err(error) => return Err(io_error(&path)(error)),
            };
            before.push((file.meta_path()?, content));
        }
        let journal = JournalFile {
            format_version: JOURNAL_VERSION,
            id: random_hex(8)?,
            before,
        };
        let bytes = serde_json::to_vec_pretty(&journal).expect("a journal always serializes");
        let journal_path = layout.scan_journal_file();
        files::write_atomically(&layout.staging_dir(), &journal_path, &bytes)
            .map_err(io_error(&journal_path))?;

        let mut emptied = BTreeSet::new();
        for op in ops {
            match op {
                Op::Write(file) => write_file(layout, &file, &self.loaded[&file])?,
                Op::Delete(file) => {
                    remove(&layout.tag_file_path(&file)?)?;
                    emptied.extend(semester_of(&file));
                }
            }
        }
        for semester in emptied {
            remove_if_empty(&layout.semester_dir(&semester)?);
        }
        Ok(Some(journal.id))
    }
}

/// The version of the scan journal's format.
const JOURNAL_VERSION: u32 = 1;

/// `.folio/local/journal/scan.json`: local to this machine and never synced, but versioned all
/// the same.
#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalFile {
    format_version: u32,
    id: String,
    /// What each file held before the scan changed it, `None` if it did not exist. Paths are
    /// below `.folio/meta/`, with `/`.
    before: Vec<(String, Option<String>)>,
}

/// The journal of a scan that changed metadata files (docs/specs/library-scan.md §7.1).
#[derive(Debug)]
pub struct ScanJournal {
    id: String,
    /// What each file held before the scan, `None` if it did not exist.
    before: Vec<(PathBuf, Option<String>)>,
}

impl ScanJournal {
    /// The journal a scan left, if any. A journal that names anything but a metadata file is
    /// invalid: Folio never writes one, and undoing it would write outside `.folio/meta/`.
    pub fn read(layout: &Layout) -> Result<Option<Self>, MetaError> {
        let path = layout.scan_journal_file();
        let Some(bytes) = read_bytes(&path)? else {
            return Ok(None);
        };
        let invalid = |reason: String| MetaError::Invalid {
            path: path.clone(),
            reason: format!("scan journal: {reason}"),
        };
        let journal: JournalFile =
            serde_json::from_slice(&bytes).map_err(|error| invalid(error.to_string()))?;
        if journal.format_version > JOURNAL_VERSION {
            return Err(MetaError::NewerFormat {
                path,
                found: journal.format_version.into(),
            });
        }
        let before = journal
            .before
            .into_iter()
            .map(|(file, content)| {
                // The path as the layout builds it, never as the journal spells it.
                let path = TagFile::at(&file)
                    .and_then(|file| layout.tag_file_path(&file).ok())
                    .ok_or_else(|| invalid(format!("{file:?} is not a metadata file")))?;
                Ok((path, content))
            })
            .collect::<Result<_, MetaError>>()?;
        Ok(Some(Self {
            id: journal.id,
            before,
        }))
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// Puts back what the scan's files held before it, then removes the journal.
    pub fn undo(self, layout: &Layout) -> Result<(), MetaError> {
        for (path, content) in &self.before {
            match content {
                Some(content) => {
                    files::write_atomically(&layout.staging_dir(), path, content.as_bytes())
                        .map_err(io_error(path))?;
                }
                None => {
                    remove(path)?;
                    if let Some(folder) = path.parent() {
                        remove_if_empty(folder);
                    }
                }
            }
        }
        Self::remove(layout)
    }

    /// Removes the journal: its scan committed, or its changes stay.
    pub fn remove(layout: &Layout) -> Result<(), MetaError> {
        remove(&layout.scan_journal_file())
    }
}

/// Which file holds the metadata of a folder that several files name, which only a disk that
/// tells case apart allows: the one spelled like the folder, else the first by name
/// (docs/specs/library-scan.md §7.2). The others count as orphaned.
pub struct Owners<'a> {
    files: BTreeSet<&'a TagFile>,
    first: HashMap<TagFileKey, &'a TagFile>,
}

impl<'a> Owners<'a> {
    fn new(files: impl IntoIterator<Item = &'a TagFile>) -> Self {
        let files: BTreeSet<&TagFile> = files.into_iter().collect();
        let mut first = HashMap::new();
        for file in &files {
            first.entry(file.key()).or_insert(*file);
        }
        Self { files, first }
    }

    /// The file that holds the metadata of `file`'s folder, or `None` if there is none.
    pub fn of(&self, file: &TagFile) -> Option<&'a TagFile> {
        self.files
            .get(file)
            .or_else(|| self.first.get(&file.key()))
            .copied()
    }
}

/// What [`MetaTree::relocate`] changes.
#[derive(Default)]
struct Plan {
    renames: Vec<(TagFile, TagFile)>,
    /// The new identity of every renamed file.
    rekey: BTreeMap<TagFile, TagFile>,
    /// Every file that could be read, under its new identity, with its new content.
    loaded: BTreeMap<TagFile, Content>,
    /// Files whose content changes.
    dirty: BTreeSet<TagFile>,
    /// The outermost moves whose tags or settings follow them.
    followed: BTreeSet<(RelPath, RelPath)>,
    stranded: Vec<Stranded>,
}

enum Insertion {
    Settings(Settings),
    Tags(RelPath, BTreeSet<TagId>),
}

/// Looks moves up the way NTFS compares names: a key or a file name in `.folio/meta/` may
/// differ in case from the path of the entry it belongs to.
struct Relocator<'a> {
    moves: &'a Moves,
    /// Moved paths by key; `None` where two differ only in case.
    by_key: HashMap<PathKey, Option<&'a RelPath>>,
}

impl<'a> Relocator<'a> {
    fn new(moves: &'a Moves) -> Self {
        let mut by_key = HashMap::new();
        for from in moves.keys() {
            by_key
                .entry(from.key())
                .and_modify(|found| *found = None)
                .or_insert(Some(from));
        }
        Self { moves, by_key }
    }

    /// The moved path that is `path`, exactly or else without regard to case.
    fn moved(&self, path: &RelPath) -> Option<&'a RelPath> {
        match self.moves.get_key_value(path) {
            Some((from, _)) => Some(from),
            None => self.by_key.get(&path.key()).copied().flatten(),
        }
    }

    /// The move of the nearest of `path` and its ancestors that moved, and that ancestor as
    /// `path` spells it.
    fn moved_ancestor(&self, path: &RelPath) -> Option<(&'a RelPath, RelPath)> {
        path.ancestors()
            .find_map(|ancestor| Some((self.moved(&ancestor)?, ancestor)))
    }

    fn kind(&self, path: &RelPath) -> Option<EntryKind> {
        self.moved(path).map(|from| self.moves[from].1)
    }

    /// Where `path` is after the moves: moved along with the nearest of itself and its
    /// ancestors that moved. `None` if nothing moved it; `Err` with the new path of that
    /// ancestor if the whole new path would be too long.
    fn relocated(&self, path: &RelPath) -> Option<Result<RelPath, RelPath>> {
        let (from, ancestor) = self.moved_ancestor(path)?;
        Some(moved_along(path, &ancestor, &self.moves[from].0))
    }
}

/// Where `path` is after `moves`, compared exactly: moved along with the nearest of itself and
/// its ancestors that moved, or `None` if none did or the new path would be too long.
pub fn relocated(moves: &Moves, path: &RelPath) -> Option<RelPath> {
    if moves.is_empty() {
        return None;
    }
    path.ancestors()
        .find_map(|ancestor| {
            let (to, _) = moves.get(&ancestor)?;
            Some(moved_along(path, &ancestor, to).ok())
        })
        .flatten()
}

/// `path` after `ancestor`, itself or one of its ancestors, moved to `to`; `Err(to)` if the new
/// path would be too long.
fn moved_along(path: &RelPath, ancestor: &RelPath, to: &RelPath) -> Result<RelPath, RelPath> {
    match path.strip_prefix(ancestor) {
        None => Ok(to.clone()),
        Some(rest) => to.join(&rest).map_err(|_| to.clone()),
    }
}

/// The moves that are not inside another moved folder.
fn top_moves(moves: &Moves) -> Vec<(&RelPath, &(RelPath, EntryKind))> {
    moves
        .iter()
        .filter(|(from, _)| {
            from.parent()
                .is_none_or(|parent| relocated(moves, &parent).is_none())
        })
        .collect()
}

fn semester_of(file: &TagFile) -> Option<SemesterPath> {
    match file {
        TagFile::Root => None,
        TagFile::Group(semester) => Some(semester.clone()),
        TagFile::Course(course) => Some(course.semester()),
    }
}

fn with_semester(file: &TagFile, semester: &SemesterPath) -> TagFile {
    match file {
        TagFile::Root | TagFile::Group(_) => TagFile::Group(semester.clone()),
        TagFile::Course(course) => {
            let name = RelPath::parse(course.name()).expect("a course name");
            let path = semester.path().join(&name).expect("the same length");
            TagFile::Course(CoursePath::new(path).expect("two names"))
        }
    }
}

fn write_file(layout: &Layout, file: &TagFile, content: &Content) -> Result<(), MetaError> {
    let path = layout.tag_file_path(file)?;
    let tags = content.tags.clone();
    match file {
        TagFile::Root => write(layout, &path, &RootMeta { tags }),
        TagFile::Group(_) => {
            let group = match &content.settings {
                Some(Settings::Group(settings)) => Some(settings.clone()),
                _ => None,
            };
            write(layout, &path, &GroupMeta { group, tags })
        }
        TagFile::Course(_) => {
            let course = match &content.settings {
                Some(Settings::Course(settings)) => Some(settings.clone()),
                _ => None,
            };
            write(layout, &path, &CourseMeta { course, tags })
        }
    }
}

fn rename(from: &Path, to: &Path) -> Result<(), MetaError> {
    files::retry_transient(|| fs::rename(from, to)).map_err(io_error(from))
}

/// Removes a file; a missing one counts as removed.
fn remove(path: &Path) -> Result<(), MetaError> {
    match files::retry_transient(|| fs::remove_file(path)) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(io_error(path)(error)),
        _ => Ok(()),
    }
}

/// Removes a folder of metadata files that no file is left in.
fn remove_if_empty(folder: &Path) {
    let is_empty = fs::read_dir(folder).is_ok_and(|mut entries| entries.next().is_none());
    if is_empty {
        // An empty folder left behind changes nothing: reading skips it.
        let _ = fs::remove_dir(folder);
    }
}

/// The files and folders in `folder` whose names are Unicode; nothing for a missing folder.
fn list(folder: &Path) -> Result<Vec<(String, bool)>, MetaError> {
    let entries = match fs::read_dir(folder) {
        Ok(entries) => entries,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(io_error(folder)(error)),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(io_error(folder))?;
        let file_type = entry.file_type().map_err(io_error(&entry.path()))?;
        if let Ok(name) = entry.file_name().into_string()
            && (file_type.is_dir() || file_type.is_file())
        {
            names.push((name, file_type.is_dir()));
        }
    }
    Ok(names)
}
