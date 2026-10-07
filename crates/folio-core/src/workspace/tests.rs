mod bound;
mod metadata;
mod property;
mod summaries;

use std::collections::{HashMap, HashSet};

use super::testing::{describe, describe_item, described};
use super::*;
use crate::catalog::EntryId;
use crate::catalog::queries::{MAX_PAGE_SIZE, PageRequest, QueryError};
use crate::hash::ContentHash;
use crate::meta::{EntryKind, FileClass, VersioningRules};
use crate::paths::{MAX_PATH_UNITS, RelPath};
use crate::store::ChangeOp;
use crate::test_support::path;

/// `HEAD`'s rows, each with the entry it is paired with, and the disk's entries: what the catalog
/// holds. [`Scene::comparison`] reads it as the catalog's loader does: the paired rows that
/// differ from their entries or are below a folder row that is not in place, the rows without
/// one, and the entries no row pairs with.
#[derive(Default, Clone)]
struct Scene {
    head: Vec<(HeadRow, Option<i64>)>,
    disk: Vec<DiskRow>,
}

impl Scene {
    fn row(mut self, row: HeadRow, entry: Option<i64>) -> Self {
        self.head.push((row, entry));
        self
    }

    fn entry(mut self, entry: DiskRow) -> Self {
        self.disk.push(entry);
        self
    }

    /// A file `HEAD` has at `from` with `before`, now at `to` with `after` as entry `id`.
    fn kept(self, id: i64, from: &str, before: &str, to: &str, after: &str) -> Self {
        self.row(head_file(from, before), Some(id))
            .entry(disk_file(id, to, after))
    }

    /// A file of `HEAD`'s with no entry.
    fn gone(self, from: &str, before: &str) -> Self {
        self.row(head_file(from, before), None)
    }

    fn added(self, id: i64, to: &str, after: &str) -> Self {
        self.entry(disk_file(id, to, after))
    }

    fn kept_folder(self, id: i64, from: &str, to: &str) -> Self {
        self.row(head_folder(from), Some(id))
            .entry(disk_folder(id, to))
    }

    fn gone_folder(self, from: &str) -> Self {
        self.row(head_folder(from), None)
    }

    fn added_folder(self, id: i64, to: &str) -> Self {
        self.entry(disk_folder(id, to))
    }

    /// Entry `id`'s content is not hashed yet, and the hashing job found it `blocked`.
    fn unhashed(mut self, id: i64, blocked: Option<Blocked>) -> Self {
        let entry = self.entry_mut(id);
        entry.hash = None;
        entry.blocked = blocked;
        self
    }

    /// Entry `id` has `size` bytes, whatever its content.
    fn sized(mut self, id: i64, size: u64) -> Self {
        self.entry_mut(id).size = size;
        self
    }

    fn entry_mut(&mut self, id: i64) -> &mut DiskRow {
        self.disk
            .iter_mut()
            .find(|entry| entry.entry == EntryId(id))
            .expect("the scene has the entry")
    }

    fn comparison(&self) -> Comparison {
        // Every folder entry says whether anything is below it: a pairing of two kinds makes an
        // addition of a paired entry too.
        let disk: Vec<DiskRow> = self
            .disk
            .iter()
            .map(|entry| {
                let below = format!("{}/", entry.path);
                let mut entry = entry.clone();
                entry.empty = entry.kind == EntryKind::Folder
                    && !self
                        .disk
                        .iter()
                        .any(|other| other.path.as_str().starts_with(&below));
                entry
            })
            .collect();
        let entries: HashMap<EntryId, &DiskRow> =
            disk.iter().map(|entry| (entry.entry, entry)).collect();
        // Folder rows that are not in place: every row below them is passed.
        let displaced: HashSet<&str> = self
            .head
            .iter()
            .filter(|(row, id)| {
                row.kind() == EntryKind::Folder
                    && id.is_none_or(|id| {
                        let entry = entries[&EntryId(id)];
                        entry.path != row.path || entry.kind != row.kind()
                    })
            })
            .map(|(row, _)| row.path.as_str())
            .collect();
        let mut paired_ids = HashSet::new();
        let mut comparison = Comparison::default();
        for (row, id) in &self.head {
            match id {
                Some(id) => {
                    let entry = entries[&EntryId(*id)];
                    paired_ids.insert(entry.entry);
                    let below_displaced = row
                        .path
                        .ancestors()
                        .skip(1)
                        .any(|folder| displaced.contains(folder.as_str()));
                    if differs(row, entry) || below_displaced {
                        comparison.paired.push((row.clone(), entry.clone()));
                    }
                }
                None => comparison.deleted.push(row.clone()),
            }
        }
        comparison.added = disk
            .iter()
            .filter(|entry| !paired_ids.contains(&entry.entry))
            .cloned()
            .collect();
        comparison
    }

