//! Metadata changes (versioning.md §6.4, ipc-m2.md §6.3), `HEAD`'s metadata read from its files,
//! and bound rule 4 (versioning.md §5.2).

use std::collections::{BTreeMap, BTreeSet};

use super::*;
use crate::meta::{
    Color, Content, CourseCode, CourseMeta, CourseSettings, DisplayName, Extension, GroupMeta,
    GroupSettings, LibraryConfig, LibraryId, MetaFile, RootMeta, Settings, TagDefinition,
    TagDefinitions, TagFile, TagId, tag_location, to_bytes,
};
use crate::test_support::{course_at, library_id, semester, tags};

/// A scene with metadata: `HEAD`'s `.folio/` files, and the disk's side as the catalog's mirror
/// holds it. [`World::workspace`] reads them as the loader does.
#[derive(Clone)]
pub(super) struct World {
    pub(super) scene: Scene,
    head_library: LibraryConfig,
    head_definitions: Option<TagDefinitions>,
    head_ignore: Option<Vec<u8>>,
    /// `HEAD`'s files of `.folio/meta/`.
    head_meta: BTreeMap<TagFile, Content>,
    /// Other files of `HEAD`'s `.folio/`, or anything else the store hands over, by path.
    head_files: Vec<(RelPath, Vec<u8>)>,
    /// The disk's side, but the tags and folders, which come from the scene.
    pub(super) disk: DiskMeta,
    /// The tags the catalog's mirror holds, by entry.
    disk_tags: BTreeMap<i64, BTreeSet<TagId>>,
}

impl World {
    /// The scene with the same library settings on both sides and nothing else.
    pub(super) fn new(scene: Scene) -> Self {
        let library = library("Folio");
        Self {
            scene,
            head_library: library.clone(),
            head_definitions: None,
            head_ignore: None,
            head_meta: BTreeMap::new(),
            head_files: Vec::new(),
            disk: DiskMeta {
                library: OnDisk::Read(library),
                definitions: OnDisk::Read(TagDefinitions::default()),
                ignore: OnDisk::Read(None),
                broken: Vec::new(),
                tags: Vec::new(),
                semesters: BTreeMap::new(),
                courses: BTreeMap::new(),
                folders: Vec::new(),
            },
            disk_tags: BTreeMap::new(),
        }
    }

    /// `HEAD`'s row at `at` has the tags `ids`, in the file and key where its tags belong.
    pub(super) fn head_tags<const N: usize>(mut self, at: &str, ids: [&str; N]) -> Self {
        let at = path(at);
        let kind = self
            .scene
            .head
            .iter()
            .find(|(row, _)| row.path == at)
            .map_or(EntryKind::File, |(row, _)| row.kind());
        let (file, key) = tag_location(&at, kind).expect("a path that can have tags");
        self.head_meta
            .entry(file)
            .or_default()
            .tags
            .set(key, tags(ids));
        self
    }

    /// Entry `id` has the tags `ids` in the catalog's mirror.
    pub(super) fn disk_tags<const N: usize>(mut self, id: i64, ids: [&str; N]) -> Self {
        self.disk_tags.insert(id, tags(ids));
        self
    }

    pub(super) fn head_semester(mut self, at: &str, order: u32) -> Self {
        let file = TagFile::Group(semester(at));
        self.head_meta.entry(file).or_default().settings = Some(Settings::Group(group(order)));
        self
    }

    pub(super) fn head_course(mut self, at: &str, code: &str) -> Self {
        let file = TagFile::Course(course_at(at));
        self.head_meta.entry(file).or_default().settings = Some(Settings::Course(course(code)));
        self
    }

    pub(super) fn disk_semester(mut self, at: &str, order: u32) -> Self {
        self.disk.semesters.insert(path(at), group(order));
        self
    }

    pub(super) fn disk_course(mut self, at: &str, code: &str) -> Self {
        self.disk.courses.insert(path(at), course(code));
        self
    }

    pub(super) fn head_definitions(mut self, definitions: TagDefinitions) -> Self {
        self.head_definitions = Some(definitions);
        self
    }

    pub(super) fn head_ignore(mut self, text: &str) -> Self {
        self.head_ignore = Some(text.as_bytes().to_vec());
        self
    }

    /// `HEAD`'s and the disk's versioning rules.
    pub(super) fn rules(mut self, head: VersioningRules, disk: VersioningRules) -> Self {
        self.head_library.versioning = head;
        if let OnDisk::Read(library) = &mut self.disk.library {
            library.versioning = disk;
        }
        self
    }

    /// `HEAD`'s `.folio/` files, as the store hands them over.
    fn files(&self) -> Vec<(RelPath, Vec<u8>)> {
        let mut files = self.head_files.clone();
        files.push((path(".folio/library.json"), bytes(&self.head_library)));
        if let Some(definitions) = &self.head_definitions {
            files.push((path(".folio/tags.json"), bytes(definitions)));
        }
        if let Some(ignore) = &self.head_ignore {
            files.push((path(".folio/ignore"), ignore.clone()));
        }
        for (file, content) in &self.head_meta {
            let at = format!(".folio/meta/{}", file.meta_path().unwrap());
            files.push((path(&at), content_bytes(file, content)));
        }
        files
    }

