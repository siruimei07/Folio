use std::collections::{BTreeMap, BTreeSet};
use std::io::Cursor;

use proptest::prelude::*;

use super::*;
use crate::store::strategies::{commit_of, first_commit, noise, text, tree_of};
use crate::store::{
    HistoryChecker, JsonError, MIN_PACK_LEN, MemorySink, Name, SchemaError, TreeEntry, ValueError,
    flatten,
};
use crate::test_support::not_unicode;

const BLOB: ObjectKind = ObjectKind::Blob;

/// A library folder for the store, in a temporary folder.
struct Library {
    dir: tempfile::TempDir,
    layout: Layout,
}

impl Library {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        Self { dir, layout }
    }

    /// The store as a process that starts now opens it.
    fn store(&self) -> LocalStore {
        LocalStore::new(&self.layout)
    }

    /// The names of the pack files in `staging/`.
    fn staged_files(&self) -> Vec<String> {
        let Ok(entries) = fs::read_dir(self.layout.staging_dir()) else {
            return Vec::new();
        };
        let mut names: Vec<String> = entries
            .map(|entry| entry.unwrap().file_name().into_string().unwrap())
            .filter(|name| is_staging_name(name))
            .collect();
        names.sort();
        names
    }

    /// Every entry of `staging/`, by name.
    fn staging_entries(&self) -> BTreeSet<OsString> {
        match fs::read_dir(self.layout.staging_dir()) {
            Ok(entries) => entries.map(|entry| entry.unwrap().file_name()).collect(),
            Err(_) => BTreeSet::new(),
        }
    }
}

/// What tests store: a blob that compresses, one that does not, a tree and a commit.
#[derive(Debug, Clone)]
struct Batch {
    blobs: Vec<Vec<u8>>,
    tree: Encoded,
    commit: Encoded,
}

impl Batch {
    /// A batch; each seed gives other objects.
    fn new(seed: usize) -> Self {
        let blobs = vec![text(2000 + seed), noise(300 + seed)];
        let tree = tree_of(&blobs[0], 1 + seed);
        let commit = commit_of(tree.id());
        Self {
            blobs,
            tree,
            commit,
        }
    }

    fn head(&self) -> ObjectId {
        self.commit.id()
    }

    fn ids(&self) -> BTreeSet<ObjectId> {
        let blobs = self.blobs.iter().map(|blob| ObjectId::of(BLOB, blob));
        blobs.chain([self.tree.id(), self.commit.id()]).collect()
    }

    /// Writes the batch into one pack in `staging/`.
    fn stage(&self, store: &LocalStore) -> Result<StagedPack, StoreError> {
        let mut writer = store.pack_writer()?;
        for blob in &self.blobs {
            writer.add_blob(blob, true)?;
        }
        writer.add_object(&self.tree, true)?;
        writer.add_object(&self.commit, true)?;
        writer.stage()
    }

    /// Writes and publishes the batch, as a commit of it does.
    fn publish(&self, store: &LocalStore) -> PackIndex {
        store.publish(self.stage(store).unwrap()).unwrap().index
    }

    /// Checks that `store` gives back every object of the batch where `locator` says it is.
    fn assert_readable(&self, store: &LocalStore, locator: &impl Locator) {
        let at = |id| locator.locate(id).unwrap().expect("the object is indexed");
        for blob in &self.blobs {
            let id = ObjectId::of(BLOB, blob);
            let mut read = Vec::new();
            let mut reader = store.open_blob(id, at(id)).unwrap();
            reader.read_to_end(&mut read).unwrap();
            assert!(reader.is_verified());
            assert_eq!(&read, blob);
        }
        let tree = store.read_tree(self.tree.id(), at(self.tree.id())).unwrap();
        assert_eq!(tree.encode().unwrap(), self.tree);
        let commit = store
            .read_commit(self.commit.id(), at(self.commit.id()))
            .unwrap();
        assert_eq!(commit.encode().unwrap(), self.commit);
    }
}

/// The index of every pack in `packs/` but `skip`.
fn index_without(store: &LocalStore, skip: Option<PackName>) -> MemoryIndex {
    let mut index = MemoryIndex::new();
    for name in store.list_packs().unwrap().packs {
        if Some(name) != skip {
            index.add_pack(&store.read_pack_index(name).unwrap());
        }
    }
    index
}

/// What a process that starts after a crash finds: every pack in `packs/` passes the full check,
/// except a pack damaged before the operation (`damaged`, still as it was); `HEAD` names one of
/// `heads`; the objects of `earlier` read back; and `clean_staging` leaves no pack file in
/// `staging/`.
fn assert_recovers(
    library: &Library,
    heads: &[Option<ObjectId>],
    earlier: &Batch,
    damaged: Option<(PackName, &[u8])>,
) {
    let store = library.store();
    let listing = store.list_packs().unwrap();
    assert!(listing.foreign.is_empty(), "{listing:?}");
    for &name in &listing.packs {
        match damaged {
            Some((bad, bytes)) if bad == name => {
                assert_eq!(fs::read(store.pack_path(name)).unwrap(), bytes);
            }
            _ => {
                store.verify_pack(name).unwrap();
            }
        }
    }
    let head = store.read_head().unwrap();
    assert!(heads.contains(&head), "{head:?} is not one of {heads:?}");
    earlier.assert_readable(
        &store,
        &index_without(&store, damaged.map(|(name, _)| name)),
    );
    store.clean_staging().unwrap();
    assert_eq!(library.staged_files(), Vec::<String>::new());
}