    fn workspace(&self) -> Workspace {
        Workspace::new(self.comparison(), &VersioningRules::default())
    }
}

/// The scene's `HEAD` rows, as `head_files` holds them, with folders in place for every parent
/// the scene does not list.
fn head_rows(scene: &Scene) -> Vec<HeadRow> {
    let mut rows: Vec<HeadRow> = scene.head.iter().map(|(row, _)| row.clone()).collect();
    let listed: HashSet<RelPath> = rows.iter().map(|row| row.path.clone()).collect();
    let mut parents: Vec<RelPath> = rows
        .iter()
        .flat_map(|row| row.path.ancestors().skip(1))
        .filter(|parent| !listed.contains(parent))
        .collect();
    parents.sort_unstable();
    parents.dedup();
    rows.extend(parents.into_iter().map(|path| HeadRow { path, file: None }));
    rows
}

/// What the loader compares: another path or kind, another size, a known other hash.
fn differs(row: &HeadRow, entry: &DiskRow) -> bool {
    row.path != entry.path
        || row.kind() != entry.kind
        || row.file.as_ref().is_some_and(|file| {
            file.size != entry.size || entry.hash.as_ref().is_some_and(|hash| *hash != file.hash)
        })
}

fn hash(content: &str) -> ContentHash {
    ContentHash::of(content.as_bytes())
}

fn head_file(at: &str, content: &str) -> HeadRow {
    let at = path(at);
    let size = content.len() as u64;
    let rules = VersioningRules::default();
    let stored = rules.is_stored(rules.class_of(&at), size);
    HeadRow {
        path: at,
        file: Some(HeadFile {
            hash: hash(content),
            size,
            stored,
        }),
    }
}

fn head_folder(at: &str) -> HeadRow {
    HeadRow {
        path: path(at),
        file: None,
    }
}

fn disk_file(id: i64, at: &str, content: &str) -> DiskRow {
    let at = path(at);
    DiskRow {
        entry: EntryId(id),
        class: VersioningRules::default().class_of(&at),
        path: at,
        kind: EntryKind::File,
        size: content.len() as u64,
        hash: Some(hash(content)),
        blocked: None,
        empty: false,
    }
}

fn disk_folder(id: i64, at: &str) -> DiskRow {
    DiskRow {
        entry: EntryId(id),
        path: path(at),
        kind: EntryKind::Folder,
        class: FileClass::Other,
        size: 0,
        hash: None,
        blocked: None,
        empty: false,
    }
}

/// The change whose key starts with `key_start` at `at`, an item's main change or a part.
fn item<'a>(workspace: &'a Workspace, key_start: &str, at: &str) -> &'a Change {
    workspace
        .items()
        .iter()
        .flat_map(Item::changes)
        .find(|change| change.key().starts_with(key_start) && change.path().as_str() == at)
        .unwrap_or_else(|| panic!("no {key_start} change at {at}"))
}

fn covered(change: &Change) -> Vec<&str> {
    let mut paths: Vec<&str> = change.covered().iter().map(RelPath::as_str).collect();
    paths.sort_unstable();
    paths
}

fn page(offset: u32, limit: u32) -> PageRequest {
    PageRequest { offset, limit }
}

// ---- items (versioning.md §6.3)

#[test]
fn files_are_added_deleted_modified_and_moved() {
    let workspace = Scene::default()
        .added(1, "new.md", "new")
        .gone("old.md", "old")
        .kept(2, "notes.md", "v1", "notes.md", "v2")
        .kept(3, "a.md", "same", "b.md", "same")
        .kept(4, "c.md", "before", "d.md", "after")
        .kept(5, "same.md", "same", "same.md", "same")
        .workspace();
    assert_eq!(
        described(&workspace),
        [
            "move file b.md from a.md",
            "move file d.md from c.md edited",
            "add file new.md",
            "modify file notes.md",
            "delete file old.md",
        ]
    );

    let added = item(&workspace, "fa:", "new.md");
    assert_eq!(added.entry(), Some(EntryId(1)));
    assert_eq!(added.before(), None);
    assert_eq!(
        added.after(),
        Some(ItemSide {
            size: 3,
            stored: true
        })
    );
    assert_eq!(added.class(), FileClass::Text);
    assert!(!added.content_changed());
    assert!(added.head().is_none());

    let deleted = item(&workspace, "fd:", "old.md");
    assert_eq!(deleted.entry(), None);
    assert_eq!(
        deleted.before(),
        Some(ItemSide {
            size: 3,
            stored: true
        })
    );
    assert_eq!(deleted.after(), None);
    assert_eq!(deleted.class(), FileClass::Text);
    assert!(deleted.disk().is_none());

    let modified = item(&workspace, "fm:", "notes.md");
    assert!(modified.content_changed());
    assert_eq!(modified.from_path(), None);
    assert_eq!(modified.entry(), Some(EntryId(2)));
    assert_eq!(
        modified.head().map(|row| row.path.as_str()),
        Some("notes.md")
    );

    let moved = item(&workspace, "fv", "b.md");
    assert!(!moved.content_changed());
    assert_eq!(moved.from_path().map(RelPath::as_str), Some("a.md"));
    assert!(moved.before().is_some() && moved.after().is_some());
    assert!(item(&workspace, "fv", "d.md").content_changed());
    for change in workspace.items().iter().map(Item::change) {
        assert_eq!(change.covered(), &[] as &[RelPath]);
        assert_eq!(change.files(), 0);
    }
}