    pub(super) fn head(&self) -> HeadMeta {
        HeadMeta::parse(&self.files(), &head_rows(&self.scene)).unwrap()
    }

    /// The disk's side as the loader reads it: every entry with tags in the mirror or paired with
    /// a row that has tags in `HEAD`, and every semester and course folder, each with the row it
    /// is paired with when that row is of its kind.
    pub(super) fn disk_meta(&self, head: &HeadMeta) -> DiskMeta {
        let pairing: HashMap<EntryId, RelPath> = self
            .scene
            .head
            .iter()
            .filter_map(|(row, id)| {
                let entry = self.scene.disk.iter().find(|e| Some(e.entry.0) == *id)?;
                (entry.kind == row.kind()).then(|| (entry.entry, row.path.clone()))
            })
            .collect();
        let tagged: HashSet<&RelPath> = head.tagged().collect();
        let paired = |entry: &DiskRow| PairedEntry {
            entry: entry.entry,
            path: entry.path.clone(),
            kind: entry.kind,
            head: pairing.get(&entry.entry).cloned(),
        };
        let mut disk = self.disk.clone();
        for entry in &self.scene.disk {
            let mirror = self.disk_tags.get(&entry.entry.0);
            let committed = pairing
                .get(&entry.entry)
                .is_some_and(|row| tagged.contains(row));
            if mirror.is_some() || committed {
                disk.tags
                    .push((paired(entry), mirror.cloned().unwrap_or_default()));
            }
            if entry.kind == EntryKind::Folder && matches!(entry.path.depth(), 1 | 2) {
                disk.folders.push(paired(entry));
            }
        }
        disk
    }

    pub(super) fn workspace(&self) -> Workspace {
        let head = self.head();
        Workspace::with_metadata(self.scene.comparison(), &head, &self.disk_meta(&head))
    }
}

pub(super) fn library(name: &str) -> LibraryConfig {
    LibraryConfig {
        id: library_id(),
        name: DisplayName::parse(name).unwrap(),
        versioning: VersioningRules::default(),
    }
}

fn group(order: u32) -> GroupSettings {
    GroupSettings {
        archived: false,
        order,
    }
}

fn course(code: &str) -> CourseSettings {
    CourseSettings {
        abbr: None,
        archived: false,
        code: Some(CourseCode::parse(code).unwrap()),
        color: None,
        order: 1,
    }
}

/// Tag definitions named after their ids, in the order given.
pub(super) fn definitions(ids: &[&str]) -> TagDefinitions {
    let tags = ids
        .iter()
        .zip(1..)
        .map(|(id, order)| {
            let definition = TagDefinition {
                color: Color::parse("blue").unwrap(),
                name: DisplayName::parse(id).unwrap(),
                order,
            };
            (TagId::parse(id).unwrap(), definition)
        })
        .collect();
    TagDefinitions { tags }
}

fn bytes<T: MetaFile>(value: &T) -> Vec<u8> {
    to_bytes(value).unwrap()
}

/// `content` as the file `file` holds it.
fn content_bytes(file: &TagFile, content: &Content) -> Vec<u8> {
    let tags = content.tags.clone();
    match (file, &content.settings) {
        (TagFile::Root, _) => bytes(&RootMeta { tags }),
        (TagFile::Group(_), settings) => {
            let group = match settings {
                Some(Settings::Group(settings)) => Some(settings.clone()),
                _ => None,
            };
            bytes(&GroupMeta { group, tags })
        }
        (TagFile::Course(_), settings) => {
            let course = match settings {
                Some(Settings::Course(settings)) => Some(settings.clone()),
                _ => None,
            };
            bytes(&CourseMeta { course, tags })
        }
    }
}

/// A metadata change in one line: its key, what happened, and to which entry or folder.
fn describe_meta(change: &MetadataChange) -> String {
    let whose = match change.subject() {
        Subject::Tags(tags) => format!(" entry {}", tags.entry.0),
        Subject::Semester(settings) => folder_of(settings.folder),
        Subject::Course(settings) => folder_of(settings.folder),
        _ => String::new(),
    };
    format!("{} {}{whose}", change.key(), change.op())
}

fn folder_of(folder: Option<EntryId>) -> String {
    match folder {
        Some(entry) => format!(" folder {}", entry.0),
        None => " gone".to_owned(),
    }
}

fn described_meta(workspace: &Workspace) -> Vec<String> {
    workspace.metadata().iter().map(describe_meta).collect()
}

/// Each item with tag changes: its key, and each tag change's entry, operation and tags.
fn item_tags(workspace: &Workspace) -> Vec<String> {
    workspace
        .items()
        .iter()
        .filter(|item| item.tags_changed())
        .map(|item| {
            let changes: Vec<String> = item
                .tag_changes()
                .iter()
                .map(|change| {
                    let ids = |set: &BTreeSet<TagId>| {
                        set.iter().map(TagId::as_str).collect::<Vec<_>>().join(",")
                    };
                    format!(
                        "{} {} [{}]->[{}]",
                        change.entry.0,
                        change.op(),
                        ids(&change.before),
                        ids(&change.after)
                    )
                })
                .collect();
            format!("{}: {}", item.key(), changes.join("; "))
        })
        .collect()
}