/// Steps with each run of one step written once.
fn runs(steps: &[&'static str]) -> Vec<&'static str> {
    let mut runs = steps.to_vec();
    runs.dedup();
    runs
}

/// What a refused call names, and why.
fn refused<T: std::fmt::Debug>(result: Result<T, StoreError>) -> (Subject, Problem) {
    match result {
        Err(StoreError::Invalid { what, problem }) => (what, problem),
        other => panic!("not refused as invalid: {other:?}"),
    }
}

fn found(found: FileKind, expected: FileKind) -> Problem {
    Problem::Found { found, expected }
}

/// A junction at `link` to the folder `target`: a link that needs no privileges.
#[cfg(windows)]
fn junction(link: &Path, target: &Path) {
    let status = std::process::Command::new("cmd")
        .args(["/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap()
        .status;
    assert!(status.success(), "mklink /J {}", link.display());
}

/// Opens the file `path` as another program does that keeps it open while Folio works (an editor,
/// an indexer): reading, and sharing reading and writing but not deleting, so the file can be read
/// but not renamed, replaced or deleted. M1's tests hold files the same way.
#[cfg(windows)]
fn hold(path: &Path) -> File {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::{FILE_SHARE_READ, FILE_SHARE_WRITE};
    fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
        .open(path)
        .unwrap()
}

/// Opens the file or folder `path` sharing nothing, so no other handle may read or list it.
#[cfg(windows)]
fn hold_exclusively(path: &Path) -> File {
    use std::os::windows::fs::OpenOptionsExt;
    use windows_sys::Win32::Storage::FileSystem::FILE_FLAG_BACKUP_SEMANTICS;
    fs::OpenOptions::new()
        .read(true)
        .share_mode(0)
        // Needed to open a folder; a file opens the same with it.
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .unwrap()
}

/// The I/O error a call ended with, after checking that it names `path`.
#[cfg(windows)]
fn io_error_at<T: std::fmt::Debug>(result: Result<T, StoreError>, path: &Path) -> io::Error {
    match result {
        Err(StoreError::Io { path: at, source }) if at == path => source,
        other => panic!("not an I/O error at {}: {other:?}", path.display()),
    }
}

/// Whether `error` is what Windows reports while another program holds a file open: a sharing
/// violation, or access denied for a file open without delete sharing that a rename would replace.
#[cfg(windows)]
fn held_open(error: &io::Error) -> bool {
    const ERROR_ACCESS_DENIED: i32 = 5;
    crate::fs::is_in_use(error) || error.raw_os_error() == Some(ERROR_ACCESS_DENIED)
}

#[test]
fn the_store_lives_in_folio_local() {
    let library = Library::new();
    let local = library.dir.path().join(".folio").join("local");
    assert_eq!(library.layout.packs_dir(), local.join("packs"));
    assert_eq!(library.layout.head_file(), local.join("HEAD"));
    let name = PackName::from_bytes([0xab; 32]);
    assert_eq!(
        library.store().pack_path(name),
        local
            .join("packs")
            .join(format!("{}.pack", "ab".repeat(32)))
    );
}

#[test]
fn head_is_absent_until_written_and_then_reads_back() {
    let library = Library::new();
    let store = library.store();
    assert_eq!(store.read_head().unwrap(), None);
    let (first, second) = (Batch::new(0).head(), Batch::new(1).head());

    store.write_head(first).unwrap();
    assert_eq!(store.read_head().unwrap(), Some(first));
    let bytes = fs::read(library.layout.head_file()).unwrap();
    assert_eq!(
        String::from_utf8(bytes).unwrap(),
        format!(r#"{{"format_version":1,"head":"{first}"}}"#)
    );
    store.write_head(second).unwrap();
    assert_eq!(library.store().read_head().unwrap(), Some(second));
    assert_eq!(fs::read(library.layout.head_file()).unwrap().len(), 97);
    assert!(library.staging_entries().is_empty());
}

#[test]
fn head_that_is_not_head_is_refused() {
    let head = Batch::new(0).head();
    let canonical = format!(r#"{{"format_version":1,"head":"{head}"}}"#);
    let invalid = |problem: Problem| Err(problem);
    let json = |error: JsonError| Err(Problem::Json(error));
    let schema = |error: SchemaError| Err(Problem::Schema(error));
    let newer = |version: &str| Ok(version.to_owned());
    let mut padded_newer = String::from(r#"{"format_version":2"#);
    padded_newer.push_str(&" ".repeat(4096 - padded_newer.len() - 1));
    padded_newer.push('}');
    let len = canonical.len();
    let cases: Vec<(&str, Vec<u8>, Result<String, Problem>)> = vec![
        ("empty", Vec::new(), json(JsonError::Syntax { offset: 0 })),
        (
            "zero-filled",
            vec![0; len],
            json(JsonError::Syntax { offset: 0 }),
        ),
        (
            "garbage",
            b"HEAD".to_vec(),
            json(JsonError::Syntax { offset: 0 }),
        ),
        (
            "not UTF-8",
            b"{\"\xff\":1}".to_vec(),
            json(JsonError::Utf8 { offset: 2 }),
        ),
        (
            "byte order mark",
            [&b"\xEF\xBB\xBF"[..], canonical.as_bytes()].concat(),
            json(JsonError::Syntax { offset: 0 }),
        ),
        (
            "line break",
            format!("{canonical}\n").into_bytes(),
            json(JsonError::NotCanonical { offset: len }),
        ),
        (
            // Found at the key that comes too late.
            "keys out of order",
            format!(r#"{{"head":"{head}","format_version":1}}"#).into_bytes(),
            json(JsonError::NotCanonical {
                offset: r#"{"head":"","#.len() + head.to_string().len(),
            }),
        ),
        (
            "no version",
            format!(r#"{{"head":"{head}"}}"#).into_bytes(),
            invalid(Problem::FormatVersion),
        ),
        (
            "version as text",
            format!(r#"{{"format_version":"1","head":"{head}"}}"#).into_bytes(),
            invalid(Problem::FormatVersion),
        ),
        (
            "version 0",
            format!(r#"{{"format_version":0,"head":"{head}"}}"#).into_bytes(),
            invalid(Problem::FormatVersion),
        ),
        (
            "version with a fraction",
            format!(r#"{{"format_version":1.0,"head":"{head}"}}"#).into_bytes(),
            invalid(Problem::FormatVersion),
        ),
        ("an array", b"[1]".to_vec(), invalid(Problem::FormatVersion)),
        (
            "no head",
            br#"{"format_version":1}"#.to_vec(),
            schema(SchemaError::MissingField {
                part: Part::Head,
                field: "head",
            }),
        ),
        (
            "another field",
            format!(r#"{{"format_version":1,"head":"{head}","x":true}}"#).into_bytes(),
            schema(SchemaError::UnknownField {
                part: Part::Head,
                field: "x".into(),
            }),
        ),
        (
            "head not an id",
            br#"{"format_version":1,"head":"HEAD"}"#.to_vec(),
            schema(SchemaError::Value {
                part: Part::Head,
                field: "head",
                error: ValueError::ObjectId,
            }),
        ),
        (
            "head a number",
            br#"{"format_version":1,"head":7}"#.to_vec(),
            schema(SchemaError::WrongType {
                part: Part::Head,
                field: "head",
                expected: "a string",
            }),
        ),
        (
            "newer",
            format!(r#"{{"format_version":2,"head":"{head}"}}"#).into_bytes(),
            newer("2"),
        ),
        (
            "newer, whatever else it holds",
            b"{\n  \"format_version\": 2,\n  \"head\": null,\n  \"x\": [1.5]\n}\n".to_vec(),
            newer("2"),
        ),
        (
            "newer beyond 64 bits",
            br#"{"format_version":123456789012345678901}"#.to_vec(),
            newer("123456789012345678901"),
        ),
        ("newer at 4 KiB", padded_newer.into_bytes(), newer("2")),
        (
            "over 4 KiB",
            format!("{canonical}{}", " ".repeat(4096 - len + 1)).into_bytes(),
            invalid(Problem::TooLarge { limit: 4096 }),
        ),
    ];
    let library = Library::new();
    let store = library.store();
    let path = library.layout.head_file();
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    for (label, bytes, expected) in cases {
        fs::write(&path, &bytes).unwrap();
        let outcome = match store.read_head() {
            Err(StoreError::Invalid { what, problem }) => {
                assert_eq!(what, Subject::Head(path.clone()), "{label}");
                Err(problem)
            }
            Err(StoreError::Newer { what, version }) => {
                assert_eq!(what, Subject::Head(path.clone()), "{label}");
                Ok(version)
            }
            other => panic!("{label}: {other:?}"),
        };
        assert_eq!(outcome, expected, "{label}");
    }
    fs::write(&path, &canonical).unwrap();
    assert_eq!(store.read_head().unwrap(), Some(head));

    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    let folder = (
        Subject::Head(path.clone()),
        found(FileKind::Folder, FileKind::File),
    );
    assert_eq!(refused(store.read_head()), folder);
    assert_eq!(refused(store.write_head(head)), folder);
    assert!(path.is_dir());
}

#[test]
fn a_pack_is_staged_then_published_and_read_back() {
    let library = Library::new();
    let store = library.store();
    let batch = Batch::new(0);

    let staged = batch.stage(&store).unwrap();
    let file = staged.path().file_name().unwrap().to_str().unwrap();
    assert!(is_staging_name(file), "{file}");
    assert_eq!(staged.path().parent(), Some(&*library.layout.staging_dir()));
    assert_eq!(staged.name(), staged.index().name());
    assert_eq!(
        staged
            .index()
            .entries()
            .iter()
            .map(|entry| entry.id)
            .collect::<BTreeSet<_>>(),
        batch.ids()
    );
    // Nothing names it yet.
    assert!(!store.has_packs().unwrap());

    let index = staged.index().clone();
    let published = store.publish(staged).unwrap();
    assert_eq!(
        published,
        Published {
            index: index.clone(),
            how: Publication::New
        }
    );
    assert!(library.staging_entries().is_empty());
    let path = store.pack_path(index.name());
    assert_eq!(fs::metadata(&path).unwrap().len(), index.size());
    assert_eq!(store.read_pack_index(index.name()).unwrap(), index);
    assert_eq!(store.verify_pack(index.name()).unwrap(), index);
    assert_eq!(
        store.list_packs().unwrap(),
        PackListing {
            packs: vec![index.name()],
            foreign: Vec::new()
        }
    );
    let located = MemoryIndex::of_store(&store).unwrap();
    assert_eq!(located.len(), 4);
    batch.assert_readable(&store, &located);

    // Objects of another kind than asked for are refused.
    let tree = located.get(batch.tree.id()).unwrap();
    assert_eq!(
        refused(store.open_blob(batch.tree.id(), tree)),
        (
            Subject::Object(batch.tree.id()),
            PackProblem::WrongKind {
                found: ObjectKind::Tree,
                wanted: BLOB
            }
            .into()
        )
    );
    let commit = located.get(batch.commit.id()).unwrap();
    assert!(matches!(
        refused(store.read_tree(batch.commit.id(), commit)).1,
        Problem::Pack(PackProblem::WrongKind { .. })
    ));
    // An object in a pack that is not there is missing.
    let elsewhere = Location {
        pack: PackName::from_bytes([7; 32]),
        offset: tree.offset,
    };
    let tree_id = batch.tree.id();
    assert!(
        matches!(store.read_tree(tree_id, elsewhere), Err(StoreError::Missing(id)) if id == tree_id)
    );
    assert!(matches!(
        store.open_blob(tree_id, elsewhere),
        Err(StoreError::Missing(_))
    ));
    assert!(matches!(
        store.read_pack_index(elsewhere.pack),
        Err(StoreError::Io { source, .. }) if source.kind() == io::ErrorKind::NotFound
    ));
}

#[test]
fn abandoned_packs_leave_nothing_in_staging() {
    let library = Library::new();
    let store = library.store();
    // A temporary file of another writer is not the store's.
    fs::create_dir_all(library.layout.staging_dir()).unwrap();
    let other = library.layout.staging_dir().join("4242-0.part");
    fs::write(&other, b"metadata").unwrap();

    let mut writer = store.pack_writer().unwrap();
    writer.add_blob(&text(100), true).unwrap();
    writer.abandon().unwrap();
    Batch::new(0).stage(&store).unwrap().abandon().unwrap();
    // An empty writer leaves its file behind when it is finished, for clean_staging.
    let empty = store.pack_writer().unwrap();
    assert!(matches!(
        refused(empty.stage()).1,
        Problem::Pack(PackProblem::Empty)
    ));
    assert_eq!(library.staged_files().len(), 1);
    assert_eq!(store.clean_staging().unwrap(), 1);

    let mut set = PackSet::new(
        &store,
        Limits {
            word_alone: 100,
            max: 10_000,
        },
    );
    set.add_blob(&noise(150), BlobClass::Word).unwrap();
    set.add_blob(&text(500), BlobClass::Text).unwrap();
    set.abandon().unwrap();
    assert_eq!(
        library.staging_entries(),
        BTreeSet::from([OsString::from("4242-0.part")])
    );
    assert!(!store.has_packs().unwrap());
}

#[test]
fn publishing_keeps_a_valid_pack_of_the_same_name() {
    let library = Library::new();
    let store = library.store();
    let batch = Batch::new(0);
    let index = batch.publish(&store);
    let path = store.pack_path(index.name());
    let before = fs::read(&path).unwrap();

    let published = store.publish(batch.stage(&store).unwrap()).unwrap();
    assert_eq!(
        published,
        Published {
            index,
            how: Publication::Kept
        }
    );
    assert_eq!(fs::read(&path).unwrap(), before);
    assert!(library.staging_entries().is_empty());
}

/// Damage a pack can have at its name: what a power loss, a full disk or a stray write leaves, and
/// a whole pack of other objects that another program copied or renamed there, valid in itself.
fn damaged(pack: &[u8]) -> Vec<(&'static str, Vec<u8>)> {
    let mut flipped_record = pack.to_vec();
    flipped_record[70] ^= 1;
    let mut flipped_hash = pack.to_vec();
    *flipped_hash.last_mut().unwrap() ^= 1;
    let mut newer = pack.to_vec();
    newer[8] = 2;
    let mut another = PackWriter::new(MemorySink::new()).unwrap();
    another.add_blob(&text(777), true).unwrap();
    let another = another.finish().unwrap().1.into_bytes();
    vec![
        ("zero-filled", vec![0; pack.len()]),
        ("empty", Vec::new()),
        ("cut by one byte", pack[..pack.len() - 1].to_vec()),
        ("cut in half", pack[..pack.len() / 2].to_vec()),
        ("a record byte changed", flipped_record),
        ("the hash changed", flipped_hash),
        ("a newer version", newer),
        ("another pack's bytes", another),
    ]
}

#[test]
fn publishing_replaces_a_damaged_pack_of_the_same_name() {
    let batch = Batch::new(0);
    let good = {
        let library = Library::new();
        let store = library.store();
        let index = batch.publish(&store);
        fs::read(store.pack_path(index.name())).unwrap()
    };
    for (label, bytes) in damaged(&good) {
        let library = Library::new();
        let store = library.store();
        let staged = batch.stage(&store).unwrap();
        let name = staged.name();
        let path = store.pack_path(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, &bytes).unwrap();
        // Indexing never takes a pack cut short or zero-filled for a valid one.
        if label != "a record byte changed" {
            assert!(store.read_pack_index(name).is_err(), "{label}");
        }
        assert!(store.verify_pack(name).is_err(), "{label}");

        let published = store.publish(staged).unwrap();
        assert_eq!(published.how, Publication::Replaced, "{label}");
        assert_eq!(fs::read(&path).unwrap(), good, "{label}");
        assert_eq!(store.verify_pack(name).unwrap(), published.index, "{label}");
        assert!(library.staging_entries().is_empty(), "{label}");
    }
}

#[test]
fn publishing_reports_what_it_cannot_do() {
    let library = Library::new();
    let store = library.store();
    let batch = Batch::new(0);
    // A staged file that is gone is an I/O error, and nothing is published.
    let staged = batch.stage(&store).unwrap();
    fs::remove_file(staged.path()).unwrap();
    assert!(matches!(
        store.publish(staged),
        Err(StoreError::Io { source, .. }) if source.kind() == io::ErrorKind::NotFound
    ));
    assert!(!store.has_packs().unwrap());

    // A pack of the name that cannot be read is neither trusted nor replaced.
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let index = batch.publish(&store);
        let path = store.pack_path(index.name());
        let held = fs::OpenOptions::new()
            .read(true)
            .share_mode(0)
            .open(&path)
            .unwrap();
        let staged = batch.stage(&store).unwrap();
        let staged_path = staged.path().to_path_buf();
        let error = store.publish(staged).unwrap_err();
        assert!(
            matches!(&error, StoreError::Io { path: at, source } if *at == path && crate::fs::is_in_use(source)),
            "{error:?}"
        );
        drop(held);
        assert!(staged_path.exists());
        assert_eq!(store.verify_pack(index.name()).unwrap(), index);
        assert_eq!(store.clean_staging().unwrap(), 1);
    }
}

/// The commit point fails, and says so, while another program holds `HEAD` open: `HEAD` still
/// names the old commit, and the write leaves nothing in `staging/`.
#[cfg(windows)]
#[test]
fn a_head_held_open_is_not_replaced() {
    let library = Library::new();
    let store = library.store();
    let (first, second) = (Batch::new(0).head(), Batch::new(1).head());
    store.write_head(first).unwrap();
    let path = library.layout.head_file();
    let held = hold(&path);
    let error = io_error_at(store.write_head(second), &path);
    assert!(held_open(&error), "{error}");
    drop(held);
    assert_eq!(store.read_head().unwrap(), Some(first));
    assert!(library.staging_entries().is_empty());
    store.write_head(second).unwrap();
    assert_eq!(store.read_head().unwrap(), Some(second));
}

/// The commit point fails, and says so, when `HEAD`'s new content cannot be written or flushed, as
/// on a full disk (injected here): `HEAD` still names the old commit, and the write leaves nothing
/// in `staging/`.
#[test]
fn a_head_whose_write_or_flush_fails_is_not_replaced() {
    for step in ["atomic.write", "atomic.sync"] {
        let library = Library::new();
        let store = library.store();
        let (first, second) = (Batch::new(0).head(), Batch::new(1).head());
        store.write_head(first).unwrap();
        match crash::fail_at(step, || store.write_head(second)) {
            Err(StoreError::Io { path, source }) => {
                assert_eq!(path, library.layout.head_file(), "{step}");
                assert_eq!(source.to_string(), format!("a fault injected at {step}"));
            }
            other => panic!("{step}: {other:?}"),
        }
        assert_eq!(store.read_head().unwrap(), Some(first), "{step}");
        assert!(library.staging_entries().is_empty(), "{step}");
        store.write_head(second).unwrap();
        assert_eq!(store.read_head().unwrap(), Some(second), "{step}");
    }
}

/// A damaged pack at the name that another program holds open is not replaced, and publishing
/// says so: the damaged bytes stay, and so does the staged pack, for `clean_staging`.
#[cfg(windows)]
#[test]
fn a_damaged_pack_held_open_is_neither_trusted_nor_replaced() {
    let library = Library::new();
    let store = library.store();
    let batch = Batch::new(0);
    let staged = batch.stage(&store).unwrap();
    let target = store.pack_path(staged.name());
    fs::create_dir_all(target.parent().unwrap()).unwrap();
    let zeros = vec![0; usize::try_from(staged.index().size()).unwrap()];
    fs::write(&target, &zeros).unwrap();
    let staged_path = staged.path().to_path_buf();
    let held = hold(&target);
    let error = io_error_at(store.publish(staged), &target);
    assert!(held_open(&error), "{error}");
    drop(held);
    assert_eq!(fs::read(&target).unwrap(), zeros);
    assert!(staged_path.exists());
    // Let go, the damaged pack is replaced.
    let published = store.publish(batch.stage(&store).unwrap()).unwrap();
    assert_eq!(published.how, Publication::Replaced);
    assert_eq!(
        store.verify_pack(published.index.name()).unwrap(),
        published.index
    );
    assert_eq!(store.clean_staging().unwrap(), 1);
}

/// A pack another program holds open is not removed, and the removal says so.
#[cfg(windows)]
#[test]
fn a_pack_held_open_is_not_removed() {
    let library = Library::new();
    let store = library.store();
    let index = Batch::new(0).publish(&store);
    let path = store.pack_path(index.name());
    let held = hold(&path);
    let error = io_error_at(store.remove_pack(index.name()), &path);
    assert!(held_open(&error), "{error}");
    drop(held);
    assert_eq!(store.list_packs().unwrap().packs, [index.name()]);
    assert_eq!(store.verify_pack(index.name()).unwrap(), index);
    assert!(library.staged_files().is_empty());
    assert!(store.remove_pack(index.name()).unwrap());
}

/// Staging flushes the pack, which for a small pack is the only write its file gets: when that
/// write fails (here another handle has locked the file), staging fails and says where, nothing is
/// published, and the file stays for `clean_staging`.
#[cfg(windows)]
#[test]
fn a_pack_whose_flush_fails_is_not_staged() {
    /// What Windows says to a write into a range another handle has locked.
    const ERROR_LOCK_VIOLATION: i32 = 33;
    let library = Library::new();
    let store = library.store();
    let mut writer = store.pack_writer().unwrap();
    writer.add_blob(&text(2_000), false).unwrap();
    let path = writer.sink().path().to_path_buf();
    let other = File::open(&path).unwrap();
    other.lock().unwrap();
    let error = io_error_at(writer.stage(), &path);
    assert_eq!(error.raw_os_error(), Some(ERROR_LOCK_VIOLATION), "{error}");
    drop(other);
    assert_eq!(fs::metadata(&path).unwrap().len(), 0);
    assert_eq!(library.staged_files().len(), 1);
    assert!(store.list_packs().unwrap().packs.is_empty());
    assert_eq!(store.clean_staging().unwrap(), 1);
}

/// A blob larger than the sink's buffer makes the pack's file be written while the blob is added:
/// when another handle has locked the file, adding fails and says where, and nothing is staged.
#[cfg(windows)]
#[test]
fn a_pack_locked_before_a_large_blob_is_not_staged() {
    const ERROR_LOCK_VIOLATION: i32 = 33;
    let library = Library::new();
    let store = library.store();
    let mut writer = store.pack_writer().unwrap();
    writer.add_blob(&text(2_000), true).unwrap();
    let path = writer.sink().path().to_path_buf();
    let other = File::open(&path).unwrap();
    other.lock().unwrap();
    let error = io_error_at(writer.add_blob(&noise(200 * 1024), false), &path);
    assert_eq!(error.raw_os_error(), Some(ERROR_LOCK_VIOLATION), "{error}");
    drop(other);
    let refused = writer.stage().unwrap_err();
    assert!(
        matches!(&refused, StoreError::Io { source, .. } if source.to_string() == "an earlier write to this pack failed"),
        "{refused:?}"
    );
    assert_eq!(fs::metadata(&path).unwrap().len(), 0);
    assert!(store.list_packs().unwrap().packs.is_empty());
    assert_eq!(store.clean_staging().unwrap(), 1);
}

/// Each write of a staged pack's file can fail, as on a full disk (injected here): the buffer
/// written out, a write past it, the cut of a streamed blob that did not match, the flush to the
/// disk. Writing or staging fails and says where, nothing is staged or published, and the file
/// waits for `clean_staging`.
#[test]
fn a_pack_whose_writes_cut_or_flush_fail_is_not_staged() {
    let large = noise(200 * 1024);
    let mut changed = large.clone();
    changed[100_000] ^= 1;
    let (id, size) = (ObjectId::of(BLOB, &large), Size::new(200 * 1024).unwrap());
    for step in ["pack.flush", "pack.write", "pack.truncate", "pack.sync"] {
        let library = Library::new();
        let store = library.store();
        let staged = crash::fail_at(step, || {
            let mut writer = store.pack_writer()?;
            writer.add_blob(&text(2_000), true)?;
            if step == "pack.truncate" {
                writer.add_blob_from(id, size, &changed[..], false)?;
            } else {
                writer.add_blob(&large, false)?;
            }
            writer.stage()
        });
        let left = library.staged_files();
        assert_eq!(left.len(), 1, "{step}");
        match staged {
            Err(StoreError::Io { path, source }) => {
                assert_eq!(path, library.layout.staging_dir().join(&left[0]), "{step}");
                assert_eq!(source.to_string(), format!("a fault injected at {step}"));
            }
            other => panic!("{step}: {other:?}"),
        }
        assert!(store.list_packs().unwrap().packs.is_empty(), "{step}");
        assert_eq!(store.clean_staging().unwrap(), 1, "{step}");
    }
}

/// A pack file in `staging/` that another program holds open stays, and cleaning up says so; the
/// files after it in name order are removed all the same.
#[cfg(windows)]
#[test]
fn cleaning_staging_reports_a_file_held_open() {
    let library = Library::new();
    let store = library.store();
    let mut staged = [
        Batch::new(0).stage(&store).unwrap(),
        Batch::new(1).stage(&store).unwrap(),
    ];
    staged.sort_by(|a, b| a.path().cmp(b.path()));
    let (first, second) = (staged[0].path(), staged[1].path());
    let held = hold(first);
    let error = io_error_at(store.clean_staging(), first);
    assert!(held_open(&error), "{error}");
    assert!(!second.exists());
    drop(held);
    assert!(first.exists());
    assert_eq!(store.clean_staging().unwrap(), 1);
}

/// So does abandoning a staged pack another program holds open.
#[cfg(windows)]
#[test]
fn abandoning_reports_a_file_held_open() {
    let library = Library::new();
    let store = library.store();
    let staged = Batch::new(0).stage(&store).unwrap();
    let path = staged.path().to_path_buf();
    let held = hold(&path);
    let error = io_error_at(staged.abandon(), &path);
    assert!(held_open(&error), "{error}");
    drop(held);
    assert_eq!(library.staged_files().len(), 1);
    assert_eq!(store.clean_staging().unwrap(), 1);
}

/// A staged copy of a pack that `packs/` holds already is removed when publishing keeps that pack;
/// when the copy cannot be removed, publishing says so, and the pack there stays as it was.
#[cfg(windows)]
#[test]
fn a_staged_copy_held_open_is_reported_when_its_pack_is_kept() {
    let library = Library::new();
    let store = library.store();
    let batch = Batch::new(0);
    let index = batch.publish(&store);
    let staged = batch.stage(&store).unwrap();
    let path = staged.path().to_path_buf();
    let held = hold(&path);
    let error = io_error_at(store.publish(staged), &path);
    assert!(held_open(&error), "{error}");
    drop(held);
    assert_eq!(store.verify_pack(index.name()).unwrap(), index);
    assert_eq!(library.staged_files().len(), 1);
    assert_eq!(store.clean_staging().unwrap(), 1);
}

/// Removing a pack moves it out of `packs/`, then deletes it: when the delete fails, the removal
/// says so, the pack is out of `packs/` for good, and its file waits in `staging/`.
#[test]
fn removing_a_pack_reports_a_delete_that_fails() {
    let library = Library::new();
    let store = library.store();
    let index = Batch::new(0).publish(&store);
    match crash::fail_at("pack.delete", || store.remove_pack(index.name())) {
        Err(StoreError::Io { path, source }) => {
            assert_eq!(path.parent(), Some(library.layout.staging_dir().as_path()));
            assert_eq!(source.to_string(), "a fault injected at pack.delete");
        }
        other => panic!("{other:?}"),
    }
    assert!(store.list_packs().unwrap().packs.is_empty());
    assert_eq!(library.staged_files().len(), 1);
    assert_eq!(store.clean_staging().unwrap(), 1);
}

/// Abandoning a set tries every file it made: one held open is reported, and the others are
/// removed all the same.
#[cfg(windows)]
#[test]
fn abandoning_a_set_reports_a_file_held_open_and_removes_the_others() {
    let library = Library::new();
    let store = library.store();
    let mut set = PackSet::new(&store, SMALL);
    // A Word blob in a pack of its own, staged, then a text blob in the shared pack.
    set.add_blob(&noise(1500), BlobClass::Word).unwrap();
    set.add_blob(&text(500), BlobClass::Text).unwrap();
    let path = set.staged[0].path().to_path_buf();
    let held = hold(&path);
    let error = io_error_at(set.abandon(), &path);
    assert!(held_open(&error), "{error}");
    drop(held);
    let name = path.file_name().unwrap().to_str().unwrap();
    assert_eq!(library.staged_files(), [name]);
    assert_eq!(store.clean_staging().unwrap(), 1);
}

/// A set whose shared pack ends empty (its only stream did not match) removes that pack when it
/// finishes. When it cannot, finishing says so and hands out nothing: the set's other packs are
/// removed too, and the file held open waits for `clean_staging`.
#[cfg(windows)]
#[test]
fn a_set_whose_empty_shared_pack_cannot_be_removed_hands_out_nothing() {
    let library = Library::new();
    let store = library.store();
    let mut set = PackSet::new(&store, SMALL);
    set.add_blob(&noise(1500), BlobClass::Word).unwrap();
    let expected = text(500);
    let mut changed = expected.clone();
    changed[250] ^= 1;
    let size = Size::new(500).unwrap();
    let id = ObjectId::of(BLOB, &expected);
    let streamed = set
        .add_blob_from(id, size, &changed[..], BlobClass::Text)
        .unwrap();
    assert!(
        matches!(streamed, Streamed::Mismatch { .. }),
        "{streamed:?}"
    );
    let shared = set.shared.as_ref().unwrap();
    assert_eq!(shared.object_count(), 0);
    let path = shared.sink().path().to_path_buf();
    let held = hold(&path);
    let error = io_error_at(set.finish(), &path);
    assert!(held_open(&error), "{error}");
    drop(held);
    let name = path.file_name().unwrap().to_str().unwrap();
    assert_eq!(library.staged_files(), [name]);
    assert_eq!(store.clean_staging().unwrap(), 1);
}

/// A set whose last pack cannot be flushed hands out nothing, and leaves nothing.
#[cfg(windows)]
#[test]
fn a_set_whose_last_pack_cannot_be_flushed_hands_out_nothing() {
    /// What Windows says to a write into a range another handle has locked.
    const ERROR_LOCK_VIOLATION: i32 = 33;
    let library = Library::new();
    let store = library.store();
    let mut set = PackSet::new(&store, SMALL);
    set.add_blob(&noise(1500), BlobClass::Word).unwrap();
    set.add_blob(&text(2_000), BlobClass::Text).unwrap();
    let path = set.shared.as_ref().unwrap().sink().path().to_path_buf();
    let other = File::open(&path).unwrap();
    other.lock().unwrap();
    let error = io_error_at(set.finish(), &path);
    assert_eq!(error.raw_os_error(), Some(ERROR_LOCK_VIOLATION), "{error}");
    drop(other);
    assert!(library.staged_files().is_empty());
}

/// Abandoning a set after a stream in a pack of its own did not match: that pack went at once, and
/// abandoning removes the rest, the pack that is gone already included.
#[test]
fn abandoning_a_set_after_a_stream_alone_did_not_match() {
    let library = Library::new();
    let store = library.store();
    let mut set = PackSet::new(&store, SMALL);
    let expected = noise(1500);
    let mut changed = expected.clone();
    changed[700] ^= 1;
    let size = Size::new(1500).unwrap();
    let id = ObjectId::of(BLOB, &expected);
    let streamed = set
        .add_blob_from(id, size, &changed[..], BlobClass::Word)
        .unwrap();
    assert!(
        matches!(streamed, Streamed::Mismatch { .. }),
        "{streamed:?}"
    );
    assert!(library.staged_files().is_empty());
    set.add_blob(&text(500), BlobClass::Text).unwrap();
    assert_eq!(library.staged_files().len(), 1);
    set.abandon().unwrap();
    assert!(library.staged_files().is_empty());
}

/// When the pack of its own that a stream did not match cannot be removed, the offer says so
/// instead of reporting the mismatch alone, and abandoning the set removes the file later.
#[test]
fn a_stream_alone_whose_pack_cannot_be_removed_fails_its_offer() {
    let library = Library::new();
    let store = library.store();
    let mut set = PackSet::new(&store, SMALL);
    let expected = noise(1500);
    let mut changed = expected.clone();
    changed[700] ^= 1;
    let size = Size::new(1500).unwrap();
    let id = ObjectId::of(BLOB, &expected);
    let offered = crash::fail_at("pack.abandon", || {
        set.add_blob_from(id, size, &changed[..], BlobClass::Word)
    });
    match offered {
        Err(StoreError::Io { path, source }) => {
            assert_eq!(path.parent(), Some(library.layout.staging_dir().as_path()));
            assert_eq!(source.to_string(), "a fault injected at pack.abandon");
        }
        other => panic!("{other:?}"),
    }
    assert!(!set.contains(id));
    assert_eq!(library.staged_files().len(), 1);
    set.abandon().unwrap();
    assert!(library.staged_files().is_empty());
}

/// A full shared pack that fails to be finished when an object starts a new one is gone, with the
/// objects the set took into it. So after an offer fails, every later offer fails, those objects
/// included, and so does finishing, which removes every file the set made: the set never hands out
/// packs that lack objects it took. The same holds after a pack of its own failed to be finished.
#[test]
fn a_set_whose_offer_failed_takes_nothing_more_and_hands_out_nothing() {
    let (a, b, c) = (noise(8000), noise(8001), noise(8002));
    // `c` does not fit beside `a` and `b` in SMALL's 20,000 bytes; as a Word blob it is alone.
    for class in [BlobClass::Text, BlobClass::Word] {
        let library = Library::new();
        let store = library.store();
        let mut set = PackSet::new(&store, SMALL);
        for blob in [&a, &b] {
            assert_eq!(set.add_blob(blob, BlobClass::Text).unwrap(), InSet::Written);
        }
        let shared = set.shared.as_ref().unwrap().sink().path().to_path_buf();
        match crash::fail_at("pack.sync", || set.add_blob(&c, class)) {
            Err(StoreError::Io { path, source }) => {
                assert_eq!(path == shared, class == BlobClass::Text, "{class:?}");
                assert_eq!(source.to_string(), "a fault injected at pack.sync");
            }
            other => panic!("{class:?}: {other:?}"),
        }
        let unusable = |result: Result<_, StoreError>| match result {
            Err(StoreError::Io { path, source }) => {
                assert_eq!(path, library.layout.staging_dir(), "{class:?}");
                assert_eq!(
                    source.to_string(),
                    "an earlier offer to this pack set failed"
                );
            }
            other => panic!("{class:?}: {other:?}"),
        };
        for blob in [&a, &c, &noise(10)] {
            unusable(set.add_blob(blob, BlobClass::Text).map(drop));
        }
        let size = Size::new(8000).unwrap();
        unusable(
            set.add_blob_from(ObjectId::of(BLOB, &a), size, &a[..], class)
                .map(drop),
        );
        unusable(set.add_object(&tree_of(&a, 1), true).map(drop));
        unusable(set.finish().map(drop));
        assert!(library.staged_files().is_empty(), "{class:?}");
    }
}

/// Objects in a pack that another program holds exclusively cannot be read, which is an I/O error
/// about the pack: never a missing object, which would mean damaged history.
#[cfg(windows)]
#[test]
fn objects_in_a_pack_held_exclusively_are_unreadable_not_missing() {
    let library = Library::new();
    let store = library.store();
    let batch = Batch::new(0);
    let index = batch.publish(&store);
    let located = MemoryIndex::of_store(&store).unwrap();
    let at = |id| located.get(id).unwrap();
    let (tree, commit) = (batch.tree.id(), batch.commit.id());
    let blob = ObjectId::of(BLOB, &batch.blobs[0]);
    let path = store.pack_path(index.name());
    let held = hold_exclusively(&path);
    let in_use = |result: Result<(), StoreError>| {
        let error = io_error_at(result, &path);
        assert!(crate::fs::is_in_use(&error), "{error}");
    };
    in_use(store.read_tree(tree, at(tree)).map(drop));
    in_use(store.read_commit(commit, at(commit)).map(drop));
    in_use(store.open_blob(blob, at(blob)).map(drop));
    in_use(store.trees(&located).tree(tree).map(drop));
    in_use(store.read_pack_index(index.name()).map(drop));
    in_use(MemoryIndex::of_store(&store).map(drop));
    // So does a history check, whose missing trees would mean damage.
    let parsed = Commit::parse(batch.commit.bytes()).unwrap();
    let mut checker = HistoryChecker::new(store.trees(&located));
    in_use(checker.check_commit(commit, &parsed, None));
    drop(held);
    batch.assert_readable(&store, &located);
}

/// Every read and write of the store starts by looking at what is at its paths. A look that fails,
/// other than at nothing there, is that call's I/O error naming the path: `HEAD` is never taken
/// for absent, nor `packs/` for empty, which would read as a library without history or a damaged
/// one (versioning.md §4.2). A file held open never makes the look fail, so a fault does.
#[test]
fn a_failing_look_at_a_store_path_is_an_error_not_an_absence() {
    fn failed<T: std::fmt::Debug>(result: Result<T, StoreError>, path: &Path) {
        match result {
            Err(StoreError::Io { path: at, source }) if at == path => {
                assert_eq!(source.to_string(), "a fault injected at store.metadata");
            }
            other => panic!("not an I/O error at {}: {other:?}", path.display()),
        }
    }
    let library = Library::new();
    let store = library.store();
    let batch = Batch::new(0);
    let index = batch.publish(&store);
    store.write_head(batch.head()).unwrap();
    let staged = batch.stage(&store).unwrap();
    let (head, packs, staging) = (
        library.layout.head_file(),
        library.layout.packs_dir(),
        library.layout.staging_dir(),
    );
    let faulty = |operation: &dyn Fn(&LocalStore) -> Result<(), StoreError>| {
        crash::fail_at("store.metadata", || operation(&store))
    };
    failed(faulty(&|store| store.read_head().map(drop)), &head);
    failed(faulty(&|store| store.list_packs().map(drop)), &packs);
    failed(faulty(&|store| store.has_packs().map(drop)), &packs);
    failed(faulty(&|store| store.write_head(batch.head())), &staging);
    failed(faulty(&|store| store.pack_writer().map(drop)), &staging);
    failed(faulty(&|store| store.clean_staging().map(drop)), &staging);
    failed(
        faulty(&|store| store.remove_pack(index.name()).map(drop)),
        &packs,
    );
    let published = crash::fail_at("store.metadata", || store.publish(staged));
    failed(published, &packs);
    // Without the fault, all is as it was.
    assert_eq!(store.read_head().unwrap(), Some(batch.head()));
    assert_eq!(store.list_packs().unwrap().packs, [index.name()]);
    batch.assert_readable(&store, &MemoryIndex::of_store(&store).unwrap());
}

/// `HEAD` held exclusively by another program cannot be read: an I/O error, never "no `HEAD`",
/// which beside packs would mean a lost `HEAD`.
#[cfg(windows)]
#[test]
fn a_head_held_exclusively_is_unreadable_not_absent() {
    let library = Library::new();
    let store = library.store();
    let head = Batch::new(0).head();
    store.write_head(head).unwrap();
    let path = library.layout.head_file();
    let held = hold_exclusively(&path);
    let error = io_error_at(store.read_head(), &path);
    assert!(crate::fs::is_in_use(&error), "{error}");
    drop(held);
    assert_eq!(store.read_head().unwrap(), Some(head));
}

/// The store's folders held exclusively by another program cannot be listed: an I/O error, never
/// an empty listing, which would hide every pack.
#[cfg(windows)]
#[test]
fn folders_held_exclusively_are_unlisted_not_empty() {
    let library = Library::new();
    let store = library.store();
    let index = Batch::new(0).publish(&store);
    Batch::new(1).stage(&store).unwrap();
    for (folder, list) in [
        (
            library.layout.packs_dir(),
            Box::new(|| store.list_packs().map(drop)) as Box<dyn Fn() -> Result<(), StoreError>>,
        ),
        (
            library.layout.packs_dir(),
            Box::new(|| store.has_packs().map(drop)),
        ),
        (
            library.layout.staging_dir(),
            Box::new(|| store.clean_staging().map(drop)),
        ),
    ] {
        let held = hold_exclusively(&folder);
        let error = io_error_at(list(), &folder);
        assert!(crate::fs::is_in_use(&error), "{error}");
        drop(held);
    }
    assert_eq!(store.list_packs().unwrap().packs, [index.name()]);
    assert_eq!(store.clean_staging().unwrap(), 1);
}

#[test]
fn a_folder_at_a_store_path_is_refused() {
    let library = Library::new();
    let store = library.store();
    let batch = Batch::new(0);
    let staged = batch.stage(&store).unwrap();
    let target = store.pack_path(staged.name());
    fs::create_dir_all(&target).unwrap();
    assert_eq!(
        refused(store.publish(staged)),
        (
            Subject::Pack(target.clone()),
            found(FileKind::Folder, FileKind::File)
        )
    );
    assert!(target.is_dir());
    assert_eq!(
        refused(store.remove_pack(batch_pack_name(&target))),
        (
            Subject::Pack(target),
            found(FileKind::Folder, FileKind::File)
        )
    );

    // Files where the store keeps folders.
    let library = Library::new();
    let store = library.store();
    let local = library.layout.staging_dir().parent().unwrap().to_path_buf();
    fs::create_dir_all(&local).unwrap();
    fs::write(library.layout.packs_dir(), b"").unwrap();
    fs::write(library.layout.staging_dir(), b"").unwrap();
    let packs = Subject::Folder(library.layout.packs_dir());
    let staging = Subject::Folder(library.layout.staging_dir());
    let file = found(FileKind::File, FileKind::Folder);
    assert_eq!(refused(store.list_packs()), (packs.clone(), file.clone()));
    assert_eq!(refused(store.has_packs()), (packs, file.clone()));
    assert_eq!(
        refused(store.pack_writer()),
        (staging.clone(), file.clone())
    );
    assert_eq!(refused(store.clean_staging()), (staging, file));
}

/// The name of the pack whose path is `path`.
fn batch_pack_name(path: &Path) -> PackName {
    PackName::from_file_name(path.file_name().unwrap().to_str().unwrap()).unwrap()
}

#[test]
fn listing_reports_what_is_not_a_pack() {
    let library = Library::new();
    let store = library.store();
    assert_eq!(store.list_packs().unwrap(), PackListing::default());
    assert!(!store.has_packs().unwrap());

    let first = Batch::new(0).publish(&store);
    let second = Batch::new(1).publish(&store);
    let packs = library.layout.packs_dir();
    let other = "cd".repeat(32);
    let foreign: Vec<OsString> = vec![
        format!("{}.PACK", other.to_uppercase()).into(),
        format!("{other}.pack.part").into(),
        format!("{other} 2.pack").into(),
        "notes.txt".into(),
        "pack-0123456789abcdef.part".into(),
        not_unicode(),
    ];
    for name in &foreign {
        fs::write(packs.join(name), b"not a pack").unwrap();
    }
    // A folder with a pack's name is not a pack either.
    let folder: OsString = format!("{}.pack", "ef".repeat(32)).into();
    fs::create_dir(packs.join(&folder)).unwrap();

    let listing = store.list_packs().unwrap();
    let mut names = vec![first.name(), second.name()];
    names.sort();
    assert_eq!(listing.packs, names);
    let mut expected: Vec<OsString> = foreign.into_iter().chain([folder]).collect();
    expected.sort();
    assert_eq!(listing.foreign, expected);
    assert!(store.has_packs().unwrap());
    // Foreign entries are left alone.
    assert_eq!(MemoryIndex::of_store(&store).unwrap().len(), 8);
    assert_eq!(store.clean_staging().unwrap(), 0);
    assert_eq!(fs::read(packs.join("notes.txt")).unwrap(), b"not a pack");
}

/// A file whose name is a pack's in another case is foreign, though NTFS takes it for the pack's
/// name: listed as foreign, and neither trusted, replaced nor removed.
#[cfg(windows)]
#[test]
fn a_pack_name_in_another_case_is_foreign() {
    let library = Library::new();
    let store = library.store();
    let batch = Batch::new(0);
    let index = batch.publish(&store);
    let path = store.pack_path(index.name());
    let bytes = fs::read(&path).unwrap();
    let upper = OsString::from(index.name().file_name().to_uppercase());
    let renamed = library.layout.packs_dir().join(&upper);
    fs::rename(&path, &renamed).unwrap();
    assert_eq!(
        store.list_packs().unwrap(),
        PackListing {
            packs: Vec::new(),
            foreign: vec![upper.clone()]
        }
    );
    let staged = batch.stage(&store).unwrap();
    let staged_path = staged.path().to_path_buf();
    assert_eq!(
        refused(store.publish(staged)),
        (
            Subject::Pack(path.clone()),
            Problem::OtherCase {
                found: upper.clone()
            }
        )
    );
    assert!(staged_path.exists());
    assert!(!store.remove_pack(index.name()).unwrap());
    let names: Vec<OsString> = fs::read_dir(library.layout.packs_dir())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, [upper]);
    assert_eq!(fs::read(&renamed).unwrap(), bytes);
}

#[cfg(windows)]
#[test]
fn links_in_the_store_are_refused_and_never_followed() {
    let library = Library::new();
    let store = library.store();
    let outside = tempfile::tempdir().unwrap();
    let batch = Batch::new(0);
    let staged = batch.stage(&store).unwrap();
    let name = staged.name();
    let packs = library.layout.packs_dir();

    // A link in `packs/`, whatever its name.
    fs::create_dir_all(&packs).unwrap();
    let link = store.pack_path(name);
    junction(&link, outside.path());
    let pack_link = (
        Subject::Pack(link.clone()),
        found(FileKind::Link, FileKind::File),
    );
    assert_eq!(refused(store.list_packs()), pack_link);
    assert_eq!(refused(store.has_packs()), pack_link);
    assert_eq!(refused(store.remove_pack(name)), pack_link);
    let staged_path = staged.path().to_path_buf();
    assert_eq!(refused(store.publish(staged)), pack_link);
    assert!(staged_path.exists());
    fs::remove_dir(&link).unwrap();
    let foreign_link = packs.join("elsewhere");
    junction(&foreign_link, outside.path());
    assert_eq!(
        refused(store.list_packs()),
        (
            Subject::Pack(foreign_link.clone()),
            found(FileKind::Link, FileKind::File)
        )
    );
    fs::remove_dir(&foreign_link).unwrap();
    fs::remove_dir(&packs).unwrap();

    // `packs/` itself a link.
    junction(&packs, outside.path());
    let packs_link = (
        Subject::Folder(packs.clone()),
        found(FileKind::Link, FileKind::Folder),
    );
    assert_eq!(refused(store.list_packs()), packs_link);
    assert_eq!(refused(store.remove_pack(name)), packs_link);
    let staged = batch.stage(&store).unwrap();
    assert_eq!(refused(store.publish(staged)), packs_link);
    fs::remove_dir(&packs).unwrap();

    // `staging/` a link.
    let index = batch.publish(&store);
    store.clean_staging().unwrap();
    let staging = library.layout.staging_dir();
    fs::remove_dir(&staging).unwrap();
    fs::write(
        outside.path().join("pack-0123456789abcdef.part"),
        b"outside",
    )
    .unwrap();
    junction(&staging, outside.path());
    let staging_link = (
        Subject::Folder(staging.clone()),
        found(FileKind::Link, FileKind::Folder),
    );
    assert_eq!(refused(store.pack_writer()), staging_link);
    assert_eq!(refused(store.clean_staging()), staging_link);
    // A pack is removed through `staging/` too, never through the link.
    assert_eq!(refused(store.remove_pack(index.name())), staging_link);
    assert_eq!(store.list_packs().unwrap().packs, [index.name()]);
    // HEAD is written in `staging/` too, never through the link.
    assert_eq!(refused(store.write_head(batch.head())), staging_link);
    assert!(!library.layout.head_file().exists());
    fs::remove_dir(&staging).unwrap();

    // `HEAD` a link.
    let head = library.layout.head_file();
    junction(&head, outside.path());
    let head_link = (
        Subject::Head(head.clone()),
        found(FileKind::Link, FileKind::File),
    );
    assert_eq!(refused(store.read_head()), head_link);
    assert_eq!(refused(store.write_head(batch.head())), head_link);
    assert!(
        fs::symlink_metadata(&head)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    fs::remove_dir(&head).unwrap();

    // Nothing outside was touched.
    let outside_entries: Vec<_> = fs::read_dir(outside.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(outside_entries, ["pack-0123456789abcdef.part"]);
}

#[test]
fn removing_a_pack_deletes_it_and_its_objects_go_missing() {
    let library = Library::new();
    let store = library.store();
    let missing = PackName::from_bytes([1; 32]);
    assert!(!store.remove_pack(missing).unwrap());
    let batch = Batch::new(0);
    let index = batch.publish(&store);
    let located = MemoryIndex::of_store(&store).unwrap();
    assert!(!store.remove_pack(missing).unwrap());

    assert!(store.remove_pack(index.name()).unwrap());
    assert!(!store.has_packs().unwrap());
    assert!(library.staging_entries().is_empty());
    assert!(!store.remove_pack(index.name()).unwrap());
    let tree = batch.tree.id();
    assert!(matches!(
        store.read_tree(tree, located.get(tree).unwrap()),
        Err(StoreError::Missing(id)) if id == tree
    ));
    // Without `staging/`, removing a pack makes the folder it moves the pack into.
    let index = batch.publish(&store);
    fs::remove_dir(library.layout.staging_dir()).unwrap();
    assert!(store.remove_pack(index.name()).unwrap());
    assert!(library.layout.staging_dir().is_dir());
    assert!(library.staging_entries().is_empty());
    assert!(!store.has_packs().unwrap());
}

#[test]
fn cleaning_staging_removes_only_pack_files() {
    let library = Library::new();
    let store = library.store();
    assert_eq!(store.clean_staging().unwrap(), 0);
    let staging = library.layout.staging_dir();
    fs::create_dir_all(&staging).unwrap();
    let ours = ["pack-0123456789abcdef.part", "pack-fedcba9876543210.part"];
    // NTFS ignores case, so the upper-case name is another name than ours.
    let theirs = [
        "pack-0123456789abcde.part",
        "pack-ABCDEF0123456789.part",
        "pack-0123456789abcdef.part.tmp",
        "pack-0123456789abcdeg.part",
        "4242-0.part",
        "import-48ffdfb335860f2c15c8bccf2a90e720.part",
    ];
    for name in ours.iter().chain(&theirs) {
        fs::write(staging.join(name), b"x").unwrap();
    }
    fs::create_dir(staging.join("pack-00000000000000ff.part")).unwrap();

    assert_eq!(store.clean_staging().unwrap(), 2);
    let mut left: Vec<OsString> = theirs.iter().map(OsString::from).collect();
    left.push("pack-00000000000000ff.part".into());
    assert_eq!(library.staging_entries(), left.into_iter().collect());
    assert_eq!(store.clean_staging().unwrap(), 0);
}

/// Small limits, so that tests see every route without writing a gigabyte.
const SMALL: Limits = Limits {
    word_alone: 1000,
    max: 20_000,
};

#[test]
fn routes_follow_section_9_5_at_the_real_limits() {
    use Route::{Alone, NewShared, Shared};
    let route = |shared, raw, word| LIMITS.route(shared, raw, word);
    assert_eq!((WORD_PACK_MIN, PACK_MAX), (1 << 20, 1 << 30));
    // A Word blob of 1 MiB or more gets a pack of its own; a text blob does not.
    assert_eq!(route(None, WORD_PACK_MIN - 1, true), Shared);
    assert_eq!(route(None, WORD_PACK_MIN, true), Alone);
    assert_eq!(route(Some(1000), WORD_PACK_MIN, true), Alone);
    assert_eq!(route(Some(1000), WORD_PACK_MIN - 1, true), Shared);
    assert_eq!(route(None, WORD_PACK_MIN, false), Shared);
    // A shared pack stays under 1 GiB: an object that would reach it starts a new one.
    let size = 600 << 20;
    let room = PACK_MAX - size - record_cost(0) - 1;
    assert_eq!(size + record_cost(room), PACK_MAX - 1);
    assert_eq!(route(Some(size), room, false), Shared);
    assert_eq!(route(Some(size), room + 1, false), NewShared);
    // An object that no pack of others holds under 1 GiB is alone: a pack of it is 150 bytes more.
    let largest = PACK_MAX - MIN_PACK_LEN - 1;
    assert_eq!(route(None, largest, false), Shared);
    assert_eq!(route(Some(size), largest, false), NewShared);
    assert_eq!(route(None, largest + 1, false), Alone);
    assert_eq!(route(Some(size), largest + 1, false), Alone);
    assert_eq!(route(Some(size), Size::MAX.get(), false), Alone);
}

/// The objects of each staged pack, by pack, in the order the set finished them.
fn objects_of(staged: &[StagedPack]) -> Vec<BTreeSet<ObjectId>> {
    staged
        .iter()
        .map(|pack| {
            pack.index()
                .entries()
                .iter()
                .map(|entry| entry.id)
                .collect()
        })
        .collect()
}

#[test]
fn a_pack_set_routes_objects_as_section_9_5_says() {
    let library = Library::new();
    let store = library.store();
    let mut set = PackSet::new(&store, SMALL);
    let id = |bytes: &[u8]| ObjectId::of(BLOB, bytes);
    let blob = |len: usize| noise(len);

    // A Word blob under the limit shares; one at the limit is alone at once.
    let small_word = blob(999);
    let large_word = blob(1000);
    assert_eq!(
        set.add_blob(&small_word, BlobClass::Word).unwrap(),
        InSet::Written
    );
    assert_eq!(
        set.add_blob(&large_word, BlobClass::Word).unwrap(),
        InSet::Written
    );
    assert_eq!(objects_of(&set.staged), [BTreeSet::from([id(&large_word)])]);
    // The shared pack fills up to just under 20,000 bytes, then a new one starts.
    let fill: Vec<Vec<u8>> = (0..3).map(|i| blob(5000 + i)).collect();
    for bytes in &fill {
        assert_eq!(
            set.add_blob(bytes, BlobClass::Text).unwrap(),
            InSet::Written
        );
    }
    let shared = set.shared.as_ref().unwrap().size();
    let next = blob(20_000 - shared as usize - 90);
    assert_eq!(
        set.add_blob(&next, BlobClass::Text).unwrap(),
        InSet::Written
    );
    assert_eq!(set.staged.len(), 2, "a new shared pack started");
    // An object no shared pack holds under the limit is alone.
    let huge = blob(20_000 - 150);
    assert_eq!(
        set.add_blob(&huge, BlobClass::Text).unwrap(),
        InSet::Written
    );
    assert_eq!(set.staged.len(), 3);
    // Objects offered again, wherever they went, are written once.
    for bytes in [&small_word, &large_word, &fill[0], &huge] {
        assert_eq!(
            set.add_blob(bytes, BlobClass::Text).unwrap(),
            InSet::Duplicate
        );
        let size = Size::new(bytes.len() as u64).unwrap();
        assert!(matches!(
            set.add_blob_from(id(bytes), size, &bytes[..], BlobClass::Word)
                .unwrap(),
            Streamed::Added(InSet::Duplicate)
        ));
    }
    // A stream that is not the expected blob is not in the set, alone or shared.
    for (len, class) in [
        (1500, BlobClass::Word),
        (700, BlobClass::Word),
        (701, BlobClass::Text),
    ] {
        let expected = blob(len);
        let mut other = expected.clone();
        other[len / 2] ^= 1;
        let size = Size::new(len as u64).unwrap();
        let streamed = set
            .add_blob_from(id(&expected), size, &other[..], class)
            .unwrap();
        assert!(
            matches!(streamed, Streamed::Mismatch { .. }),
            "{streamed:?}"
        );
        assert!(!set.contains(id(&expected)));
        let streamed = set
            .add_blob_from(id(&expected), size, &expected[..], class)
            .unwrap();
        assert!(
            matches!(streamed, Streamed::Added(InSet::Written)),
            "{streamed:?}"
        );
    }
    let tree = tree_of(&fill[1], 2);
    assert_eq!(set.add_object(&tree, true).unwrap(), InSet::Written);
    assert_eq!(set.add_object(&tree, true).unwrap(), InSet::Duplicate);

    let staged = set.finish().unwrap();
    let packs = objects_of(&staged);
    assert_eq!(packs.len(), 5, "{packs:?}");
    assert_eq!(packs[0], BTreeSet::from([id(&large_word)]));
    assert_eq!(
        packs[1],
        BTreeSet::from([id(&small_word), id(&fill[0]), id(&fill[1]), id(&fill[2])])
    );
    assert_eq!(packs[2], BTreeSet::from([id(&huge)]));
    assert_eq!(packs[3], BTreeSet::from([id(&blob(1500))]));
    assert_eq!(
        packs[4],
        BTreeSet::from([id(&next), id(&blob(700)), id(&blob(701)), tree.id()])
    );
    for pack in &staged {
        let size = pack.index().size();
        assert!(
            size < SMALL.max || pack.index().object_count() == 1,
            "{size}"
        );
    }
    // Every file the set made and kept is a staged pack.
    let mut files: Vec<String> = staged
        .iter()
        .map(|pack| {
            pack.path()
                .file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .to_owned()
        })
        .collect();
    files.sort();
    assert_eq!(library.staged_files(), files);
    for pack in staged {
        store.publish(pack).unwrap();
    }
    let located = MemoryIndex::of_store(&store).unwrap();
    assert_eq!(located.len(), 11);
    for bytes in [
        &small_word,
        &large_word,
        &next,
        &huge,
        &blob(1500),
        &blob(701),
    ] {
        let mut read = Vec::new();
        store
            .open_blob(id(bytes), located.get(id(bytes)).unwrap())
            .unwrap()
            .read_to_end(&mut read)
            .unwrap();
        assert_eq!(&read, bytes);
    }
}

#[test]
fn a_word_version_of_1_mib_gets_a_pack_of_its_own() {
    let library = Library::new();
    let store = library.store();
    let mut set = store.pack_set();
    let word = noise(WORD_PACK_MIN as usize);
    let smaller = text(WORD_PACK_MIN as usize - 1);
    set.add_blob(&smaller, BlobClass::Word).unwrap();
    let size = Size::new(word.len() as u64).unwrap();
    let id = ObjectId::of(BLOB, &word);
    let streamed = set
        .add_blob_from(id, size, &word[..], BlobClass::Word)
        .unwrap();
    assert!(matches!(streamed, Streamed::Added(InSet::Written)));
    set.add_blob(&text(5000), BlobClass::Text).unwrap();
    let staged = set.finish().unwrap();
    assert_eq!(
        objects_of(&staged),
        [
            BTreeSet::from([id]),
            BTreeSet::from([
                ObjectId::of(BLOB, &smaller),
                ObjectId::of(BLOB, &text(5000))
            ]),
        ]
    );
    // Word versions are stored raw, text compressed.
    let mut reader = PackReader::open(staged[1].path()).unwrap();
    let mut kinds = BTreeMap::new();
    reader
        .verify_with(None, |record| {
            kinds.insert(record.raw_length, record.compressed);
        })
        .unwrap();
    assert_eq!(
        kinds,
        BTreeMap::from([(WORD_PACK_MIN - 1, false), (5000, true)])
    );
    assert_eq!(staged[0].index().size(), MIN_PACK_LEN + WORD_PACK_MIN);
}

#[test]
fn an_empty_set_has_no_packs() {
    let library = Library::new();
    let store = library.store();
    assert!(store.pack_set().finish().unwrap().is_empty());
    // A shared pack whose only object turned out not to match is not kept.
    let mut set = store.pack_set();
    let expected = text(100);
    let size = Size::new(100).unwrap();
    let streamed = set
        .add_blob_from(
            ObjectId::of(BLOB, &expected),
            size,
            &text(99)[..],
            BlobClass::Word,
        )
        .unwrap();
    assert!(matches!(streamed, Streamed::Mismatch { length: 99, .. }));
    assert!(set.finish().unwrap().is_empty());
    assert!(library.staging_entries().is_empty());
}

#[test]
fn a_memory_index_keeps_the_first_location_of_an_object() {
    let library = Library::new();
    let store = library.store();
    let first = Batch::new(0);
    let first_pack = first.publish(&store);
    // A second pack that holds the first one's tree too.
    let mut writer = store.pack_writer().unwrap();
    writer.add_object(&first.tree, false).unwrap();
    writer.add_blob(&text(10), true).unwrap();
    let second_pack = store.publish(writer.stage().unwrap()).unwrap().index;

    let mut index = MemoryIndex::new();
    assert!(index.is_empty());
    index.add_pack(&first_pack);
    index.add_pack(&second_pack);
    assert_eq!(index.len(), 5);
    assert_eq!(
        index.get(first.tree.id()),
        first_pack.location(first.tree.id())
    );
    let mut reversed = MemoryIndex::new();
    reversed.add_pack(&second_pack);
    reversed.add_pack(&first_pack);
    assert_eq!(
        reversed.get(first.tree.id()),
        second_pack.location(first.tree.id())
    );
    assert_eq!(
        index.locate(first.head()).unwrap(),
        first_pack.location(first.head())
    );
    assert_eq!(index.locate(Batch::new(1).head()).unwrap(), None);
    // Both locations hold the tree.
    for located in [&index, &reversed] {
        first.assert_readable(&store, located);
    }
}

#[test]
fn history_checks_read_trees_through_the_store() {
    let library = Library::new();
    let store = library.store();
    let (blobs, trees, commit) = first_commit();
    let mut set = store.pack_set();
    for blob in &blobs {
        set.add_blob(blob, BlobClass::Text).unwrap();
    }
    // The course's tree in a pack of its own, to take it away later.
    let mut course_pack = store.pack_writer().unwrap();
    course_pack.add_object(&trees[1], true).unwrap();
    let course_pack = store.publish(course_pack.stage().unwrap()).unwrap().index;
    for object in [&trees[0], &trees[2], &commit] {
        set.add_object(object, true).unwrap();
    }
    for pack in set.finish().unwrap() {
        store.publish(pack).unwrap();
    }
    let located = MemoryIndex::of_store(&store).unwrap();
    let source = store.trees(&located);
    let root = trees[2].id();
    let read = source.tree(root).unwrap().unwrap();
    assert_eq!(read.encode().unwrap(), trees[2]);
    assert!(source.tree(Batch::new(0).tree.id()).unwrap().is_none());
    assert_eq!(source.locator().len(), located.len());

    let parsed = Commit::parse(commit.bytes()).unwrap();
    let mut checker = HistoryChecker::new(store.trees(&located));
    checker.check_commit(commit.id(), &parsed, None).unwrap();

    // A tree whose pack is gone is missing.
    store.remove_pack(course_pack.name()).unwrap();
    assert!(source.tree(trees[1].id()).unwrap().is_none());
    let mut checker = HistoryChecker::new(store.trees(&located));
    assert!(matches!(
        checker.check_commit(commit.id(), &parsed, None),
        Err(StoreError::Missing(id)) if id == trees[1].id()
    ));
    // A locator that points at the wrong record is an error, not a missing tree.
    let mut wrong = MemoryIndex::new();
    let blob_pack = located.get(ObjectId::of(BLOB, &blobs[0])).unwrap();
    wrong.objects.insert(root, blob_pack);
    assert!(matches!(
        store.trees(&wrong).tree(root),
        Err(StoreError::Invalid { .. })
    ));
}

/// A locator that counts its lookups: one for each tree the store reads.
struct Lookups<'a> {
    index: &'a MemoryIndex,
    count: std::cell::Cell<usize>,
}

impl Locator for Lookups<'_> {
    fn locate(&self, id: ObjectId) -> Result<Option<Location>, StoreError> {
        self.count.set(self.count.get() + 1);
        self.index.locate(id)
    }
}

/// Folders that repeat each other's trees, in a pack of a few KB, cost a walk over the store a read
/// or two of each distinct tree, not one of each folder.
#[test]
fn walks_over_the_store_read_a_repeated_tree_twice_at_most() {
    let library = Library::new();
    let store = library.store();
    let folders = |below: ObjectId, prefix: &str| {
        let entries = (0..300)
            .map(|n| TreeEntry::dir(Name::parse(&format!("{prefix}{n:03}")).unwrap(), below))
            .collect();
        Tree::new(entries).unwrap().encode().unwrap()
    };
    let empty = Tree::default().encode().unwrap();
    let shared = folders(empty.id(), "e");
    let top = folders(shared.id(), "s");
    let mut writer = store.pack_writer().unwrap();
    for tree in [&empty, &shared, &top] {
        writer.add_object(tree, true).unwrap();
    }
    let index = store.publish(writer.stage().unwrap()).unwrap().index;
    assert!(index.size() < 8 * 1024, "{} bytes", index.size());
    let located = MemoryIndex::of_store(&store).unwrap();
    let lookups = Lookups {
        index: &located,
        count: std::cell::Cell::new(0),
    };
    let flat = flatten(&store.trees(&lookups), top.id(), 100_000).unwrap();
    assert_eq!(flat.len(), 300 + 300 * 300);
    // `top` once, `shared` and the empty tree twice each.
    assert_eq!(lookups.count.get(), 5);
}

#[test]
fn staging_a_pack_crashed_anywhere_leaves_a_whole_store() {
    let earlier = Batch::new(0);
    // A blob larger than the sink's buffer, so that crashes leave pack files written in part.
    let mut batch = Batch::new(1);
    batch.blobs.push(noise(150 * 1024));
    let uncrashed = batch
        .stage(&Library::new().store())
        .unwrap()
        .index()
        .clone();
    let mut partial = Vec::new();
    let steps = crash::each_point(|arm| {
        let library = Library::new();
        let store = library.store();
        earlier.publish(&store);
        store.write_head(earlier.head()).unwrap();
        match arm.run(|| batch.stage(&store)) {
            Ok(staged) => assert_eq!(staged.unwrap().index(), &uncrashed),
            Err(step) => {
                let left = library.staged_files();
                assert_eq!(left.len(), 1, "{step}");
                let path = library.layout.staging_dir().join(&left[0]);
                partial.push(fs::metadata(path).unwrap().len());
                assert_recovers(&library, &[Some(earlier.head())], &earlier, None);
                let again = batch.stage(&library.store()).unwrap();
                assert_eq!(again.index(), &uncrashed, "{step}");
            }
        }
    });
    assert_eq!(runs(&steps), ["pack.write", "pack.sync"]);
    assert_eq!(steps.len(), 17);
    // Each crash comes before its write: the file stays empty up to the large blob's bytes (the
    // 8th write: magic, version, then a header and the bytes of each object), which go past the
    // buffer, so from the next crash on it holds the pack up to the tree's record, never whole.
    let tree_at = uncrashed.offset(batch.tree.id()).unwrap();
    let expected: Vec<u64> = (1..=17).map(|n| if n <= 8 { 0 } else { tree_at }).collect();
    assert_eq!(partial, expected);
}

/// A streamed blob that does not match, once its bytes went past the sink's buffer to the file, is
/// cut away from the file itself (`set_len`): a crash at that cut comes before it, so the file still
/// holds the streamed bytes written out, and the store recovers from it as from any crash.
#[test]
fn a_cut_past_the_buffer_crashed_anywhere_leaves_the_bytes_before_it() {
    let earlier = Batch::new(0);
    let blob = noise(200 * 1024);
    let mut changed = blob.clone();
    changed[150_000] ^= 1;
    let (id, size) = (ObjectId::of(BLOB, &blob), Size::new(200 * 1024).unwrap());
    let stage = |store: &LocalStore| {
        let mut writer = store.pack_writer()?;
        writer.add_blob(&text(2_000), true)?;
        let streamed = writer.add_blob_from(id, size, &changed[..], false)?;
        assert!(
            matches!(streamed, Streamed::Mismatch { .. }),
            "{streamed:?}"
        );
        writer.add_blob_from(id, size, &blob[..], false)?;
        writer.stage()
    };
    let uncrashed = stage(&Library::new().store()).unwrap().index().clone();
    let mut left = Vec::new();
    let steps = crash::each_point(|arm| {
        let library = Library::new();
        let store = library.store();
        earlier.publish(&store);
        store.write_head(earlier.head()).unwrap();
        match arm.run(|| stage(&store)) {
            Ok(staged) => assert_eq!(staged.unwrap().index(), &uncrashed),
            Err(step) => {
                let files = library.staged_files();
                assert_eq!(files.len(), 1, "{step}");
                let path = library.layout.staging_dir().join(&files[0]);
                left.push((step, fs::metadata(path).unwrap().len()));
                assert_recovers(&library, &[Some(earlier.head())], &earlier, None);
                assert_eq!(
                    stage(&library.store()).unwrap().index(),
                    &uncrashed,
                    "{step}"
                );
            }
        }
    });
    assert_eq!(
        runs(&steps),
        ["pack.write", "pack.truncate", "pack.write", "pack.sync"]
    );
    // The blob that did not match starts where the right one does. At the cut, the file holds its
    // record's header and the three chunks of 64 KiB written past the buffer; the last 8 KiB were
    // still in the buffer, lost with it.
    let record = uncrashed.offset(id).unwrap();
    let at_cut: Vec<u64> = left
        .iter()
        .filter(|(step, _)| *step == "pack.truncate")
        .map(|&(_, len)| len)
        .collect();
    assert_eq!(at_cut, [record + 50 + 3 * 64 * 1024]);
}

#[test]
fn publishing_crashed_anywhere_leaves_a_whole_store() {
    let (earlier, batch) = (Batch::new(0), Batch::new(1));
    let uncrashed = batch.publish(&Library::new().store());
    let steps = crash::each_point(|arm| {
        let library = Library::new();
        let store = library.store();
        earlier.publish(&store);
        store.write_head(earlier.head()).unwrap();
        let staged = batch.stage(&store).unwrap();
        let file = staged
            .path()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        match arm.run(|| store.publish(staged)) {
            Ok(published) => assert_eq!(published.unwrap().how, Publication::New),
            Err(step) => {
                // Before the rename: the pack waits in `staging/`, and `packs/` lacks it.
                assert_eq!(library.staged_files(), [file], "{step}");
                let packs = library.store().list_packs().unwrap().packs;
                assert!(!packs.contains(&uncrashed.name()), "{step}");
                assert_recovers(&library, &[Some(earlier.head())], &earlier, None);
                assert_eq!(batch.publish(&library.store()), uncrashed, "{step}");
            }
        }
        let store = library.store();
        batch.assert_readable(&store, &MemoryIndex::of_store(&store).unwrap());
    });
    assert_eq!(steps, ["pack.publish"]);
}

#[test]
fn publishing_over_a_valid_pack_crashed_anywhere_leaves_it() {
    let batch = Batch::new(0);
    let steps = crash::each_point(|arm| {
        let library = Library::new();
        let store = library.store();
        let index = batch.publish(&store);
        store.write_head(batch.head()).unwrap();
        let staged = batch.stage(&store).unwrap();
        let file = staged
            .path()
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .to_owned();
        match arm.run(|| store.publish(staged)) {
            Ok(published) => assert_eq!(published.unwrap().how, Publication::Kept),
            Err(step) => {
                // Before the removal: the staged copy is still there.
                assert_eq!(library.staged_files(), [file], "{step}");
                assert_recovers(&library, &[Some(batch.head())], &batch, None);
            }
        }
        assert_eq!(library.store().verify_pack(index.name()).unwrap(), index);
    });
    assert_eq!(steps, ["pack.discard"]);
}

#[test]
fn replacing_a_damaged_pack_crashed_anywhere_leaves_the_damage_or_the_pack() {
    let (earlier, batch) = (Batch::new(0), Batch::new(1));
    let good = {
        let library = Library::new();
        let store = library.store();
        let index = batch.publish(&store);
        fs::read(store.pack_path(index.name())).unwrap()
    };
    for (label, bytes) in damaged(&good) {
        let steps = crash::each_point(|arm| {
            let library = Library::new();
            let store = library.store();
            earlier.publish(&store);
            store.write_head(earlier.head()).unwrap();
            let staged = batch.stage(&store).unwrap();
            let name = staged.name();
            fs::write(store.pack_path(name), &bytes).unwrap();
            match arm.run(|| store.publish(staged)) {
                Ok(published) => assert_eq!(published.unwrap().how, Publication::Replaced),
                Err(step) => {
                    let damage = Some((name, &bytes[..]));
                    assert_recovers(&library, &[Some(earlier.head())], &earlier, damage);
                    let again = library.store().publish(batch.stage(&store).unwrap());
                    assert_eq!(again.unwrap().how, Publication::Replaced, "{label} {step}");
                }
            }
            assert_eq!(fs::read(store.pack_path(name)).unwrap(), good, "{label}");
        });
        assert_eq!(steps, ["pack.replace"], "{label}");
    }
}

#[test]
fn replacing_head_crashed_anywhere_leaves_the_old_head_or_the_new_one() {
    let (earlier, later) = (Batch::new(0), Batch::new(1));
    for old in [None, Some(earlier.head())] {
        let steps = crash::each_point(|arm| {
            let library = Library::new();
            let store = library.store();
            earlier.publish(&store);
            later.publish(&store);
            if let Some(old) = old {
                store.write_head(old).unwrap();
            }
            match arm.run(|| store.write_head(later.head())) {
                Ok(written) => written.unwrap(),
                Err(step) => {
                    assert_recovers(&library, &[old], &earlier, None);
                    // The shared writer's temporary file is not a pack file; nothing else is left.
                    // It is empty before its write, and holds the new `HEAD` before the rename.
                    let left = library.staging_entries();
                    assert_eq!(left.len(), 1, "{step}");
                    let temp = library.layout.staging_dir().join(left.first().unwrap());
                    let len = fs::metadata(temp).unwrap().len();
                    assert_eq!(len, if step == "atomic.write" { 0 } else { 97 }, "{step}");
                    library.store().write_head(later.head()).unwrap();
                }
            }
            assert_eq!(library.store().read_head().unwrap(), Some(later.head()));
        });
        assert_eq!(steps, ["atomic.write", "atomic.rename"]);
    }
}

#[test]
fn removing_a_pack_crashed_anywhere_leaves_it_whole_or_gone() {
    let (earlier, batch) = (Batch::new(0), Batch::new(1));
    let steps = crash::each_point(|arm| {
        let library = Library::new();
        let store = library.store();
        earlier.publish(&store);
        let index = batch.publish(&store);
        let bytes = fs::read(store.pack_path(index.name())).unwrap();
        match arm.run(|| store.remove_pack(index.name())) {
            Ok(removed) => assert!(removed.unwrap()),
            Err(step) => {
                // Before the move the pack is in `packs/`; before the delete, out of it for good,
                // its bytes in `staging/`.
                let packs = library.store().list_packs().unwrap().packs;
                let staged = library.staged_files();
                if step == "pack.remove" {
                    assert!(packs.contains(&index.name()), "{step}");
                    assert!(staged.is_empty(), "{step}: {staged:?}");
                } else {
                    assert!(!packs.contains(&index.name()), "{step}");
                    assert_eq!(staged.len(), 1, "{step}");
                    let aside = library.layout.staging_dir().join(&staged[0]);
                    assert!(fs::read(aside).unwrap() == bytes, "{step}");
                }
                assert_recovers(&library, &[None], &earlier, None);
                library.store().remove_pack(index.name()).unwrap();
            }
        }
        let listing = library.store().list_packs().unwrap();
        assert!(!listing.packs.contains(&index.name()));
        assert_eq!(listing.packs.len(), 1);
    });
    assert_eq!(steps, ["pack.remove", "pack.delete"]);
}

#[test]
fn cleaning_staging_crashed_anywhere_cleans_on_the_next_try() {
    let steps = crash::each_point(|arm| {
        let library = Library::new();
        let store = library.store();
        for _ in 0..3 {
            let mut writer = store.pack_writer().unwrap();
            writer.add_blob(&text(10), true).unwrap();
            drop(writer.stage().unwrap());
        }
        fs::write(library.layout.staging_dir().join("4242-0.part"), b"").unwrap();
        match arm.run(|| store.clean_staging()) {
            Ok(removed) => assert_eq!(removed.unwrap(), 3),
            Err(step) => {
                // Each crash comes before its removal: the n-th leaves the files from the n-th on.
                assert_eq!(library.staged_files().len(), 4 - arm.n(), "{step}");
                library.store().clean_staging().unwrap();
            }
        }
        assert_eq!(
            library.staging_entries(),
            BTreeSet::from([OsString::from("4242-0.part")])
        );
    });
    assert_eq!(steps, ["staging.clean"; 3]);
}

#[test]
fn abandoning_crashed_anywhere_leaves_what_clean_staging_removes() {
    let batch = Batch::new(0);
    let steps = crash::each_point(|arm| {
        let library = Library::new();
        let store = library.store();
        let staged = batch.stage(&store).unwrap();
        if arm.run(|| staged.abandon()).is_err() {
            assert_eq!(library.store().clean_staging().unwrap(), 1);
        }
        assert!(library.staging_entries().is_empty());
    });
    assert_eq!(steps, ["pack.abandon"]);
}

/// Whether `noted` is a pack file's writes and cuts, at least one write, then its flush.
fn flushed_after_its_writes(noted: &[&str]) -> bool {
    match noted.split_last() {
        Some((&"sync", before)) => {
            before.contains(&"write")
                && before
                    .iter()
                    .all(|&effect| matches!(effect, "write" | "cut"))
        }
        _ => false,
    }
}

/// What a power loss must not undo is on the disk when its step returns (versioning.md §4.2–§4.3),
/// which tests see through `crash::note`: a staged pack is flushed after its last write and cut;
/// publishing renames it into `packs/` written through to the disk, also over a damaged pack;
/// `HEAD`'s new content is written, flushed and renamed over it written through; a pack leaves
/// `packs/` by a rename written through.
#[test]
fn what_a_power_loss_must_not_undo_is_on_the_disk() {
    let library = Library::new();
    let store = library.store();
    let (earlier, batch) = (Batch::new(0), Batch::new(1));
    let (staged, noted) = crash::noting(|| earlier.stage(&store));
    assert_eq!(noted, ["write", "sync"]);
    // Past the sink's buffer, with a stream that did not match cut away: written in several
    // writes, and flushed after all of them.
    let (large, noted) = crash::noting(|| {
        let blob = noise(200 * 1024);
        let mut changed = blob.clone();
        changed[100_000] ^= 1;
        let (id, size) = (ObjectId::of(BLOB, &blob), Size::new(200 * 1024).unwrap());
        let mut writer = store.pack_writer()?;
        writer.add_blob(&text(2_000), true)?;
        writer.add_blob_from(id, size, &changed[..], false)?;
        writer.add_blob_from(id, size, &blob[..], false)?;
        writer.stage()
    });
    large.unwrap().abandon().unwrap();
    assert!(noted.contains(&"cut"), "{noted:?}");
    assert!(flushed_after_its_writes(&noted), "{noted:?}");
    let (published, noted) = crash::noting(|| store.publish(staged.unwrap()));
    let published = published.unwrap();
    assert_eq!(published.how, Publication::New);
    assert_eq!(noted, ["rename.durable"]);
    let staged = batch.stage(&store).unwrap();
    fs::write(store.pack_path(staged.name()), b"damaged").unwrap();
    let (replaced, noted) = crash::noting(|| store.publish(staged));
    assert_eq!(replaced.unwrap().how, Publication::Replaced);
    assert_eq!(noted, ["rename.durable.replace"]);
    let (written, noted) = crash::noting(|| store.write_head(batch.head()));
    written.unwrap();
    assert_eq!(noted, ["write", "sync", "rename.durable.replace"]);
    let (removed, noted) = crash::noting(|| store.remove_pack(published.index.name()));
    assert!(removed.unwrap());
    assert_eq!(noted, ["rename.durable"]);
}

/// A whole write as the history lane does it: objects into a pack set (some streamed, one that
/// turns out to have changed), the packs published, `HEAD` replaced.
fn write_commit(store: &LocalStore, batch: &Batch, word: &[u8]) -> Result<(), StoreError> {
    let mut set = PackSet::new(store, SMALL);
    for blob in &batch.blobs {
        set.add_blob(blob, BlobClass::Text)?;
    }
    let size = Size::new(word.len() as u64).unwrap();
    let id = ObjectId::of(BLOB, word);
    let mut changed = word.to_vec();
    changed[0] ^= 1;
    // A Word file saved while it was read: cut away, then read again.
    let streamed = set.add_blob_from(id, size, Cursor::new(changed), BlobClass::Word)?;
    assert!(matches!(streamed, Streamed::Mismatch { .. }));
    let streamed = set.add_blob_from(id, size, word, BlobClass::Word)?;
    assert!(matches!(streamed, Streamed::Added(InSet::Written)));
    set.add_blob(&noise(1200), BlobClass::Word)?;
    set.add_object(&batch.tree, true)?;
    set.add_object(&batch.commit, true)?;
    for pack in set.finish()? {
        store.publish(pack)?;
    }
    store.write_head(batch.head())
}

#[test]
fn a_whole_write_crashed_anywhere_leaves_the_old_head_or_the_new_one() {
    let (earlier, batch) = (Batch::new(0), Batch::new(1));
    let word = noise(800);
    let uncrashed = {
        let library = Library::new();
        write_commit(&library.store(), &batch, &word).unwrap();
        library.store().list_packs().unwrap().packs
    };
    assert_eq!(uncrashed.len(), 2);
    let steps = crash::each_point(|arm| {
        let library = Library::new();
        let store = library.store();
        let earlier_pack = earlier.publish(&store);
        store.write_head(earlier.head()).unwrap();
        let (old, new) = (Some(earlier.head()), Some(batch.head()));
        let head = match arm.run(|| write_commit(&store, &batch, &word)) {
            Ok(written) => {
                written.unwrap();
                new
            }
            Err(step) => {
                assert_recovers(&library, &[old, new], &earlier, None);
                let head = library.store().read_head().unwrap();
                if head == old {
                    // Before the commit point: write it again.
                    write_commit(&library.store(), &batch, &word).unwrap();
                }
                assert!(library.staged_files().is_empty(), "{step}");
                head
            }
        };
        let store = library.store();
        let located = MemoryIndex::of_store(&store).unwrap();
        if head == new {
            batch.assert_readable(&store, &located);
        }
        let mut packs = uncrashed.clone();
        packs.push(earlier_pack.name());
        packs.sort();
        assert_eq!(store.list_packs().unwrap().packs, packs);
        assert_eq!(store.read_head().unwrap(), new);
    });
    assert_eq!(
        runs(&steps),
        [
            "pack.write",
            "pack.truncate",
            "pack.write",
            "pack.sync",
            "pack.write",
            "pack.sync",
            "pack.publish",
            "atomic.write",
            "atomic.rename",
        ]
    );
}

proptest! {
    #![proptest_config(ProptestConfig {
        cases: 24,
        ..ProptestConfig::default()
    })]

    /// Whatever is offered, each object is in one pack of the set, a Word blob of the limit or
    /// more alone, every pack under the limit unless it holds one object, and every pack reads
    /// back whole.
    #[test]
    fn pack_sets_keep_section_9_5(
        offers in prop::collection::vec((0usize..2600, any::<bool>(), 0u8..5), 1..24),
    ) {
        let library = Library::new();
        let store = library.store();
        let mut set = PackSet::new(&store, Limits { word_alone: 1200, max: 6000 });
        let mut kept = BTreeMap::new();
        for (len, word, how) in offers {
            let bytes = noise(len);
            let id = ObjectId::of(BLOB, &bytes);
            let class = if word { BlobClass::Word } else { BlobClass::Text };
            let size = Size::new(len as u64).unwrap();
            let added = match how {
                0 => set.add_blob(&bytes, class).unwrap() == InSet::Written,
                1 => matches!(
                    set.add_blob_from(id, size, &bytes[..], class).unwrap(),
                    Streamed::Added(InSet::Written)
                ),
                // A stream that ends early is never added.
                2 if len > 0 => {
                    let streamed = set.add_blob_from(id, size, &bytes[..len - 1], class).unwrap();
                    let expected = if kept.contains_key(&id) {
                        matches!(streamed, Streamed::Added(InSet::Duplicate))
                    } else {
                        matches!(streamed, Streamed::Mismatch { .. })
                    };
                    prop_assert!(expected, "{:?}", streamed);
                    false
                }
                // So is one that gives the blob whole while its size says a byte more: refused for
                // its length, as the bytes are the blob.
                3 => {
                    let more = Size::new(len as u64 + 1).unwrap();
                    let streamed = set.add_blob_from(id, more, &bytes[..], class).unwrap();
                    let expected = if kept.contains_key(&id) {
                        matches!(streamed, Streamed::Added(InSet::Duplicate))
                    } else {
                        matches!(
                            streamed,
                            Streamed::Mismatch { found, length } if found == id && length == len as u64
                        )
                    };
                    prop_assert!(expected, "{:?}", streamed);
                    false
                }
                _ => {
                    let tree = tree_of(&bytes, 1 + len % 3);
                    let written = set.add_object(&tree, true).unwrap() == InSet::Written;
                    if written {
                        kept.insert(tree.id(), (false, tree.bytes().len()));
                    }
                    continue;
                }
            };
            if added {
                prop_assert!(kept.insert(id, (word, len)).is_none());
            }
        }
        let staged = set.finish().unwrap();
        let mut seen = BTreeSet::new();
        for pack in &staged {
            let index = PackReader::open(pack.path()).unwrap().verify(Some(pack.name())).unwrap();
            prop_assert_eq!(&index, pack.index());
            let count = index.object_count();
            prop_assert!(index.size() < 6000 || count == 1, "{} bytes, {} objects", index.size(), count);
            for entry in index.entries() {
                prop_assert!(seen.insert(entry.id), "{} in two packs", entry.id);
                let (word, len) = kept[&entry.id];
                if word && len >= 1200 {
                    prop_assert_eq!(count, 1);
                }
            }
        }
        prop_assert_eq!(seen, kept.keys().copied().collect::<BTreeSet<_>>());
        let mut files: Vec<String> = staged
            .iter()
            .map(|pack| pack.path().file_name().unwrap().to_str().unwrap().to_owned())
            .collect();
        files.sort();
        prop_assert_eq!(library.staged_files(), files);
    }
}