#[test]
fn a_folder_move_covers_what_moved_with_it() {
    let workspace = Scene::default()
        .kept_folder(1, "F", "G")
        .kept(2, "F/a.md", "a", "G/a.md", "a")
        .kept(3, "F/b.pdf", "b", "G/b.pdf", "b")
        .kept(4, "F/c.md", "c", "G/c.md", "c, edited")
        .gone("F/d.md", "d")
        .kept(5, "F/e.md", "e", "H/e.md", "e")
        .kept_folder(6, "F/S", "G/S")
        .kept(7, "F/S/z.md", "z", "G/S/z.md", "z")
        .added(8, "G/new.md", "new")
        .workspace();
    assert_eq!(
        described(&workspace),
        [
            "delete file F/d.md",
            "move folder G from F files 3",
            "modify file G/c.md",
            "add file G/new.md",
            "move file H/e.md from F/e.md",
        ]
    );
    let moved = item(&workspace, "dv", "G");
    assert_eq!(
        covered(moved),
        ["F/S", "F/S/z.md", "F/a.md", "F/b.pdf", "F/c.md"]
    );
    assert_eq!(moved.before(), None);
    assert_eq!(moved.after(), None);
    assert_eq!(moved.class(), FileClass::Other);
    assert_eq!(moved.entry(), Some(EntryId(1)));
    // An edit inside the moved folder is a modification at its new path, from HEAD's row.
    let edited = item(&workspace, "fm:", "G/c.md");
    assert_eq!(edited.from_path(), None);
    assert_eq!(edited.head().map(|row| row.path.as_str()), Some("F/c.md"));
    assert!(edited.content_changed());
}

#[test]
fn nested_folder_moves_have_frames_of_their_own() {
    let workspace = Scene::default()
        .kept_folder(1, "F", "G")
        // Renamed inside the moved folder: a move of its own, in G's frame.
        .kept_folder(2, "F/S", "G/T")
        .kept(3, "F/S/z.md", "z", "G/T/z.md", "z")
        .kept(4, "F/S/y.md", "y", "G/y.md", "y")
        // Carried by F's move, and its child too.
        .kept_folder(5, "F/U", "G/U")
        .kept(6, "F/U/q.md", "q", "G/U/q.md", "q")
        // Renamed inside a carried folder.
        .kept(7, "F/U/r.md", "r", "G/U/r2.md", "r")
        // A subfolder moved out of the moved folder, carrying its own.
        .kept_folder(8, "F/V", "X/V")
        .kept(9, "F/V/w.md", "w", "X/V/w.md", "w")
        .kept(10, "F/a.md", "a", "G/a.md", "a")
        .workspace();
    assert_eq!(
        described(&workspace),
        [
            "move folder G from F files 2",
            "move folder G/T from F/S files 1",
            "move file G/U/r2.md from F/U/r.md",
            "move file G/y.md from F/S/y.md",
            "move folder X/V from F/V files 1",
        ]
    );
    assert_eq!(
        covered(item(&workspace, "dv", "G")),
        ["F/U", "F/U/q.md", "F/a.md"]
    );
    assert_eq!(covered(item(&workspace, "dv", "G/T")), ["F/S/z.md"]);
    assert_eq!(covered(item(&workspace, "dv", "X/V")), ["F/V/w.md"]);
}

#[test]
fn rows_in_place_change_nothing() {
    // Renamed, then the old name made again and one file moved back: it is in place, not carried.
    let scene = Scene::default()
        .kept_folder(1, "F", "G")
        .kept(2, "F/a.md", "a", "G/a.md", "a")
        .kept(3, "F/home.md", "h", "F/home.md", "h")
        .added_folder(4, "F");
    let workspace = scene.workspace();
    assert_eq!(described(&workspace), ["move folder G from F files 1"]);
    assert_eq!(covered(item(&workspace, "dv", "G")), ["F/a.md"]);

    // The loader may pass rows in place too: they are no change.
    let mut comparison = scene.comparison();
    for (row, id) in &scene.head {
        let entry = scene
            .disk
            .iter()
            .find(|entry| Some(entry.entry.0) == *id)
            .unwrap();
        if !differs(row, entry) {
            comparison.paired.push((row.clone(), entry.clone()));
        }
    }
    comparison
        .paired
        .push((head_folder("Other"), disk_folder(9, "Other")));
    assert_eq!(
        Workspace::new(comparison, &VersioningRules::default()),
        workspace
    );
}

