//! Test support: a library on a [`MemFs`] with its catalog, `HEAD`s written through the store from
//! what the catalog and `.folio/` hold ([`Fixture::disk_tree`], [`write_head`]), and the workspace's
//! items in one line each ([`described`]).

use std::cell::Cell;
use std::collections::{BTreeMap, BTreeSet, HashMap};
use std::fs;
use std::io::Read;
use std::path::Path;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;

use tempfile::TempDir;

use super::head::{Bounds, Cancel, HeadState, sync, sync_within};
use super::trees::encode_trees;
use super::{Change, Item, Readiness, Snapshot, Workspace};
use crate::catalog::{Catalog, Entry, entries_in, entry};
use crate::fs::FileSystem;
use crate::library::{HashReport, Library};
use crate::meta::{
    Assignments, CourseSettings, DisplayName, EntryKind, Layout, LibraryConfig, LibraryId, TagFile,
    TagId, VersioningRules, tag_location,
};
use crate::store::{
    BlobClass, ChangeOp, Commit, CommitKind, Device, DeviceId, DeviceName, LocalStore, Message,
    ObjectId, ObjectKind, Side, Size, Summary, Timestamp,
};
use crate::test_support::{MemFs, course_at, library_id, open_catalog, path, presets};

/// A library on a [`MemFs`] below a temporary folder, whose `.folio/` and catalog are real files
/// there, with the test library's id and the preset tags.
pub(crate) struct Fixture {
    _dir: TempDir,
    pub(crate) fs: Arc<MemFs>,
    pub(crate) library: Library,
    pub(crate) catalog: Catalog,
}