// ---- tags (versioning.md §6.4)

#[test]
fn tags_follow_the_pairing() {
    let workspace = World::new(
        Scene::default()
            .kept(1, "2026/MAT/a.md", "a", "2026/MAT/a.md", "a")
            .kept(2, "2026/MAT/b.md", "b", "2026/MAT/c.md", "b")
            .kept(3, "2026/MAT/d.md", "d", "2026/MAT/d.md", "d2")
            .kept(4, "2026/MAT/e.md", "e", "2026/MAT/e.md", "e")
            .gone("2026/MAT/f.md", "f")
            .kept(5, "2026/MAT/g.md", "g", "2026/MAT/g.md", "g")
            .kept(6, "2026/MAT/h.md", "h", "2026/MAT/i.md", "h"),
    )
    .head_tags("2026/MAT/a.md", ["notes"])
    .head_tags("2026/MAT/b.md", ["exam"])
    .head_tags("2026/MAT/d.md", ["notes"])
    .head_tags("2026/MAT/f.md", ["homework"])
    .head_tags("2026/MAT/g.md", ["slides"])
    .head_tags("2026/MAT/h.md", ["notes"])
    .disk_tags(1, ["exam", "notes"])
    .disk_tags(2, ["exam"])
    .disk_tags(4, ["reference"])
    .disk_tags(6, ["exam"])
    .workspace();
    // A moved entry with the same tags is no change; a deleted row reports none; an entry
    // without an item has a row of its own.
    assert_eq!(
        described_meta(&workspace),
        [
            "t:2026/MAT/a.md modify entry 1",
            "t:2026/MAT/e.md add entry 4",
            "t:2026/MAT/g.md delete entry 5",
        ]
    );
    let first = &workspace.metadata()[0];
    assert_eq!(
        first.subject(),
        &Subject::Tags(TagChange {
            entry: EntryId(1),
            path: path("2026/MAT/a.md"),
            kind: EntryKind::File,
            before: tags(["notes"]),
            after: tags(["exam", "notes"]),
        })
    );
    // An entry with an item has its tag change on it.
    let moved_key = item(&workspace, "fv", "2026/MAT/i.md").key().to_owned();
    assert_eq!(
        item_tags(&workspace),
        [
            "fm:2026/MAT/d.md: 3 delete [notes]->[]".to_owned(),
            format!("{moved_key}: 6 modify [notes]->[exam]"),
        ]
    );
    assert_eq!(workspace.totals().metadata, 3);
    assert_eq!(workspace.totals().items, 4);
}

#[test]
fn tags_of_added_entries_are_added() {
    let workspace = World::new(
        Scene::default()
            .added(1, "2026/MAT/new.md", "n")
            .added_folder(2, "2026/MAT/Notes")
            .added(3, "2026/MAT/Notes/x.md", "x")
            .added_folder(4, "2026/MAT/Empty")
            .row(head_file("2026/MAT/kind", "k"), Some(5))
            .entry(disk_folder(5, "2026/MAT/kind")),
    )
    .head_tags("2026/MAT/kind", ["notes"])
    .disk_tags(1, ["notes"])
    .disk_tags(2, ["exam"])
    .disk_tags(4, ["slides"])
    .disk_tags(5, ["exam"])
    .workspace();
    // A folder with content has no item of its own: its tags are a row.
    assert_eq!(described_meta(&workspace), ["t:2026/MAT/Notes add entry 2"]);
    let Subject::Tags(notes) = workspace.metadata()[0].subject() else {
        panic!("a tags row");
    };
    assert_eq!(notes.kind, EntryKind::Folder);
    assert!(notes.before.is_empty());
    // A file that became a folder: the row is deleted (no tag change), the folder is added.
    assert_eq!(
        item_tags(&workspace),
        [
            "da:2026/MAT/Empty: 4 add []->[slides]",
            "da:2026/MAT/kind: 5 add []->[exam]",
            "fa:2026/MAT/new.md: 1 add []->[notes]",
        ]
    );
    let kind = workspace
        .items()
        .iter()
        .find(|item| item.key() == "da:2026/MAT/kind")
        .unwrap();
    assert_eq!(
        describe_item(kind),
        "add folder 2026/MAT/kind + delete file 2026/MAT/kind"
    );
}