#[test]
fn a_folder_deletion_covers_what_was_deleted_with_it() {
    let workspace = Scene::default()
        .gone_folder("D")
        .gone("D/a.md", "a")
        .gone_folder("D/E")
        .gone("D/E/b.pdf", "b")
        .gone_folder("D/E/Empty")
        // Left before the folder went: items of their own.
        .kept(1, "D/m.md", "m", "m.md", "m")
        .kept_folder(2, "D/S", "X/S")
        .kept(3, "D/S/v.md", "v", "X/S/v.md", "v")
        .gone("D/S/u.md", "u")
        .workspace();
    // What left the deleted folder is bound to its deletion (rule 2); a deletion inside a
    // subfolder that moved out is not.
    assert_eq!(
        described(&workspace),
        [
            "delete file D/S/u.md",
            "move folder X/S from D/S files 1 + delete folder D files 2 + move file m.md from D/m.md",
        ]
    );
    let deleted = item(&workspace, "dd:", "D");
    assert_eq!(
        covered(deleted),
        ["D/E", "D/E/Empty", "D/E/b.pdf", "D/a.md"]
    );
    assert_eq!(deleted.entry(), None);
    assert_eq!(deleted.before(), None);
    assert_eq!(deleted.class(), FileClass::Other);
    assert_eq!(deleted.readiness(), Readiness::Ready);

    // Another folder moved to the deleted one's place, where a file stayed: the file is in place,
    // and the deletion covers only what went.
    let workspace = Scene::default()
        .gone_folder("D")
        .kept(1, "D/x.md", "x", "D/x.md", "x")
        .gone("D/y.md", "y")
        .kept_folder(2, "H", "D")
        .kept(3, "H/z.md", "z", "D/z.md", "z")
        .workspace();
    assert_eq!(
        described(&workspace),
        ["move folder D from H files 1 + delete folder D files 1"]
    );
    assert_eq!(covered(item(&workspace, "dd:", "D")), ["D/y.md"]);
    assert_eq!(covered(item(&workspace, "dv", "D")), ["H/z.md"]);
}

#[test]
fn only_empty_new_folders_are_items() {
    let workspace = Scene::default()
        .added_folder(1, "Empty")
        .added_folder(2, "N")
        .added(3, "N/f.md", "f")
        .added_folder(4, "P")
        .kept(5, "g.md", "g", "P/g.md", "g")
        .added_folder(6, "Q")
        .added_folder(7, "Q/R")
        .workspace();
    assert_eq!(
        described(&workspace),
        [
            "add folder Empty",
            "add file N/f.md",
            "move file P/g.md from g.md",
            "add folder Q/R",
        ]
    );
    let empty = item(&workspace, "da:", "Empty");
    assert_eq!(empty.files(), 0);
    assert_eq!(empty.after(), None);
    assert_eq!(empty.entry(), Some(EntryId(1)));
}

#[test]
fn a_pairing_of_two_kinds_is_a_deletion_and_an_addition() {
    let workspace = Scene::default()
        .row(head_file("x", "x"), Some(1))
        .entry(disk_folder(1, "x"))
        .row(head_folder("y"), Some(2))
        .entry(disk_file(2, "y", "y"))
        .gone("y/child.md", "c")
        .workspace();
    // Each pair takes the same place: bound (rule 1).
    assert_eq!(
        described(&workspace),
        [
            "add folder x + delete file x",
            "add file y + delete folder y files 1"
        ]
    );
}

#[test]
fn folio_paths_are_never_changes() {
    let workspace = Scene::default()
        .gone_folder(".folio")
        .gone(".folio/tags.json", "{}")
        .gone(".folio/meta/_root.json", "{}")
        .added(1, ".folio/ignore", "*.tmp")
        .added(2, "kept.md", "k")
        .workspace();
    assert_eq!(described(&workspace), ["add file kept.md"]);
}

