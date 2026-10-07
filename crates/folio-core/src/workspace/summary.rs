//! Selection summaries (versioning.md §6.6, ipc-m2.md §6.4): what a selection commits, per
//! course, semester and the library root, so the UI never loads every item.
//!
//! A change belongs to the place of its path: the course it is in (a folder two names deep is a
//! course and belongs to itself), else the semester it is in (a folder one name deep belongs to
//! itself, a file two names deep is directly in a semester), else the library root. An item
//! belongs to the place of its main path, with its tag changes; a tags row to the place of its
//! entry, a settings row to its folder. A place keeps the name of its path, so a deleted course
//! keeps its committed name; its folder is the disk's entry at that path, and a course's code
//! comes from the disk's settings, or `HEAD`'s when the folder is gone.
//!
//! Counting follows ipc-m2.md §6.4: in one pass over the items, each adds 1 to `items` of its
//! place, a required one to `required`, a required or includable one to `available`, one the
//! selection includes to `selected` and to `files` or `folders` by its main change, and one whose
//! tags changed to `tags` when the commit records that change: when the selection includes it, or
//! when an entry of it with a tag change stays in the commit with its new tags anyway, a modified
//! entry at its path or a moved one at its old path (versioning.md §6.4: an added entry left out
//! keeps its tags for the commit that adds it). Then each tags row adds 1 to `tags` and each
//! settings row sets `settings`.

use std::collections::{BTreeMap, HashSet};

use super::meta::{SettingsChange, Subject};
use super::{Chosen, Item, Workspace, count};
use crate::catalog::EntryId;
use crate::meta::{CourseCode, EntryKind};
use crate::paths::RelPath;
use crate::store::ChangeOp;

/// What a selection commits (ipc-m2.md §6.4).
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SelectionSummary {
    /// Included items. The commit button counts `items + metadata`.
    pub items: u32,
    /// Metadata changes, always included.
    pub metadata: u32,
    /// Every place with a change, the library root first, then by path in UTF-8 byte order.
    pub groups: Vec<SummaryGroup>,
    /// `tags.json` changed.
    pub tag_definitions: bool,
    /// `library.json` changed.
    pub library: bool,
    /// `.folio/ignore` changed.
    pub ignore_rules: bool,
}

/// The changes of one place.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SummaryGroup {
    pub place: Place,
    /// Included file items, by their main change.
    pub files: ChangeCounts,
    /// Included folder items, by their main change.
    pub folders: ChangeCounts,
    /// Items and tags rows in it whose tag change the commit records.
    pub tags: u32,
    /// Its own settings changed: a semester's or a course's.
    pub settings: bool,
    /// Every item in it, includable or not.
    pub items: u32,
    /// Its required items, whatever their readiness; `available` and `selected` count them too.
    pub required: u32,
    /// Its includable (ready or hashing) and required items, included or not: what a selection
    /// can include.
    pub available: u32,
    /// Its included items, every required one among them.
    pub selected: u32,
}

impl SummaryGroup {
    fn new(place: Place) -> Self {
        Self {
            place,
            files: ChangeCounts::default(),
            folders: ChangeCounts::default(),
            tags: 0,
            settings: false,
            items: 0,
            required: 0,
            available: 0,
            selected: 0,
        }
    }
}

/// Where a change belongs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Place {
    /// Files and folders at the library root.
    Library,
    Semester {
        path: RelPath,
        /// The disk's folder at `path`; `None` when it is gone.
        folder: Option<EntryId>,
    },
    Course {
        path: RelPath,
        /// The disk's folder at `path`; `None` when it is gone.
        folder: Option<EntryId>,
        code: Option<CourseCode>,
    },
}

impl Place {
    /// The folder's name, the last of its path; `None` for the library root.
    pub fn name(&self) -> Option<&str> {
        match self {
            Self::Library => None,
            Self::Semester { path, .. } | Self::Course { path, .. } => Some(path.name()),
        }
    }
}

/// Changes by kind.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct ChangeCounts {
    pub added: u32,
    pub modified: u32,
    pub deleted: u32,
    pub moved: u32,
}

impl ChangeCounts {
    fn count(&mut self, op: ChangeOp) {
        let slot = match op {
            ChangeOp::Add => &mut self.added,
            ChangeOp::Modify => &mut self.modified,
            ChangeOp::Delete => &mut self.deleted,
            ChangeOp::Move => &mut self.moved,
        };
        *slot = slot.saturating_add(1);
    }
}