#[test]
fn a_row_tagged_as_the_other_kind_is_not_the_entrys() {
    let world = World::new(
        Scene::default()
            .row(head_file("2026/MAT/kind", "k"), Some(1))
            .entry(disk_folder(1, "2026/MAT/kind"))
            .added(2, "2026/MAT/kind/x.md", "x"),
    )
    .head_tags("2026/MAT/kind", ["notes"]);
    let head = world.head();
    let mut disk = world.disk_meta(&head);
    // Even when a loader names that row as the folder's pairing, the file's tags were never the
    // folder's: the folder, without tags, has no tag change.
    disk.tags = vec![(
        PairedEntry {
            entry: EntryId(1),
            path: path("2026/MAT/kind"),
            kind: EntryKind::Folder,
            head: Some(path("2026/MAT/kind")),
        },
        BTreeSet::new(),
    )];
    let workspace = Workspace::with_metadata(world.scene.comparison(), &head, &disk);
    assert!(workspace.metadata().is_empty());
    assert!(item_tags(&workspace).is_empty());
}

// ---- settings

#[test]
fn settings_follow_their_folders() {
    let workspace = World::new(
        Scene::default()
            .kept_folder(1, "2026", "2027")
            .kept_folder(2, "2026/MAT", "2027/MAT232")
            .gone_folder("2026/PHY")
            .added_folder(3, "2027/CSC")
            .kept_folder(4, "2026/ECO", "2027/ECO")
            .kept_folder(5, "2025", "2025")
            .kept_folder(6, "2025/ART", "2025/ART"),
    )
    .head_semester("2026", 1)
    .head_course("2026/MAT", "MAT")
    .head_course("2026/PHY", "PHY")
    .head_course("2026/ECO", "ECO")
    .head_course("2025/ART", "ART")
    .disk_semester("2027", 1)
    .disk_semester("2025", 2)
    .disk_course("2027/MAT232", "MAT232")
    .disk_course("2027/CSC", "CSC")
    .disk_course("2025/ART", "ART")
    .workspace();
    // The renamed semester kept its settings, and so did the unchanged course; a course whose
    // folder is gone keeps `HEAD`'s path.
    assert_eq!(
        described_meta(&workspace),
        [
            "s:2025 add folder 5",
            "cg:2026/PHY delete gone",
            "c:2027/CSC add folder 3",
            "c:2027/ECO delete folder 4",
            "c:2027/MAT232 modify folder 2",
        ]
    );
    let Subject::Course(mat) = workspace.metadata()[4].subject() else {
        panic!("a course row");
    };
    assert_eq!(mat.path, path("2027/MAT232"));
    assert_eq!(mat.folder, Some(EntryId(2)));
    let code = |settings: &Option<CourseSettings>| {
        settings
            .as_ref()
            .and_then(|settings| settings.code.clone())
            .map(|code| code.as_str().to_owned())
    };
    assert_eq!(code(&mat.before).as_deref(), Some("MAT"));
    assert_eq!(code(&mat.after).as_deref(), Some("MAT232"));
}

#[test]
fn a_folder_renamed_onto_a_deleted_ones_place_gives_two_rows() {
    let workspace = World::new(
        Scene::default()
            .kept_folder(1, "2026/A", "2026/B")
            .gone_folder("2026/B"),
    )
    .head_course("2026/A", "A")
    .head_course("2026/B", "B")
    .disk_course("2026/B", "Z")
    .workspace();
    assert_eq!(
        described_meta(&workspace),
        ["c:2026/B modify folder 1", "cg:2026/B delete gone"]
    );
}

#[test]
fn a_course_that_is_no_longer_a_course_is_deleted() {
    // Moved one level up, the course folder became a semester's: its course settings are gone.
    let workspace = World::new(Scene::default().kept_folder(1, "2026/MAT", "MAT"))
        .head_course("2026/MAT", "MAT")
        .workspace();
    assert_eq!(described_meta(&workspace), ["cg:2026/MAT delete gone"]);
}

// ---- tag definitions, library settings, ignore rules

#[test]
fn tag_definitions_are_added_deleted_or_modified() {
    let row = |head: &[&str], disk: TagDefinitions| {
        let mut world = World::new(Scene::default()).head_definitions(definitions(head));
        world.disk.definitions = OnDisk::Read(disk);
        described_meta(&world.workspace())
    };
    assert_eq!(row(&["notes"], definitions(&["notes", "exam"])), ["T: add"]);
    assert_eq!(
        row(&["notes", "exam"], definitions(&["notes"])),
        ["T: delete"]
    );
    assert_eq!(row(&["notes"], definitions(&["exam"])), ["T: modify"]);
    let mut renamed = definitions(&["notes"]);
    if let Some(tag) = renamed.tags.values_mut().next() {
        tag.name = DisplayName::parse("笔记").unwrap();
    }
    assert_eq!(row(&["notes"], renamed), ["T: modify"]);
    let mut added_and_renamed = definitions(&["notes", "exam"]);
    if let Some(tag) = added_and_renamed
        .tags
        .get_mut(&TagId::parse("notes").unwrap())
    {
        tag.order = 9;
    }
    assert_eq!(row(&["notes"], added_and_renamed), ["T: modify"]);
    assert!(row(&["notes"], definitions(&["notes"])).is_empty());
    // `HEAD` without `tags.json` has no tag definitions, like an empty file.
    let world = World::new(Scene::default());
    assert!(described_meta(&world.workspace()).is_empty());
    let mut world = World::new(Scene::default());
    world.disk.definitions = OnDisk::Read(definitions(&["notes"]));
    assert_eq!(described_meta(&world.workspace()), ["T: add"]);
}

