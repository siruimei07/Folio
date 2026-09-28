//! Fixtures shared by the unit tests.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::io::{self, Cursor, Read};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use crate::catalog::Catalog;
use crate::fs::{DirEntry, FileKind, FileSystem, Metadata};
use crate::meta::{DisplayName, LibraryId, PresetTag, TagDefinitions, TagId};
use crate::paths::{CoursePath, RelPath, SemesterPath};

pub fn path(text: &str) -> RelPath {
    RelPath::parse(text).unwrap()
}

pub fn semester(text: &str) -> SemesterPath {
    SemesterPath::new(path(text)).unwrap()
}

pub fn course_at(text: &str) -> CoursePath {
    CoursePath::new(path(text)).unwrap()
}

pub fn tags<const N: usize>(ids: [&str; N]) -> BTreeSet<TagId> {
    ids.into_iter()
        .map(|id| TagId::parse(id).unwrap())
        .collect()
}

/// A new catalog in `dir`.
pub fn open_catalog(dir: &Path) -> Catalog {
    let opened = Catalog::open(&dir.join("catalog.sqlite"), &library_id()).unwrap();
    assert_eq!(opened.recovered, None);
    opened.catalog
}

pub fn library_id() -> LibraryId {
    LibraryId::parse("0123456789abcdef0123456789abcdef").unwrap()
}

/// The preset tags with their Chinese names, the slides tag named `slides`.
pub fn presets(slides: &str) -> TagDefinitions {
    TagDefinitions::with_presets(|preset| {
        let name = match preset {
            PresetTag::Notes => "笔记",
            PresetTag::Slides => slides,
            PresetTag::Homework => "作业",
            PresetTag::Exam => "考试",
            PresetTag::Reference => "资料",
        };
        DisplayName::parse(name).unwrap()
    })
}

/// An in-memory file system below `root` with NTFS-like file ids: a rename keeps them, a new
/// file gets a new one. Names are compared exactly, as on a case-sensitive disk, and may be
/// anything but `/`. A clock that advances one second per change provides the times.
pub struct MemFs {
    root: PathBuf,
    state: Mutex<MemState>,
}

struct MemState {
    nodes: BTreeMap<Vec<OsString>, Node>,
    next_id: u64,
    clock: i64,
    unlistable: BTreeSet<Vec<OsString>>,
    unreadable: BTreeSet<Vec<OsString>>,
    /// Files whose modification time moves while they are read.
    unstable: BTreeSet<Vec<OsString>>,
}

#[derive(Clone)]
struct Node {
    kind: FileKind,
    bytes: Vec<u8>,
    id: Option<u64>,
    modified_ns: i64,
    created_ns: i64,
}

/// The names of `path`, split at `/`.
fn names(path: &str) -> Vec<OsString> {
    path.split('/').map(OsString::from).collect()
}

impl MemState {
    fn tick(&mut self) -> i64 {
        self.clock += 1_000_000_000;
        self.clock
    }

    fn node(&mut self, kind: FileKind, bytes: Vec<u8>) -> Node {
        self.next_id += 1;
        let now = self.tick();
        Node {
            kind,
            bytes,
            id: Some(self.next_id),
            modified_ns: now,
            created_ns: now,
        }
    }

    /// Creates the missing folders above `key`.
    fn parents(&mut self, key: &[OsString]) {
        for end in 1..key.len() {
            if !self.nodes.contains_key(&key[..end]) {
                let folder = self.node(FileKind::Folder, Vec::new());
                self.nodes.insert(key[..end].to_vec(), folder);
            }
        }
    }

    fn below(&self, key: &[OsString]) -> Vec<Vec<OsString>> {
        self.nodes
            .range(key.to_vec()..)
            .take_while(|(other, _)| other.starts_with(key))
            .map(|(other, _)| other.clone())
            .collect()
    }
}

impl MemFs {
    pub fn new(root: &Path) -> Arc<Self> {
        let mut state = MemState {
            nodes: BTreeMap::new(),
            next_id: 0,
            clock: 1_700_000_000_000_000_000,
            unlistable: BTreeSet::new(),
            unreadable: BTreeSet::new(),
            unstable: BTreeSet::new(),
        };
        let root_folder = state.node(FileKind::Folder, Vec::new());
        state.nodes.insert(Vec::new(), root_folder);
        Arc::new(Self {
            root: root.to_owned(),
            state: Mutex::new(state),
        })
    }