/// The small workspace of the fake shell (apps/desktop/src/ipc/mock/versioning/fixtures.ts): the
/// move onto Kinematics.md is bound to its deletion, one row with a part.
#[test]
fn the_fake_shells_small_workspace() {
    use small::{CSC, ECO, LINEAR, MAT, PHY, at};
    let workspace = small::scene().workspace();
    let expected = [
        format!("add file {CSC}/a1/run.bat hashing"),
        format!("add file {CSC}/a1/starter/test_tree.py"),
        format!("add file {CSC}/a1/starter/tree.py"),
        format!("modify file {CSC}/labs/lab1/report.docx"),
        format!("add file {ECO}/Lecture recording week 5.mp4 unreadable"),
        format!("modify file {ECO}/Supply and demand.png"),
        format!("modify file {MAT}/Exams/Midterm/Midterm review.md"),
        format!("delete file {MAT}/Old slides L2.pdf"),
        format!("move file {MAT}/Problem sets/ps2 solutions.md from {MAT}/ps2 solutions.md"),
        format!("move folder {LINEAR}/习题 from {LINEAR}/Exercises files 4"),
        "add file Personal/Photos/IMG_2031.HEIC notLocal".to_owned(),
        format!(
            "move file {PHY}/Kinematics.md from {PHY}/notes/Kinematics.md edited \
             + delete file {PHY}/Kinematics.md"
        ),
    ];
    assert_eq!(described(&workspace), expected);
    let kinematics = &workspace.items()[11];
    assert_eq!(kinematics.change().op(), ChangeOp::Move);
    assert_eq!(kinematics.parts().len(), 1);
    assert_eq!(kinematics.parts()[0].op(), ChangeOp::Delete);
    assert_eq!(kinematics.parts()[0].kind(), EntryKind::File);

    let png = item(&workspace, "fm:", &at(ECO, "Supply and demand.png"));
    assert_eq!(png.class(), FileClass::Other);
    assert_eq!(png.before().map(|side| side.stored), Some(false));
    assert_eq!(png.after().map(|side| side.stored), Some(false));
    let report = item(&workspace, "fm:", &at(CSC, "labs/lab1/report.docx"));
    assert_eq!(report.class(), FileClass::Word);
    assert_eq!(
        report.after(),
        Some(ItemSide {
            size: 64_000,
            stored: true
        })
    );
    assert_eq!(
        workspace.totals(),
        Totals {
            items: 12,
            metadata: 0,
            includable: 10,
            hashing: 1,
            not_local: 1,
            unreadable: 1,
        }
    );
}

/// The fake shell's small library (apps/desktop/src/ipc/mock/versioning/fixtures.ts).
mod small {
    use super::Scene;
    use crate::workspace::Blocked;

    pub(super) const MAT: &str = "Fall 2026/MAT232 Calculus of Several Variables";
    pub(super) const LINEAR: &str = "Fall 2026/线性代数";
    pub(super) const CSC: &str = "Fall 2026/CSC148 Introduction to Computer Science";
    pub(super) const ECO: &str = "Fall 2026/ECO101 微观经济学";
    pub(super) const PHY: &str = "Winter 2026/PHY131 Introduction to Physics I";

    pub(super) fn at(folder: &str, rest: &str) -> String {
        format!("{folder}/{rest}")
    }

    /// Its workspace's files: entries 1 to 18.
    pub(super) fn scene() -> Scene {
        let mut scene = Scene::default()
            .kept(
                1,
                &at(MAT, "Exams/Midterm/Midterm review.md"),
                "review 3",
                &at(MAT, "Exams/Midterm/Midterm review.md"),
                "review 4",
            )
            .kept(
                2,
                &at(CSC, "labs/lab1/report.docx"),
                "report 1",
                &at(CSC, "labs/lab1/report.docx"),
                "report 2",
            )
            .sized(2, 64_000)
            .kept(
                3,
                &at(ECO, "Supply and demand.png"),
                "supply",
                &at(ECO, "Supply and demand.png"),
                "supply, larger",
            )
            .added_folder(4, &at(CSC, "a1"))
            .added_folder(5, &at(CSC, "a1/starter"))
            .added(6, &at(CSC, "a1/starter/tree.py"), "class Tree")
            .added(7, &at(CSC, "a1/starter/test_tree.py"), "def test_empty")
            .added(8, &at(CSC, "a1/run.bat"), "python -m pytest")
            .unhashed(8, None)
            .gone(&at(MAT, "Old slides L2.pdf"), "old slides")
            .added_folder(9, &at(MAT, "Problem sets"))
            .kept(
                10,
                &at(MAT, "ps2 solutions.md"),
                "ps2",
                &at(MAT, "Problem sets/ps2 solutions.md"),
                "ps2",
            )
            .kept_folder(11, &at(LINEAR, "Exercises"), &at(LINEAR, "习题"));
        for n in 1..=4 {
            let name = format!("习题 {n}.docx");
            scene = scene.kept(
                11 + n,
                &at(LINEAR, &format!("Exercises/{name}")),
                &name,
                &at(LINEAR, &format!("习题/{name}")),
                &name,
            );
        }
        scene
            .kept(
                16,
                &at(PHY, "notes/Kinematics.md"),
                "v = u + at",
                &at(PHY, "Kinematics.md"),
                "v = u + at; 匀加速直线运动",
            )
            .gone(&at(PHY, "Kinematics.md"), "old kinematics")
            .added(17, "Personal/Photos/IMG_2031.HEIC", "img")
            .unhashed(17, Some(Blocked::NotLocal))
            .added(18, &at(ECO, "Lecture recording week 5.mp4"), "recording")
            .unhashed(18, Some(Blocked::Unreadable))
    }
}