impl Fixture {
    pub(crate) fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("资料库");
        let fs = MemFs::new(&root);
        let library = Library::new(&root, fs.clone());
        let config = LibraryConfig {
            id: library_id(),
            name: DisplayName::parse("资料").unwrap(),
            versioning: VersioningRules::default(),
        };
        library.layout().write_library(&config).unwrap();
        library.layout().write_tags(&presets("课件")).unwrap();
        let catalog = open_catalog(dir.path());
        Self {
            _dir: dir,
            fs,
            library,
            catalog,
        }
    }

    pub(crate) fn layout(&self) -> &Layout {
        self.library.layout()
    }

    pub(crate) fn store(&self) -> LocalStore {
        LocalStore::new(self.layout())
    }

    pub(crate) fn id(&self) -> LibraryId {
        library_id()
    }

    pub(crate) fn scan(&self) {
        self.library
            .scan(&self.catalog, None, self.fs.now_ns())
            .unwrap();
    }

    /// Hashes everything, however recently it changed.
    pub(crate) fn hash_all(&self) -> HashReport {
        let later = self.fs.now_ns() + 10_000_000_000;
        self.library
            .hash_pending(
                &self.catalog,
                later,
                &AtomicBool::new(false),
                &mut |_, _| {},
            )
            .unwrap()
    }

    pub(crate) fn entry(&self, at: &str) -> Entry {
        self.catalog
            .read(|tx| entry(tx, &path(at)))
            .unwrap()
            .unwrap_or_else(|| panic!("no entry at {at}"))
    }

    /// A head sync, which must not fail.
    pub(crate) fn sync(&self) -> HeadState {
        sync(
            &self.catalog,
            self.layout(),
            &self.id(),
            false,
            &AtomicBool::new(false),
        )
        .unwrap()
    }

    /// A head sync that derives everything again, as after a catalog rebuild.
    pub(crate) fn sync_forced(&self) -> HeadState {
        sync(
            &self.catalog,
            self.layout(),
            &self.id(),
            true,
            &AtomicBool::new(false),
        )
        .unwrap()
    }

    /// A head sync within `bounds`.
    pub(crate) fn sync_within(&self, bounds: Bounds) -> HeadState {
        sync_within(
            &self.catalog,
            self.layout(),
            &self.id(),
            false,
            &AtomicBool::new(false),
            bounds,
        )
        .unwrap()
    }

    pub(crate) fn load(&self, head: &HeadState) -> Snapshot {
        Workspace::load(&self.catalog, self.layout(), head, &AtomicBool::new(false)).unwrap()
    }

    /// Scans, hashes everything, writes a commit of it on top of `parent` as `HEAD`, and brings it
    /// into the catalog: a library right after a commit of everything.
    pub(crate) fn commit_all(&self, parent: Option<ObjectId>) -> (ObjectId, HeadState) {
        self.scan();
        self.hash_all();
        let head = write_head(&self.store(), &self.disk_tree(), parent, &|_| false).commit;
        (head, self.sync())
    }

    /// The tree a commit of everything would make now: every entry of the catalog (every file
    /// hashed), stored as the versioning rules say, and every file of `.folio/` but `local/`, as
    /// the disk has them.
    pub(crate) fn disk_tree(&self) -> HeadTree {
        let rules = self
            .layout()
            .read_library()
            .unwrap()
            .expect("a library")
            .versioning;
        let mut tree = HeadTree::default();
        for entry in self.catalog.read(|tx| entries_in(tx, None)).unwrap() {
            let record = entry.record;
            let side = match record.kind {
                EntryKind::Folder => None,
                EntryKind::File => {
                    let hash = record.hash.as_ref().expect("every file hashed");
                    let side = Side {
                        hash: ObjectId::from(hash),
                        size: Size::new(record.size).unwrap(),
                        stored: rules.is_stored(record.class, record.size),
                    };
                    if side.stored {
                        let mut bytes = Vec::new();
                        self.fs
                            .open(&record.path.to_native(self.library.root()))
                            .unwrap()
                            .read_to_end(&mut bytes)
                            .unwrap();
                        tree.blobs.insert(side.hash, bytes);
                    }
                    Some(side)
                }
            };
            tree.rows.insert(record.path.to_string(), side);
        }
        let folio = self.layout().folio_dir();
        tree.rows.insert(".folio".to_owned(), None);
        let mut folders = vec![(folio, ".folio".to_owned())];
        while let Some((native, at)) = folders.pop() {
            for item in fs::read_dir(&native).unwrap() {
                let item = item.unwrap();
                let name = item.file_name().into_string().unwrap();
                let below = format!("{at}/{name}");
                if below == ".folio/local" {
                    continue;
                }
                if item.file_type().unwrap().is_dir() {
                    tree.rows.insert(below.clone(), None);
                    folders.push((item.path(), below));
                } else {
                    tree.put(&below, fs::read(item.path()).unwrap());
                }
            }
        }
        tree
    }

    /// Tags an entry the way library operations do: in the file and under the key that
    /// `tag_location` names.
    pub(crate) fn set_tags(&self, at: &str, kind: EntryKind, ids: BTreeSet<TagId>) {
        let layout = self.layout();
        let (file, key) = tag_location(&path(at), kind).unwrap();
        let assign = |tags: &mut Assignments| tags.set(key.clone(), ids.clone());
        match &file {
            TagFile::Root => {
                let mut meta = layout.read_root_meta().unwrap().unwrap_or_default();
                assign(&mut meta.tags);
                layout.write_root_meta(&meta).unwrap();
            }
            TagFile::Group(semester) => {
                let mut meta = layout
                    .read_group_meta(semester)
                    .unwrap()
                    .unwrap_or_default();
                assign(&mut meta.tags);
                layout.write_group_meta(semester, &meta).unwrap();
            }
            TagFile::Course(course) => {
                let mut meta = layout.read_course_meta(course).unwrap().unwrap_or_default();
                assign(&mut meta.tags);
                layout.write_course_meta(course, &meta).unwrap();
            }
        }
    }

    pub(crate) fn set_course(&self, at: &str, settings: CourseSettings) {
        let course = course_at(at);
        let layout = self.layout();
        let mut meta = layout
            .read_course_meta(&course)
            .unwrap()
            .unwrap_or_default();
        meta.course = Some(settings);
        layout.write_course_meta(&course, &meta).unwrap();
    }
}

/// A commit's flattened tree, and the bytes of its stored files.
#[derive(Debug, Clone, Default)]
pub(crate) struct HeadTree {
    /// Each path with a file's side, or `None` for a folder.
    pub(crate) rows: BTreeMap<String, Option<Side>>,
    pub(crate) blobs: HashMap<ObjectId, Vec<u8>>,
}

impl HeadTree {
    /// Puts a stored file of `bytes` at `at`, with the folders above it.
    pub(crate) fn put(&mut self, at: &str, bytes: Vec<u8>) {
        for (end, _) in at.match_indices('/') {
            self.rows.entry(at[..end].to_owned()).or_insert(None);
        }
        let hash = ObjectId::of(ObjectKind::Blob, &bytes);
        let side = Side {
            hash,
            size: Size::new(bytes.len() as u64).unwrap(),
            stored: true,
        };
        self.rows.insert(at.to_owned(), Some(side));
        self.blobs.insert(hash, bytes);
    }
}

/// What [`write_head`] wrote.
#[derive(Debug, Clone)]
pub(crate) struct Written {
    pub(crate) commit: ObjectId,
    /// Each folder's tree id, by its path; the root's is empty.
    pub(crate) trees: BTreeMap<String, ObjectId>,
}