#[test]
fn library_settings_change_by_name_and_versioning_rules() {
    let with = |library: LibraryConfig| {
        let mut world = World::new(Scene::default());
        world.disk.library = OnDisk::Read(library);
        world.workspace()
    };
    let renamed = with(library("Notes"));
    assert_eq!(described_meta(&renamed), ["L: modify"]);
    let Subject::Library { before, after } = renamed.metadata()[0].subject() else {
        panic!("a library row");
    };
    assert_eq!(
        (before.name.as_str(), after.name.as_str()),
        ("Folio", "Notes")
    );

    let mut rules = library("Folio");
    rules.versioning.text_max_size = 1;
    assert_eq!(described_meta(&with(rules)), ["L: modify"]);

    // The id is the library's identity, not a setting.
    let mut other = library("Folio");
    other.id = LibraryId::parse("ffffffffffffffffffffffffffffffff").unwrap();
    assert!(described_meta(&with(other)).is_empty());
}

#[test]
fn ignore_rules_are_compared_as_text() {
    let row = |head: Option<&str>, disk: Option<&str>| {
        let mut world = World::new(Scene::default());
        if let Some(text) = head {
            world = world.head_ignore(text);
        }
        world.disk.ignore = OnDisk::Read(disk.map(str::to_owned));
        described_meta(&world.workspace())
    };
    assert_eq!(row(None, Some("*.log\n")), ["I: add"]);
    assert_eq!(row(Some("*.log\n"), None), ["I: delete"]);
    assert_eq!(row(Some("*.log\n"), Some("*.log\n*.tmp\n")), ["I: modify"]);
    assert_eq!(row(Some("*.log\n"), Some("*.log\r\n")), ["I: modify"]);
    assert!(row(Some("*.log\n"), Some("*.log\n")).is_empty());
    // A byte order mark is not text, on either side.
    assert!(row(Some("\u{feff}*.log\n"), Some("*.log\n")).is_empty());
    assert_eq!(row(None, Some("")), ["I: add"]);
}

#[test]
fn rows_come_in_order_and_count_in_the_fingerprint() {
    let base = || {
        let mut world = World::new(
            Scene::default()
                .kept(1, "b.md", "b", "b.md", "b")
                .kept(2, "a.md", "a", "a.md", "a")
                .kept_folder(3, "2026", "2026")
                .kept(4, "2026/MAT/x.md", "x", "2026/MAT/x.md", "x2"),
        )
        .disk_tags(1, ["notes"])
        .disk_tags(2, ["notes"])
        .disk_semester("2026", 1)
        .head_ignore("a\n")
        .head_definitions(definitions(&["notes"]));
        world.disk.library = OnDisk::Read(library("Notes"));
        world.disk.ignore = OnDisk::Read(Some("b\n".to_owned()));
        world.disk.definitions = OnDisk::Read(definitions(&["notes", "exam"]));
        world
    };
    let workspace = base().workspace();
    assert_eq!(
        described_meta(&workspace),
        [
            "t:a.md add entry 2",
            "t:b.md add entry 1",
            "s:2026 add folder 3",
            "T: add",
            "L: modify",
            "I: modify",
        ]
    );
    let fingerprint = workspace.fingerprint();
    // Order-free.
    let mut reversed = base();
    reversed.scene.head.reverse();
    reversed.scene.disk.reverse();
    assert_eq!(reversed.workspace(), workspace);
    // A metadata change edited again keeps its key and the fingerprint.
    assert_eq!(
        base().disk_tags(1, ["exam"]).workspace().fingerprint(),
        fingerprint
    );
    // One more or one fewer changes it.
    let mut fewer = base();
    fewer.disk.ignore = OnDisk::Read(Some("a\n".to_owned()));
    assert_ne!(fewer.workspace().fingerprint(), fingerprint);
    let more = base().disk_tags(4, ["notes"]).workspace();
    assert_ne!(more.fingerprint(), fingerprint);
    // A tag change shown on an item counts too, though it is not a row.
    assert_eq!(more.metadata(), workspace.metadata());
    assert!(more.items()[0].tags_changed());
    assert!(!workspace.items()[0].tags_changed());
    // Pages.
    let window = workspace.metadata_page(page(2, 3)).unwrap();
    assert_eq!(window.total, 6);
    assert_eq!(
        window
            .rows
            .iter()
            .map(MetadataChange::key)
            .collect::<Vec<_>>(),
        ["s:2026", "T:", "L:"]
    );
    assert!(matches!(
        workspace.metadata_page(page(0, MAX_PAGE_SIZE + 1)),
        Err(QueryError::InvalidArgument(_))
    ));
}

// ---- files the disk cannot read (versioning.md §6.4)