// ---- unknown hashes (lane decision 10) and readiness (versioning.md §6.2)

#[test]
fn an_unknown_hash_is_a_change_only_with_another_size() {
    let workspace = Scene::default()
        .kept(1, "same size.md", "aaaa", "same size.md", "bbbb")
        .unhashed(1, None)
        .kept(2, "other size.md", "aaaa", "other size.md", "bbbbbb")
        .unhashed(2, None)
        .kept(3, "moved.md", "aaaa", "moved 2.md", "bbbb")
        .unhashed(3, None)
        .kept(4, "grown.md", "aaaa", "grown 2.md", "bbbbbb")
        .unhashed(4, None)
        .kept_folder(5, "F", "G")
        .kept(6, "F/carried.md", "aaaa", "G/carried.md", "bbbb")
        .unhashed(6, None)
        .kept(
            7,
            "F/carried, grown.md",
            "aaaa",
            "G/carried, grown.md",
            "bbbbbb",
        )
        .unhashed(7, None)
        .workspace();
    assert_eq!(
        described(&workspace),
        [
            "move folder G from F files 1",
            "modify file G/carried, grown.md hashing",
            "move file grown 2.md from grown.md edited hashing",
            "move file moved 2.md from moved.md hashing",
            "modify file other size.md hashing",
        ]
    );
    // A known hash decides whatever the size: equal content is no change.
    let hashed = Scene::default()
        .kept(1, "a.md", "same", "a.md", "same")
        .kept(2, "b.md", "same", "b2.md", "same")
        .workspace();
    assert_eq!(described(&hashed), ["move file b2.md from b.md"]);
}

#[test]
fn readiness_comes_from_why_a_file_is_unhashed() {
    let workspace = Scene::default()
        .added(1, "hashing.md", "h")
        .unhashed(1, None)
        .added(2, "cloud.md", "c")
        .unhashed(2, Some(Blocked::NotLocal))
        .sized(2, 3 * 1024 * 1024)
        .added(3, "locked.md", "l")
        .unhashed(3, Some(Blocked::Unreadable))
        .added(4, "film.mp4", "f")
        .unhashed(4, Some(Blocked::NotLocal))
        .kept(5, "edited.md", "e", "edited.md", "e, offline")
        .unhashed(5, Some(Blocked::NotLocal))
        .workspace();
    let readiness = |code: &str, at: &str| item(&workspace, code, at).readiness();
    assert_eq!(readiness("fa:", "hashing.md"), Readiness::Hashing);
    assert_eq!(readiness("fa:", "cloud.md"), Readiness::NotLocal);
    assert_eq!(readiness("fa:", "locked.md"), Readiness::Unreadable);
    assert_eq!(readiness("fm:", "edited.md"), Readiness::NotLocal);
    // Not local: the disk side's size is 0; whether it is stored follows its real size.
    assert_eq!(
        item(&workspace, "fa:", "cloud.md").after(),
        Some(ItemSide {
            size: 0,
            stored: true
        })
    );
    assert_eq!(
        item(&workspace, "fa:", "film.mp4").after(),
        Some(ItemSide {
            size: 0,
            stored: false
        })
    );
    assert_eq!(
        item(&workspace, "fa:", "locked.md").after(),
        Some(ItemSide {
            size: 1,
            stored: true
        })
    );
    let edited = item(&workspace, "fm:", "edited.md");
    assert_eq!(edited.before().map(|side| side.size), Some(1));
    assert_eq!(edited.after().map(|side| side.size), Some(0));
    assert_eq!(
        workspace.totals(),
        Totals {
            items: 5,
            metadata: 0,
            includable: 1,
            hashing: 1,
            not_local: 3,
            unreadable: 1,
        }
    );
    assert!(Readiness::Ready.is_includable() && Readiness::Hashing.is_includable());
    assert!(!Readiness::NotLocal.is_includable() && !Readiness::Unreadable.is_includable());
}

#[test]
fn a_known_hash_makes_a_file_ready_whatever_the_reason_recorded() {
    let mut scene = Scene::default().added(1, "a.md", "a");
    scene.entry_mut(1).blocked = Some(Blocked::NotLocal);
    let workspace = scene.workspace();
    assert_eq!(workspace.items()[0].readiness(), Readiness::Ready);

    // Deletions and folders are always ready.
    let workspace = Scene::default()
        .gone("gone.md", "g")
        .kept_folder(1, "F", "G")
        .added_folder(2, "E")
        .workspace();
    assert!(
        workspace
            .items()
            .iter()
            .all(|item| item.readiness() == Readiness::Ready)
    );
}