/// Writes a commit of `tree` on top of `parent` into packs of `store`, leaving out the objects
/// `leave_out` names (blobs, trees, the commit), and makes it `HEAD`.
pub(crate) fn write_head(
    store: &LocalStore,
    tree: &HeadTree,
    parent: Option<ObjectId>,
    leave_out: &dyn Fn(ObjectId) -> bool,
) -> Written {
    let mut encoded = Vec::new();
    let mut trees = BTreeMap::new();
    let root = encode_trees(
        tree.rows.iter().map(|(at, side)| (at.as_str(), *side)),
        |at, object| {
            trees.insert(at.to_owned(), object.id());
            encoded.push(object);
            Ok(())
        },
    )
    .unwrap();
    let commit = Commit {
        tree: root,
        device: Device {
            id: DeviceId::parse("8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c").unwrap(),
            name: DeviceName::parse("G16").unwrap(),
        },
        time: Timestamp::parse("2026-10-06T12:00:00Z").unwrap(),
        rebased_from: None,
        kind: CommitKind::Commit {
            parent,
            message: Message {
                summary: Summary::parse("Test commit").unwrap(),
                body: None,
                changes: None,
            },
        },
    }
    .encode()
    .unwrap();
    let id = commit.id();
    let mut set = store.pack_set();
    let mut blobs: Vec<(&ObjectId, &Vec<u8>)> = tree.blobs.iter().collect();
    blobs.sort_unstable();
    for (hash, bytes) in blobs {
        if !leave_out(*hash) {
            set.add_blob(bytes, BlobClass::Text).unwrap();
        }
    }
    for object in encoded.iter().chain([&commit]) {
        if !leave_out(object.id()) {
            set.add_object(object, true).unwrap();
        }
    }
    for staged in set.finish().unwrap() {
        store.publish(staged).unwrap();
    }
    store.write_head(id).unwrap();
    Written { commit: id, trees }
}

/// Cancels from its `at`th question on, and counts the questions.
pub(crate) struct CancelAt {
    pub(crate) asked: Cell<usize>,
    at: usize,
}

impl CancelAt {
    pub(crate) fn new(at: usize) -> Self {
        Self {
            asked: Cell::new(0),
            at,
        }
    }
}

impl Cancel for CancelAt {
    fn cancelled(&self) -> bool {
        let asked = self.asked.get() + 1;
        self.asked.set(asked);
        asked >= self.at
    }
}

/// Writes `bytes` as `HEAD`, whatever they hold.
pub(crate) fn write_head_bytes(layout: &Layout, bytes: &[u8]) {
    let head = layout.head_file();
    fs::create_dir_all(head.parent().unwrap()).unwrap();
    fs::write(head, bytes).unwrap();
}

/// Removes every pack of the store.
pub(crate) fn remove_packs(layout: &Layout) {
    let packs = layout.packs_dir();
    if Path::new(&packs).exists() {
        fs::remove_dir_all(packs).unwrap();
    }
}

/// An item in one line: its main change, then ` + ` and each part.
pub(crate) fn describe_item(item: &Item) -> String {
    item.changes().map(describe).collect::<Vec<_>>().join(" + ")
}

/// A change in one line: what, where from, whether a moved file was edited, the files a folder
/// change covers, and a readiness other than ready.
pub(crate) fn describe(change: &Change) -> String {
    let kind = match change.kind() {
        EntryKind::File => "file",
        EntryKind::Folder => "folder",
    };
    let mut words = vec![format!("{} {kind} {}", change.op(), change.path())];
    if let Some(from) = change.from_path() {
        words.push(format!("from {from}"));
    }
    if change.op() == ChangeOp::Move && change.content_changed() {
        words.push("edited".into());
    }
    if change.files() > 0 {
        words.push(format!("files {}", change.files()));
    }
    match change.readiness() {
        Readiness::Ready => {}
        Readiness::Hashing => words.push("hashing".into()),
        Readiness::NotLocal => words.push("notLocal".into()),
        Readiness::Unreadable => words.push("unreadable".into()),
    }
    words.join(" ")
}

pub(crate) fn described(workspace: &Workspace) -> Vec<String> {
    workspace.items().iter().map(describe_item).collect()
}

/// The paths of `HEAD`'s rows, as `head_files` holds them, with the paths of the entries they are
/// paired with.
pub(crate) fn pairing(catalog: &Catalog) -> Vec<(String, Option<String>)> {
    catalog
        .read(|tx| {
            let rows = tx
                .prepare(
                    "SELECT h.path, e.path FROM head_files AS h
                     LEFT JOIN entries AS e ON e.id = h.entry_id ORDER BY h.path",
                )?
                .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                .collect::<Result<_, _>>()?;
            Ok(rows)
        })
        .unwrap()
}