impl Workspace {
    /// What the chosen items and every metadata change commit (ipc-m2.md §6.4); resolve the
    /// UI's selection first ([`Workspace::resolve`]).
    pub fn summarize(&self, chosen: &Chosen) -> SelectionSummary {
        let mut groups = Groups {
            workspace: self,
            groups: BTreeMap::new(),
        };
        let mut selected = 0;
        for (index, item) in self.items.iter().enumerate() {
            let change = item.change();
            let group = groups.at(change.path(), change.kind());
            group.items += 1;
            group.required += u32::from(item.is_required());
            group.available += u32::from(item.is_required() || item.is_includable());
            let included = chosen.contains(index);
            group.tags += u32::from(item.tags_changed() && (included || keeps_new_tags(item)));
            if included {
                selected += 1;
                group.selected += 1;
                match change.kind() {
                    EntryKind::File => group.files.count(change.op()),
                    EntryKind::Folder => group.folders.count(change.op()),
                }
            }
        }
        let mut summary = SelectionSummary {
            items: count(selected),
            metadata: count(self.metadata.len()),
            ..SelectionSummary::default()
        };
        for change in &self.metadata {
            match change.subject() {
                Subject::Tags(tags) => groups.at(&tags.path, tags.kind).tags += 1,
                Subject::Semester(SettingsChange { path, .. })
                | Subject::Course(SettingsChange { path, .. }) => {
                    groups.at(path, EntryKind::Folder).settings = true;
                }
                Subject::TagDefinitions { .. } => summary.tag_definitions = true,
                Subject::Library { .. } => summary.library = true,
                Subject::IgnoreRules { .. } => summary.ignore_rules = true,
            }
        }
        summary.groups = groups.groups.into_values().collect();
        summary
    }

    /// The place whose folder is at `at` (`None`: the library root).
    fn place(&self, at: Option<RelPath>) -> Place {
        let Some(path) = at else {
            return Place::Library;
        };
        let folder = self.places.folder(&path);
        if path.depth() == 1 {
            Place::Semester { path, folder }
        } else {
            let code = self.places.code(&path).cloned();
            Place::Course { path, folder, code }
        }
    }
}

/// Whether an entry of `item` with a tag change stays in a commit that leaves `item` out, with its
/// new tags: a modified entry, at its path, or a moved one, at its old path (versioning.md §6.4).
/// In time linear in the item's changes and tag changes: a bound item can have thousands of both.
fn keeps_new_tags(item: &Item) -> bool {
    let kept: HashSet<EntryId> = item
        .changes()
        .filter(|change| matches!(change.op(), ChangeOp::Modify | ChangeOp::Move))
        .filter_map(|change| change.entry())
        .collect();
    !kept.is_empty()
        && item
            .tag_changes()
            .iter()
            .any(|tags| kept.contains(&tags.entry))
}

/// The groups of a summary, by the path of their place's folder; `None`, the library root,
/// sorts first.
struct Groups<'a> {
    workspace: &'a Workspace,
    groups: BTreeMap<Option<RelPath>, SummaryGroup>,
}

impl Groups<'_> {
    /// The group of the place a change at `path`, a `kind`, belongs to.
    fn at(&mut self, path: &RelPath, kind: EntryKind) -> &mut SummaryGroup {
        let at = place_of(path, kind);
        let workspace = self.workspace;
        self.groups
            .entry(at.clone())
            .or_insert_with(|| SummaryGroup::new(workspace.place(at)))
    }
}

/// The folder of the place a change at `path`, a `kind`, belongs to: a course's or a semester's;
/// `None` for the library root.
fn place_of(path: &RelPath, kind: EntryKind) -> Option<RelPath> {
    let depth = path.depth();
    let folder = kind == EntryKind::Folder;
    if depth > 2 || (depth == 2 && folder) {
        Some(match path.course_and_rest() {
            Some((course, _)) => course.path().clone(),
            None => path.clone(),
        })
    } else if depth > 1 || folder {
        Some(match path.semester_and_rest() {
            Some((semester, _)) => semester.path().clone(),
            None => path.clone(),
        })
    } else {
        None
    }
}