#[test]
fn files_count_what_a_folder_change_covers_without_an_item_of_its_own() {
    let workspace = Scene::default()
        .kept_folder(1, "F", "G")
        .kept(2, "F/a.md", "a", "G/a.md", "a 2")
        .kept(3, "F/b.md", "b", "G/b.md", "b 2")
        .kept_folder(4, "F/S", "G/S")
        .gone_folder("D")
        .gone_folder("D/E")
        .gone_folder("D/E/F")
        .workspace();
    assert_eq!(
        described(&workspace),
        [
            "delete folder D",
            "move folder G from F",
            "modify file G/a.md",
            "modify file G/b.md",
        ]
    );
    assert_eq!(item(&workspace, "dd:", "D").files(), 0);
    assert_eq!(covered(item(&workspace, "dd:", "D")), ["D/E", "D/E/F"]);
}

// ---- keys and the fingerprint (versioning.md §6.5, ipc-m2.md §5.1)

#[test]
fn keys_name_the_code_and_the_main_path() {
    let workspace = Scene::default()
        .added(1, "a.md", "a")
        .gone("b.md", "b")
        .kept(2, "c.md", "c", "c.md", "c 2")
        .kept(3, "d.md", "d", "e.md", "d")
        .added_folder(4, "f")
        .gone_folder("g")
        .kept_folder(5, "h", "i")
        .workspace();
    let origin = |from: &str| blake3::hash(from.as_bytes()).to_hex()[..16].to_owned();
    let mut keys: Vec<&str> = workspace.items().iter().map(Item::key).collect();
    keys.sort_unstable();
    let mut expected = vec![
        "fa:a.md".to_owned(),
        "fd:b.md".to_owned(),
        "fm:c.md".to_owned(),
        format!("fv{}:e.md", origin("d.md")),
        "da:f".to_owned(),
        "dd:g".to_owned(),
        format!("dv{}:i", origin("h")),
    ];
    expected.sort_unstable();
    assert_eq!(keys, expected);
    for item in workspace.items() {
        assert_eq!(item.key(), item.change().key());
        assert_eq!(item.parts(), &[] as &[Change]);
    }
}

#[test]
fn keys_fit_the_limit_for_the_longest_path() {
    // 128 names of 255 units and 127 slashes: 32,767 UTF-16 code units, the most a path has.
    let name = "a".repeat(255);
    let long = vec![name.as_str(); 128].join("/");
    assert_eq!(long.encode_utf16().count(), MAX_PATH_UNITS);
    let other = format!("{}/b", vec![name.as_str(); 127].join("/"));
    let scene = Scene::default()
        .kept(1, &other, "x", &long, "y")
        .gone(&long[..long.len() - 1], "z");
    let workspace = scene.workspace();
    assert_eq!(workspace.items().len(), 2);
    let longest = workspace
        .items()
        .iter()
        .map(|item| item.key().chars().count())
        .max()
        .unwrap();
    assert_eq!(longest, 19 + MAX_PATH_UNITS);
    assert!(longest <= MAX_KEY_CHARS);
}

#[test]
fn moves_from_elsewhere_have_other_keys() {
    let from_a = Scene::default()
        .kept(1, "a.md", "x", "c.md", "x")
        .workspace();
    let from_b = Scene::default()
        .kept(1, "b.md", "x", "c.md", "x")
        .workspace();
    assert_ne!(from_a.items()[0].key(), from_b.items()[0].key());
    assert_ne!(from_a.fingerprint(), from_b.fingerprint());
}

#[test]
fn an_empty_workspace_has_a_fingerprint_of_zeros() {
    assert_eq!(Workspace::empty().fingerprint().to_string(), "0".repeat(32));
    let unchanged = Scene::default()
        .kept(1, "a.md", "a", "a.md", "a")
        .workspace();
    assert_eq!(unchanged.fingerprint().to_string(), "0".repeat(32));
    assert_eq!(unchanged, Workspace::empty());
}