#[test]
fn what_an_unreadable_disk_file_holds_keeps_heads() {
    let mut world = World::new(
        Scene::default()
            .kept_folder(1, "2026", "2026")
            .kept_folder(2, "2026/MAT", "2026/MAT")
            .kept(3, "2026/MAT/a.md", "a", "2026/MAT/a.md", "a")
            .kept_folder(4, "2026/PHY", "2026/PHY")
            .kept(5, "2026/PHY/b.md", "b", "2026/PHY/b.md", "b")
            .kept(6, "2026/MAT/c.md", "c", "2026/PHY/c.md", "c"),
    )
    .head_tags("2026/MAT/a.md", ["notes"])
    .head_tags("2026/MAT/c.md", ["notes"])
    .head_tags("2026/PHY/b.md", ["exam"])
    .head_course("2026/MAT", "M")
    .head_course("2026/PHY", "P")
    .head_definitions(definitions(&["notes"]))
    .head_ignore("a\n")
    // What the mirror kept from before the file broke, and what it reads from the others.
    .disk_tags(3, ["exam"])
    .disk_course("2026/MAT", "X")
    .disk_course("2026/PHY", "P2");
    world.disk.broken = vec![TagFile::Course(course_at("2026/mat"))];
    world.disk.definitions = OnDisk::Unreadable;
    world.disk.library = OnDisk::Unreadable;
    world.disk.ignore = OnDisk::Unreadable;
    let workspace = world.workspace();
    // Nothing the broken course file holds, on either side of a move, and no unreadable file.
    assert_eq!(
        described_meta(&workspace),
        [
            "t:2026/PHY/b.md delete entry 5",
            "c:2026/PHY modify folder 4",
        ]
    );
    assert!(item_tags(&workspace).is_empty());
    // `HEAD`'s rules stay while `library.json` cannot be read.
    let head = world.head();
    let disk = world.disk_meta(&head);
    assert_eq!(disk.rules(&head), &head.library().versioning);
}

// ---- `HEAD`'s metadata

#[test]
fn heads_metadata_resolves_like_the_mirror() {
    let scene = Scene::default()
        .row(head_file("top.md", "t"), None)
        .row(head_folder("2026/MAT"), None)
        .row(head_file("2026/MAT/Notes.md", "n"), None)
        .row(head_file("2026/MAT/dup.md", "1"), None)
        .row(head_file("2026/MAT/DUP.md", "2"), None)
        .row(head_file("2026/MAT/sub/deep.md", "d"), None);
    let rows = head_rows(&scene);
    let mut mat = CourseMeta {
        course: Some(course("MAT232")),
        tags: Default::default(),
    };
    for (key, id) in [
        ("notes.md", "notes"),
        ("Dup.md", "exam"),
        ("sub/deep.md", "slides"),
        ("missing.md", "notes"),
    ] {
        mat.tags.set(path(key), tags([id]));
    }
    let mut lower = mat.clone();
    lower.course = Some(course("lower"));
    let mut group = GroupMeta::default();
    group.tags.set(path("MAT"), tags(["notes"]));
    let mut root = RootMeta::default();
    root.tags.set(path("top.md"), tags(["exam"]));
    let gone = CourseMeta {
        course: Some(course("GONE")),
        tags: Default::default(),
    };
    let files = vec![
        (path(".folio/library.json"), bytes(&library("Folio"))),
        (path(".folio/meta/2026/MAT.json"), bytes(&mat)),
        (path(".folio/meta/2026/mat.json"), bytes(&lower)),
        (path(".folio/meta/2026/_group.json"), bytes(&group)),
        (path(".folio/meta/2026/GONE.json"), bytes(&gone)),
        (path(".folio/meta/_root.json"), bytes(&root)),
        (
            path(".folio/meta/2026/readme.txt"),
            b"not metadata".to_vec(),
        ),
        (path(".folio/notes.txt"), b"{".to_vec()),
        (path("2026/MAT/Notes.md"), b"{".to_vec()),
    ];
    let head = HeadMeta::parse(&files, &rows).unwrap();
    let tagged = |at: &str| {
        head.tags_of(&path(at))
            .map(|ids| ids.iter().map(TagId::as_str).collect::<Vec<_>>().join(","))
    };
    // Exactly, or by the one path NTFS takes for the key, spelled as `HEAD` spells it.
    assert_eq!(tagged("2026/MAT/Notes.md").as_deref(), Some("notes"));
    assert_eq!(tagged("2026/MAT/sub/deep.md").as_deref(), Some("slides"));
    assert_eq!(tagged("top.md").as_deref(), Some("exam"));
    // Not a key two rows share, nor the course folder itself, which carries no tags.
    assert_eq!(tagged("2026/MAT/dup.md"), None);
    assert_eq!(tagged("2026/MAT/DUP.md"), None);
    assert_eq!(tagged("2026/MAT"), None);
    assert_eq!(head.tagged().count(), 3);
    // The course file spelled like its folder holds the course; the other and the one whose
    // folder is gone hold nothing.
    let codes: Vec<(&str, &str)> = head
        .courses()
        .iter()
        .map(|(at, settings)| {
            let code = settings.code.as_ref().map_or("", CourseCode::as_str);
            (at.as_str(), code)
        })
        .collect();
    assert_eq!(codes, [("2026/MAT", "MAT232")]);
    assert!(head.semesters().is_empty());
    assert_eq!(head.definitions(), &TagDefinitions::default());
    assert_eq!(head.ignore(), None);
    assert_eq!(head.library(), &library("Folio"));
}