    fn state(&self) -> std::sync::MutexGuard<'_, MemState> {
        self.state.lock().unwrap()
    }

    /// Writes a file, creating its folders; an existing file keeps its id.
    pub fn file(&self, path: &str, bytes: &[u8]) {
        self.raw_file(names(path), bytes);
    }

    /// Writes a file whose last name may be any `OsString`.
    pub fn raw_file(&self, key: Vec<OsString>, bytes: &[u8]) {
        let mut state = self.state();
        state.parents(&key);
        if state.nodes.contains_key(&key) {
            let now = state.tick();
            let node = state.nodes.get_mut(&key).unwrap();
            assert_eq!(node.kind, FileKind::File);
            node.bytes = bytes.to_vec();
            node.modified_ns = now;
        } else {
            let node = state.node(FileKind::File, bytes.to_vec());
            state.nodes.insert(key, node);
        }
    }

    pub fn folder(&self, path: &str) {
        let key = names(path);
        let mut state = self.state();
        state.parents(&key);
        if !state.nodes.contains_key(&key) {
            let node = state.node(FileKind::Folder, Vec::new());
            state.nodes.insert(key, node);
        }
    }

    /// A link or a special file at `path`.
    pub fn special(&self, path: &str, kind: FileKind) {
        let key = names(path);
        let mut state = self.state();
        state.parents(&key);
        let node = state.node(kind, Vec::new());
        state.nodes.insert(key, node);
    }

    /// Replaces a file by a new one with a new id and the same creation time, as programs that
    /// save through a temporary file do (NTFS keeps the creation time).
    pub fn replace(&self, path: &str, bytes: &[u8]) {
        let key = names(path);
        let mut state = self.state();
        let created = state.nodes[&key].created_ns;
        let mut node = state.node(FileKind::File, bytes.to_vec());
        node.created_ns = created;
        state.nodes.insert(key, node);
    }

    /// Removes `path` and everything below it.
    pub fn remove(&self, path: &str) {
        let key = names(path);
        let mut state = self.state();
        for other in state.below(&key) {
            state.nodes.remove(&other);
        }
    }

    /// Moves `from` and everything below it to `to`, keeping ids and times.
    pub fn rename(&self, from: &str, to: &str) {
        let (from, to) = (names(from), names(to));
        let mut state = self.state();
        assert!(state.nodes.contains_key(&from), "{from:?} does not exist");
        assert!(!state.nodes.contains_key(&to), "{to:?} exists");
        state.parents(&to);
        for old in state.below(&from) {
            let node = state.nodes.remove(&old).unwrap();
            let mut new = to.clone();
            new.extend_from_slice(&old[from.len()..]);
            state.nodes.insert(new, node);
        }
    }

    pub fn without_id(&self, path: &str) {
        self.state().nodes.get_mut(&names(path)).unwrap().id = None;
    }

    pub fn fail_listing(&self, path: &str) {
        self.state().unlistable.insert(names(path));
    }

    pub fn fail_reading(&self, path: &str) {
        self.state().unreadable.insert(names(path));
    }

    /// Makes the file's modification time move whenever it is read.
    pub fn change_while_read(&self, path: &str) {
        self.state().unstable.insert(names(path));
    }

    pub fn kind_of(&self, path: &str) -> Option<FileKind> {
        self.state().nodes.get(&names(path)).map(|node| node.kind)
    }

    /// The current time of the clock.
    pub fn now_ns(&self) -> i64 {
        self.state().clock
    }

    fn key(&self, path: &Path) -> io::Result<Vec<OsString>> {
        let rest = path
            .strip_prefix(&self.root)
            .map_err(|_| io::Error::new(io::ErrorKind::NotFound, "outside the fake"))?;
        Ok(rest
            .components()
            .map(|name| name.as_os_str().to_owned())
            .collect())
    }

    fn metadata_of(node: &Node) -> Metadata {
        Metadata {
            kind: node.kind,
            size: if node.kind == FileKind::File {
                node.bytes.len() as u64
            } else {
                0
            },
            modified_ns: Some(node.modified_ns),
            created_ns: Some(node.created_ns),
            file_id: node.id.map(|id| format!("mem:{id}")),
        }
    }
}

impl FileSystem for MemFs {
    fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>> {
        let key = self.key(folder)?;
        let state = self.state();
        match state.nodes.get(&key) {
            None => return Err(io::ErrorKind::NotFound.into()),
            Some(node) if node.kind != FileKind::Folder => {
                return Err(io::ErrorKind::NotADirectory.into());
            }
            Some(_) => {}
        }
        if state.unlistable.contains(&key) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        Ok(state
            .nodes
            .range(key.clone()..)
            .take_while(|(other, _)| other.starts_with(&key))
            .filter(|(other, _)| other.len() == key.len() + 1)
            .map(|(other, node)| DirEntry {
                name: other.last().unwrap().clone(),
                metadata: Self::metadata_of(node),
            })
            .collect())
    }

    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        let key = self.key(path)?;
        let state = self.state();
        state
            .nodes
            .get(&key)
            .map(Self::metadata_of)
            .ok_or_else(|| io::ErrorKind::NotFound.into())
    }

    fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>> {
        let key = self.key(path)?;
        let mut state = self.state();
        if state.unreadable.contains(&key) {
            return Err(io::ErrorKind::PermissionDenied.into());
        }
        let now = if state.unstable.contains(&key) {
            Some(state.tick())
        } else {
            None
        };
        let node = state.nodes.get_mut(&key).ok_or(io::ErrorKind::NotFound)?;
        if node.kind != FileKind::File {
            return Err(io::ErrorKind::IsADirectory.into());
        }
        if let Some(now) = now {
            node.modified_ns = now;
        }
        Ok(Box::new(Cursor::new(node.bytes.clone())))
    }
}
