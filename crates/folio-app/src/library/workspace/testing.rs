//! Test support for the workspace in the shell: a library in a temporary folder, opened through
//! [`LibraryState`] with its real session, catalog and tracker, and `HEAD`s written through
//! folio-core's public store as a commit of the disk would write them (folio-core's own test
//! helpers are not visible here; feat/core-commit-history writes commits for real).

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant, SystemTime};

use folio_core::library::state::{self, Settings};
use folio_core::meta::{DisplayName, Layout};
use folio_core::paths::RelPath;
use folio_core::store::{
    BlobClass, Commit, CommitKind, Device, DeviceId, DeviceName, LocalStore, Message, ObjectId,
    ObjectKind, Side, Size, Summary, Timestamp,
};
use folio_core::workspace::encode_trees;
use tempfile::TempDir;

use super::super::worker::Session;
use super::super::{Event, LibraryState, lock};
use super::Current;
use crate::ipc::events::WorkspaceChanged;
use crate::ipc::jobs::{JobKind, JobStatus};
use crate::ipc::types::EntryRef;

/// A commit's flattened tree, and the bytes of its stored files.
#[derive(Debug, Clone, Default)]
pub(crate) struct HeadTree {
    /// Each path with a file's side, or `None` for a folder.
    pub(crate) rows: BTreeMap<String, Option<Side>>,
    pub(crate) blobs: HashMap<ObjectId, Vec<u8>>,
}

impl HeadTree {
    /// What a commit of everything below `root` would hold now: every file and folder, stored as
    /// `.folio/library.json`'s rules say, and every file of `.folio/` but `local/`, stored.
    pub(crate) fn of_disk(root: &Path) -> Self {
        let rules = Layout::new(root)
            .read_library()
            .unwrap()
            .expect("a library")
            .versioning;
        let mut tree = Self::default();
        let mut folders = vec![(root.to_path_buf(), String::new())];
        while let Some((native, at)) = folders.pop() {
            for item in fs::read_dir(&native).unwrap() {
                let item = item.unwrap();
                let name = item.file_name().into_string().unwrap();
                let path = if at.is_empty() {
                    name
                } else {
                    format!("{at}/{name}")
                };
                if path == ".folio/local" {
                    continue;
                }
                if item.file_type().unwrap().is_dir() {
                    tree.rows.insert(path.clone(), None);
                    folders.push((item.path(), path));
                } else {
                    let bytes = fs::read(item.path()).unwrap();
                    let stored = path.starts_with(".folio/") || {
                        let class = rules.class_of(&RelPath::parse(&path).unwrap());
                        rules.is_stored(class, bytes.len() as u64)
                    };
                    tree.put(&path, bytes, stored);
                }
            }
        }
        tree
    }

    fn put(&mut self, at: &str, bytes: Vec<u8>, stored: bool) {
        let hash = ObjectId::of(ObjectKind::Blob, &bytes);
        let side = Side {
            hash,
            size: Size::new(bytes.len() as u64).unwrap(),
            stored,
        };
        self.rows.insert(at.to_owned(), Some(side));
        if stored {
            self.blobs.insert(hash, bytes);
        }
    }
}