#[test]
fn a_course_file_spelled_unlike_its_folder_holds_the_course() {
    let scene = Scene::default()
        .row(head_folder("2026/MAT"), None)
        .row(head_file("2026/MAT/a.md", "a"), None);
    let mut mat = CourseMeta {
        course: Some(course("MAT232")),
        tags: Default::default(),
    };
    mat.tags.set(path("a.md"), tags(["notes"]));
    let files = vec![
        (path(".folio/library.json"), bytes(&library("Folio"))),
        (path(".folio/meta/2026/mat.json"), bytes(&mat)),
        (path(".folio/ignore"), b"\xef\xbb\xbf*.log\n\xff\n".to_vec()),
    ];
    let head = HeadMeta::parse(&files, &head_rows(&scene)).unwrap();
    assert_eq!(head.tags_of(&path("2026/MAT/a.md")), Some(&tags(["notes"])));
    assert!(head.courses().contains_key(&path("2026/MAT")));
    assert_eq!(head.ignore(), Some("*.log\n\u{fffd}\n"));
}

#[test]
fn heads_metadata_written_by_a_newer_folio_or_invalid_cannot_be_read() {
    let newer = |value: &[u8]| {
        String::from_utf8(value.to_vec())
            .unwrap()
            .replacen("\"format_version\": 2", "\"format_version\": 3", 1)
            .into_bytes()
    };
    let settings = bytes(&library("Folio"));
    let course = bytes(&CourseMeta::default());
    let parse = |files: Vec<(&str, Vec<u8>)>| {
        let files: Vec<(RelPath, Vec<u8>)> = files
            .into_iter()
            .map(|(at, bytes)| (path(at), bytes))
            .collect();
        HeadMeta::parse(&files, &[])
    };

    assert_eq!(
        parse(vec![(".folio/library.json", newer(&settings))]),
        Err(HeadMetaError::Newer {
            path: path(".folio/library.json"),
            found: 3
        })
    );
    // A newer file wins over an invalid one: a newer Folio may read it.
    assert_eq!(
        parse(vec![
            (".folio/library.json", settings.clone()),
            (".folio/meta/2026/A.json", b"{".to_vec()),
            (".folio/meta/2026/B.json", newer(&course)),
        ]),
        Err(HeadMetaError::Newer {
            path: path(".folio/meta/2026/B.json"),
            found: 3
        })
    );
    let invalid = parse(vec![
        (".folio/library.json", settings.clone()),
        (
            ".folio/tags.json",
            b"{\"format_version\": 2, \"tags\": 1}".to_vec(),
        ),
        (".folio/meta/2026/A.json", b"{".to_vec()),
    ]);
    match invalid {
        Err(HeadMetaError::Invalid { path: at, reason }) => {
            assert_eq!(at, path(".folio/meta/2026/A.json"));
            assert!(reason.starts_with("course settings: "), "{reason}");
        }
        other => panic!("not invalid: {other:?}"),
    }
    assert_eq!(parse(vec![]), Err(HeadMetaError::NoLibrary));
    assert_eq!(
        parse(vec![(
            ".folio/tags.json",
            bytes(&TagDefinitions::default())
        )]),
        Err(HeadMetaError::NoLibrary)
    );
    // An older format version reads.
    let older = String::from_utf8(settings)
        .unwrap()
        .replacen("\"format_version\": 2", "\"format_version\": 1", 1)
        .into_bytes();
    assert!(parse(vec![(".folio/library.json", older)]).is_ok());
}

// ---- bound rule 4: a change of the versioning rules (versioning.md §5.2)

/// `HEAD`'s rules: text files up to 100 bytes.
pub(super) fn rules_before() -> VersioningRules {
    VersioningRules {
        text_max_size: 100,
        ..VersioningRules::default()
    }
}

/// The disk's rules: text files up to 1,000 bytes, and `.foo` files are text.
pub(super) fn rules_after() -> VersioningRules {
    let mut rules = VersioningRules {
        text_max_size: 1000,
        ..VersioningRules::default()
    };
    rules
        .text_extensions
        .insert(Extension::parse("foo").unwrap());
    rules
}

/// A file `HEAD` committed under `rules`.
fn head_file_under(rules: &VersioningRules, at: &str, content: &str) -> HeadRow {
    let mut row = head_file(at, content);
    if let Some(file) = &mut row.file {
        file.stored = rules.is_stored(rules.class_of(&row.path), file.size);
    }
    row
}