#[test]
fn the_fingerprint_follows_keys_and_includability() {
    let base = || {
        Scene::default()
            .added(1, "new.md", "new")
            .gone("old.md", "old")
            .kept(2, "notes.md", "v1", "notes.md", "v2")
            .kept_folder(3, "F", "G")
            .kept(4, "F/a.md", "a", "G/a.md", "a")
    };
    let fingerprint = base().workspace().fingerprint();
    let text = fingerprint.to_string();
    assert_eq!(text.len(), 32);
    assert!(text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f')));

    // Order-free: the same comparison in another order.
    let mut reversed = base().comparison();
    reversed.paired.reverse();
    reversed.deleted.reverse();
    reversed.added.reverse();
    let reversed = Workspace::new(reversed, &VersioningRules::default());
    assert_eq!(reversed.fingerprint(), fingerprint);
    assert_eq!(reversed, base().workspace());

    // An edit keeps the key, and the fingerprint.
    let edited = base()
        .kept(5, "x.md", "x", "x.md", "x")
        .workspace()
        .fingerprint();
    assert_eq!(edited, fingerprint, "a file in place is no change");
    let mut again = base();
    again.entry_mut(2).hash = Some(hash("v3"));
    assert_eq!(again.workspace().fingerprint(), fingerprint);
    // Hashing and ready count the same.
    assert_eq!(
        base().unhashed(1, None).workspace().fingerprint(),
        fingerprint
    );

    // A file that stops being includable, or becomes includable, changes it; why it is blocked
    // does not.
    let offline = base().unhashed(1, Some(Blocked::NotLocal)).workspace();
    assert_ne!(offline.fingerprint(), fingerprint);
    let locked = base().unhashed(1, Some(Blocked::Unreadable)).workspace();
    assert_eq!(locked.fingerprint(), offline.fingerprint());
    assert_eq!(offline.totals().items, base().workspace().totals().items);

    // So do additions and removals.
    let more = base().added(9, "more.md", "m").workspace().fingerprint();
    assert_ne!(more, fingerprint);
    let mut fewer = base();
    fewer.disk.retain(|entry| entry.entry != EntryId(1));
    assert_ne!(fewer.workspace().fingerprint(), fingerprint);

    // A move from another origin to the same path.
    let moved_a = base().kept(6, "p.md", "p", "q.md", "p").workspace();
    let moved_b = base().kept(6, "r.md", "p", "q.md", "p").workspace();
    assert_ne!(moved_a.fingerprint(), moved_b.fingerprint());
    assert_eq!(moved_a.totals(), moved_b.totals());
}

// ---- order, totals and pages

#[test]
fn items_are_sorted_by_path_in_byte_order_then_by_key() {
    // A folder moved away and a new one took its place: the file of HEAD's folder that went and
    // the new folder's file have the same path, and are not bound (the addition is bound to the
    // folder move, whose place the new folder takes, and is the first writer by path).
    let workspace = Scene::default()
        .added(1, "a/x.md", "x")
        .added(2, "a b.md", "y")
        .added(3, "Z.md", "z")
        .added(4, "ä.md", "ä")
        .kept_folder(5, "same", "zz")
        .gone("same/x.md", "old")
        .added_folder(6, "same")
        .added(7, "same/x.md", "new")
        .workspace();
    let paths: Vec<&str> = workspace
        .items()
        .iter()
        .map(|item| item.change().path().as_str())
        .collect();
    assert_eq!(
        paths,
        ["Z.md", "a b.md", "a/x.md", "same/x.md", "same/x.md", "ä.md"]
    );
    let same: Vec<&str> = workspace.items()[3..5].iter().map(Item::key).collect();
    assert!(same[0].starts_with("fa:") && same[1].starts_with("fd:"));
    assert_eq!(workspace.items()[3].parts().len(), 1);
}

#[test]
fn pages_are_windows_of_the_sorted_items() {
    let mut scene = Scene::default();
    for n in 0..7 {
        scene = scene.added(n, &format!("file {n}.md"), "x");
    }
    let workspace = scene
        .unhashed(0, None)
        .unhashed(1, Some(Blocked::NotLocal))
        .workspace();
    fn keys(window: Window<'_, Item>) -> Vec<&str> {
        window.rows.iter().map(Item::key).collect()
    }
    let middle = workspace.item_page(page(2, 3)).unwrap();
    assert_eq!(middle.total, 7);
    assert_eq!(
        keys(middle),
        ["fa:file 2.md", "fa:file 3.md", "fa:file 4.md"]
    );
    let end = workspace.item_page(page(5, MAX_PAGE_SIZE)).unwrap();
    assert_eq!(keys(end), ["fa:file 5.md", "fa:file 6.md"]);
    let past = workspace.item_page(page(10, 5)).unwrap();
    assert!(past.rows.is_empty());
    assert_eq!(past.total, 7);
    let count = workspace.item_page(page(0, 0)).unwrap();
    assert!(count.rows.is_empty());
    assert_eq!(count.total, 7);
    let far = workspace.item_page(page(u32::MAX, MAX_PAGE_SIZE)).unwrap();
    assert!(far.rows.is_empty());
    assert!(matches!(
        workspace.item_page(page(0, MAX_PAGE_SIZE + 1)),
        Err(QueryError::InvalidArgument(_))
    ));
    assert_eq!(
        workspace.totals(),
        Totals {
            items: 7,
            metadata: 0,
            includable: 6,
            hashing: 1,
            not_local: 1,
            unreadable: 0,
        }
    );
    let empty = Workspace::empty();
    assert_eq!(empty.totals(), Totals::default());
    assert_eq!(empty.item_page(page(0, 10)).unwrap().total, 0);
}