/// Writes a commit of `tree` on top of `parent` into packs of the store of `layout`, and makes it
/// `HEAD`.
pub(crate) fn write_head(layout: &Layout, tree: &HeadTree, parent: Option<ObjectId>) -> ObjectId {
    let store = LocalStore::new(layout);
    let mut encoded = Vec::new();
    let root = encode_trees(
        tree.rows.iter().map(|(at, side)| (at.as_str(), *side)),
        |_, object| {
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
    for (_, bytes) in blobs {
        set.add_blob(bytes, BlobClass::Text).unwrap();
    }
    for object in encoded.iter().chain([&commit]) {
        set.add_object(object, true).unwrap();
    }
    for staged in set.finish().unwrap() {
        store.publish(staged).unwrap();
    }
    store.write_head(id).unwrap();
    id
}

/// What the shell sent, with when.
pub(crate) type Log = Arc<Mutex<Vec<(Instant, Event)>>>;

/// A library in a temporary folder and the state that opens it.
pub(crate) struct Fixture {
    pub(crate) state: LibraryState,
    pub(crate) events: Log,
    pub(crate) root: PathBuf,
    data: PathBuf,
    _dir: TempDir,
}

impl Fixture {
    /// No library on this computer: the state is initialized and open to commands.
    pub(crate) fn without_library() -> Self {
        let fixture = Self::base();
        fixture.state.initialize();
        fixture
    }

    /// A new library with the preset tags, not open yet.
    pub(crate) fn new() -> Self {
        let fixture = Self::base();
        state::create(
            &fixture.root,
            DisplayName::parse("Workspace test library").unwrap(),
            ["Notes", "Slides", "Homework", "Exam", "Reference"]
                .map(|name| DisplayName::parse(name).unwrap()),
        )
        .unwrap();
        fixture
    }

    fn base() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("library");
        let data = dir.path().join("data");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&data).unwrap();
        let events: Log = Arc::default();
        let capture = events.clone();
        let state = LibraryState::new(
            Ok(data.clone()),
            Arc::new(move |event| capture.lock().unwrap().push((Instant::now(), event))),
        );
        Self {
            state,
            events,
            root,
            data,
            _dir: dir,
        }
    }

    pub(crate) fn layout(&self) -> Layout {
        Layout::new(&self.root)
    }

    /// Writes `bytes` at `path` with a modification time an hour ago, so the hash job reads it at
    /// once rather than waiting for it to settle.
    pub(crate) fn write(&self, path: &str, bytes: &[u8]) {
        let native = RelPath::parse(path).unwrap().to_native(&self.root);
        fs::create_dir_all(native.parent().unwrap()).unwrap();
        fs::write(&native, bytes).unwrap();
        fs::File::options()
            .write(true)
            .open(&native)
            .unwrap()
            .set_modified(SystemTime::now() - Duration::from_secs(3600))
            .unwrap();
    }

    pub(crate) fn native(&self, path: &str) -> PathBuf {
        RelPath::parse(path).unwrap().to_native(&self.root)
    }

    /// Commits the disk as it is now on top of `parent` and makes it `HEAD`.
    pub(crate) fn commit(&self, parent: Option<ObjectId>) -> ObjectId {
        write_head(&self.layout(), &HeadTree::of_disk(&self.root), parent)
    }

    /// Opens the library as this computer's, waits for its scan and hash jobs, then reads the
    /// workspace once, which pairs `HEAD`'s rows with the new catalog's entries by path (a move
    /// before that would show as a deletion and an addition, versioning.md §6.1).
    pub(crate) fn open(&self) {
        Settings {
            library_root: Some(self.root.clone()),
            ..Settings::default()
        }
        .save(&self.data)
        .unwrap();
        self.state.initialize();
        self.wait_for_jobs();
        self.workspace();
    }

    /// Waits until a hash job is done and no job is queued or running; no job may fail.
    pub(crate) fn wait_for_jobs(&self) {
        until("the library's jobs", || {
            let jobs = self.state.list_jobs().unwrap();
            assert!(
                jobs.iter()
                    .all(|job| !matches!(job.status, JobStatus::Failed { .. })),
                "a job failed: {jobs:?}"
            );
            (jobs.iter().any(|job| {
                job.kind == JobKind::Hash && matches!(job.status, JobStatus::Done { .. })
            }) && jobs
                .iter()
                .all(|job| !matches!(job.status, JobStatus::Queued | JobStatus::Running { .. })))
            .then_some(())
        });
    }

    /// The open library's session.
    pub(in crate::library) fn session(&self) -> Arc<Session> {
        lock(&self.state.0.state)
            .session
            .clone()
            .expect("an open library")
    }

    /// The catalog's entry at `path`, as the UI names it.
    pub(crate) fn reference(&self, path: &str) -> EntryRef {
        let entry = self
            .session()
            .catalog()
            .read(|tx| folio_core::catalog::entry(tx, &RelPath::parse(path).unwrap()))
            .unwrap()
            .unwrap_or_else(|| panic!("no entry at {path}"));
        EntryRef {
            id: entry.id.to_string(),
            path: entry.record.path.to_string(),
        }
    }

    pub(crate) fn workspace(&self) -> Current {
        self.state.workspace().unwrap()
    }

    /// Each `WorkspaceChanged` sent so far, with when.
    pub(crate) fn workspace_events(&self) -> Vec<(Instant, WorkspaceChanged)> {
        self.events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(at, event)| match event {
                Event::Workspace(event) => Some((*at, event.clone())),
                _ => None,
            })
            .collect()
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let result = self.state.shutdown();
        if !thread::panicking() {
            result.unwrap();
        }
    }
}

/// The library tests' polling, for the command tests outside the library module.
pub(crate) fn until<T>(what: &str, poll: impl FnMut() -> Option<T>) -> T {
    super::super::tests::until(what, poll)
}