pub(super) fn rules_scene() -> Scene {
    let (x, y) = ("x".repeat(500), "y".repeat(500));
    let rules = rules_before();
    let kept = |scene: Scene, id: i64, from: &str, before: &str, to: &str, after: &str| {
        scene
            .row(head_file_under(&rules, from, before), Some(id))
            .entry(disk_file(id, to, after))
    };
    let scene = Scene::default();
    let scene = kept(scene, 1, "big.txt", &x, "big.txt", &y);
    let scene = scene.row(head_file_under(&rules, "gone.txt", &x), None);
    let scene = kept(scene, 2, "moved.txt", &x, "moved 2.txt", &x);
    let scene = kept(scene, 3, "moved3.txt", &x, "moved 4.txt", &y);
    let scene = kept(scene, 4, "small.txt", "s", "small.txt", "t");
    let scene = kept(scene, 5, "notes.foo", "f", "notes.foo", "g");
    let scene = scene
        .gone_folder("D")
        .row(head_file_under(&rules, "D/in.txt", &x), None);
    let scene = kept(
        scene,
        6,
        "huge.txt",
        &"x".repeat(2000),
        "huge.txt",
        &"y".repeat(2000),
    );
    let scene = scene.kept_folder(7, "F", "G");
    kept(scene, 8, "F/e.txt", &x, "G/e.txt", &y)
}

fn required_keys(workspace: &Workspace) -> Vec<String> {
    workspace
        .items()
        .iter()
        .filter(|item| item.is_required())
        .map(|item| describe(item.change()))
        .collect()
}

#[test]
fn a_rules_change_binds_the_held_back_files_it_stores() {
    let workspace = World::new(rules_scene())
        .rules(rules_before(), rules_after())
        .workspace();
    // Modified, edited, deleted and covered files that the new rules store and `HEAD` did not:
    // across `text_max_size` and a new text extension. Not a move without an edit (its content
    // is on the disk), a file `HEAD` stored, or one the new rules do not store either.
    assert_eq!(
        required_keys(&workspace),
        [
            "delete folder D files 1",
            "modify file G/e.txt",
            "modify file big.txt",
            "delete file gone.txt",
            "move file moved 4.txt from moved3.txt edited",
            "modify file notes.foo",
        ]
    );
    assert_eq!(described_meta(&workspace), ["L: modify"]);

    // Every selection includes them, an `allExcept` that lists one too.
    let fingerprint = workspace.fingerprint().to_string();
    let big = item(&workspace, "fm:", "big.txt").key().to_owned();
    for selection in [
        Selection::AllExcept(vec![big.clone()]),
        Selection::Only(Vec::new()),
    ] {
        let chosen = workspace.resolve(&selection, &fingerprint).unwrap();
        let chosen: Vec<String> = workspace
            .chosen_items(&chosen)
            .filter(|item| item.is_required())
            .map(|item| item.key().to_owned())
            .collect();
        assert_eq!(chosen.len(), 6, "{selection:?}");
        assert!(chosen.contains(&big));
    }

    // Rules that change but store none of them: the same rows, no required item, another
    // fingerprint.
    let mut other = rules_before();
    other.text_max_size = 200;
    let unbound = World::new(rules_scene())
        .rules(rules_before(), other)
        .workspace();
    assert!(required_keys(&unbound).is_empty());
    let keys = |workspace: &Workspace| -> Vec<String> {
        workspace
            .items()
            .iter()
            .map(|item| item.key().to_owned())
            .collect()
    };
    assert_eq!(keys(&unbound), keys(&workspace));
    assert_eq!(described_meta(&unbound), ["L: modify"]);
    assert_ne!(unbound.fingerprint(), workspace.fingerprint());
}

#[test]
fn rules_that_store_less_or_stay_bind_nothing() {
    // A lower limit turns `stored` off: earlier blobs stay, nothing is needed.
    let mut lower = rules_before();
    lower.text_max_size = 0;
    let workspace = World::new(rules_scene())
        .rules(rules_before(), lower)
        .workspace();
    assert!(required_keys(&workspace).is_empty());
    // Unchanged rules bind nothing, even where `HEAD`'s flags disagree with them.
    let workspace = World::new(rules_scene())
        .rules(rules_after(), rules_after())
        .workspace();
    assert!(required_keys(&workspace).is_empty());
    assert!(workspace.metadata().is_empty());
    // Items alone (`HEAD`'s metadata unread) bind nothing either.
    let scene = rules_scene();
    let workspace = Workspace::new(scene.comparison(), &rules_after());
    assert!(required_keys(&workspace).is_empty());
}

#[test]
fn a_required_item_takes_its_bound_changes_along() {
    // `gone.txt` is replaced by a moved file: rule 1 binds the move to the deletion, which the
    // rules bind; the whole row is required.
    let rules = rules_before();
    let x = "x".repeat(500);
    let scene = Scene::default()
        .row(head_file_under(&rules, "gone.txt", &x), None)
        .row(head_file_under(&rules, "a.md", "a"), Some(1))
        .entry(disk_file(1, "gone.txt", "a"));
    let workspace = World::new(scene)
        .rules(rules_before(), rules_after())
        .workspace();
    assert_eq!(required_keys(&workspace), ["move file gone.txt from a.md"]);
    assert_eq!(
        describe_item(&workspace.items()[0]),
        "move file gone.txt from a.md + delete file gone.txt"
    );
}
