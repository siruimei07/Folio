use std::collections::BTreeMap;
use std::io::{Cursor, Seek};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use rusqlite::OptionalExtension;
use tempfile::TempDir;
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

use super::*;
use crate::catalog::{MAX_BODY_BYTES, entry, record_extract, search};
use crate::extract::testing::{Package, paragraph, set_encrypted};
use crate::fs::{DirEntry, FileSystem, Metadata, Presence, ReadSeek};
use crate::meta::{DisplayName, LibraryConfig};
use crate::search::SearchQuery;
use crate::test_support::{MemFs, open_catalog, path};

/// Search time, in seconds since the Unix epoch.
const NOW: i64 = 1_800_000_000;

/// What opening a file does besides opening it.
#[derive(Clone)]
enum OnOpen {
    /// Fails, as for a file the user may not read.
    Fail,
    /// Opens, and then fails reading after this many bytes, as a file another program locks
    /// part of, or on a share that drops.
    FailAfter(usize),
    /// Fails the test: the file must not be opened.
    Panic,
    /// Sets the flag, as a user who cancels while the file is read.
    Cancel(Arc<AtomicBool>),
}

/// A [`MemFs`] whose files can be made to fail opening or reading, to fail the test when opened,
/// or to cancel the pass, and back; it counts the bytes read of each file.
struct Gate {
    fs: Arc<MemFs>,
    root: PathBuf,
    on_open: Mutex<BTreeMap<String, OnOpen>>,
    read: Mutex<BTreeMap<String, usize>>,
}

impl Gate {
    fn set(&self, at: &str, on_open: Option<OnOpen>) {
        let mut rules = self.on_open.lock().unwrap();
        match on_open {
            Some(on_open) => rules.insert(at.to_owned(), on_open),
            None => rules.remove(at),
        };
    }

    /// The bytes read of the file at `at` since the gate was made.
    fn bytes_read(&self, at: &str) -> usize {
        self.read.lock().unwrap().get(at).copied().unwrap_or(0)
    }

    /// Opens the file at `path` as its rule says, with `open`.
    fn watched<'a, R: Read>(
        &'a self,
        path: &Path,
        open: impl FnOnce() -> io::Result<R>,
    ) -> io::Result<Watched<'a, R>> {
        let at = path
            .strip_prefix(&self.root)
            .unwrap()
            .components()
            .map(|name| name.as_os_str().to_str().unwrap())
            .collect::<Vec<_>>()
            .join("/");
        let on_open = self.on_open.lock().unwrap().get(&at).cloned();
        let fail_after = match on_open {
            Some(OnOpen::Fail) => return Err(io::ErrorKind::PermissionDenied.into()),
            Some(OnOpen::FailAfter(bytes)) => Some(bytes),
            Some(OnOpen::Panic) => panic!("{at} was opened"),
            Some(OnOpen::Cancel(cancel)) => {
                cancel.store(true, Ordering::Relaxed);
                None
            }
            None => None,
        };
        Ok(Watched {
            inner: open()?,
            gate: self,
            at,
            fail_after,
        })
    }
}

/// A file opened through a [`Gate`].
struct Watched<'a, R> {
    inner: R,
    gate: &'a Gate,
    at: String,
    /// The bytes still to read before reading fails, if it does.
    fail_after: Option<usize>,
}

impl<R: Read> Read for Watched<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let room = match self.fail_after {
            Some(0) => {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "another program locked part of the file",
                ));
            }
            Some(left) => buf.len().min(left),
            None => buf.len(),
        };
        let read = self.inner.read(&mut buf[..room])?;
        if let Some(left) = &mut self.fail_after {
            *left -= read;
        }
        let mut counts = self.gate.read.lock().unwrap();
        *counts.entry(self.at.clone()).or_default() += read;
        Ok(read)
    }
}

impl<R: Seek> Seek for Watched<'_, R> {
    fn seek(&mut self, to: io::SeekFrom) -> io::Result<u64> {
        self.inner.seek(to)
    }
}

impl FileSystem for Gate {
    fn read_dir(&self, folder: &Path) -> io::Result<Vec<DirEntry>> {
        self.fs.read_dir(folder)
    }

    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        self.fs.metadata(path)
    }

    fn open(&self, path: &Path) -> io::Result<Box<dyn Read + '_>> {
        Ok(Box::new(self.watched(path, || self.fs.open(path))?))
    }

    /// The file in memory, as the default does, but read through the rule once it is open.
    fn open_seekable(&self, path: &Path) -> io::Result<Box<dyn ReadSeek + '_>> {
        let file = self.watched(path, || {
            let mut bytes = Vec::new();
            self.fs.open(path)?.read_to_end(&mut bytes)?;
            Ok(Cursor::new(bytes))
        })?;
        Ok(Box::new(file))
    }
}

/// A library on a [`Gate`] over a [`MemFs`], and its catalog.
struct Fixture {
    _dir: TempDir,
    fs: Arc<MemFs>,
    gate: Arc<Gate>,
    library: Library,
    catalog: Catalog,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("资料库");
        let fs = MemFs::new(&root);
        let gate = Arc::new(Gate {
            fs: fs.clone(),
            root: root.clone(),
            on_open: Mutex::default(),
            read: Mutex::default(),
        });
        let library = Library::new(&root, gate.clone());
        let config = LibraryConfig::new(DisplayName::parse("资料").unwrap()).unwrap();
        library.layout().write_library(&config).unwrap();
        let catalog = open_catalog(dir.path());
        Self {
            _dir: dir,
            fs,
            gate,
            library,
            catalog,
        }
    }

    fn scan(&self) {
        self.library
            .scan(&self.catalog, None, self.fs.now_ns())
            .unwrap();
    }

    /// Hashes everything, however recently it changed.
    fn hash(&self) {
        let later = self.fs.now_ns() + 10_000_000_000;
        let report = self
            .library
            .hash_pending(
                &self.catalog,
                later,
                &AtomicBool::new(false),
                &mut |_, _| {},
            )
            .unwrap();
        assert!(report.problems.is_empty(), "{report:?}");
    }

    fn scan_and_hash(&self) {
        self.scan();
        self.hash();
    }

    fn extract(&self) -> ExtractReport {
        self.library
            .extract_pending(&self.catalog, &AtomicBool::new(false), &mut |_, _| {})
            .unwrap()
    }

    /// A pass as `extract_pending` runs it, which `cancel` cancels.
    fn pass<'a>(&'a self, cancel: &'a AtomicBool) -> Pass<'a> {
        Pass {
            catalog: &self.catalog,
            cancel,
            time_limit: extract::TIME_LIMIT,
            write_every: WRITE_EVERY,
            write_bytes: WRITE_BYTES,
        }
    }

    /// Runs `pass`, stopping where `should_yield` says; returns the report and the writes that
    /// changed the catalog.
    fn extract_with(
        &self,
        pass: &Pass<'_>,
        should_yield: &mut dyn FnMut() -> bool,
    ) -> (ExtractReport, usize) {
        let mut commits = 0;
        let report = self
            .library
            .extract(pass, should_yield, &mut |_, _| {}, &mut || commits += 1)
            .unwrap();
        (report, commits)
    }

    /// The paths search finds for `words`, sorted.
    fn found(&self, words: &str) -> Vec<String> {
        let query = SearchQuery::parse(words).unwrap().unwrap();
        let hits = self.catalog.read(|tx| search(tx, &query, 20, NOW)).unwrap();
        let mut paths: Vec<String> = hits
            .into_iter()
            .map(|hit| hit.entry.record.path.to_string())
            .collect();
        paths.sort();
        paths
    }

    fn entry(&self, at: &str) -> Entry {
        self.catalog
            .read(|tx| entry(tx, &path(at)))
            .unwrap()
            .unwrap_or_else(|| panic!("no entry at {at}"))
    }

    /// The search body of the entry at `at`.
    fn body(&self, at: &str) -> Option<String> {
        let id = self.entry(at).id;
        self.catalog
            .read(|tx| {
                Ok(
                    tx.query_row("SELECT body FROM search WHERE rowid = ?1", [id.0], |row| {
                        row.get(0)
                    })?,
                )
            })
            .unwrap()
    }

    /// The status and failure the entry at `at` has in `extracts`, if it has a row.
    fn outcome(&self, at: &str) -> Option<(String, Option<String>)> {
        let id = self.entry(at).id;
        self.catalog
            .read(|tx| {
                Ok(tx
                    .query_row(
                        "SELECT status, failure FROM extracts WHERE entry_id = ?1",
                        [id.0],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?)
            })
            .unwrap()
    }

    fn pending(&self) -> u64 {
        self.catalog
            .read(|tx| count_pending_extracts(tx, extract::VERSION))
            .unwrap()
    }
}

fn outcome(status: &str, failure: Option<&str>) -> Option<(String, Option<String>)> {
    Some((status.to_owned(), failure.map(str::to_owned)))
}

/// A Word document of these paragraphs.
fn docx(paragraphs: &[&str]) -> Vec<u8> {
    let body: String = paragraphs.iter().map(|text| paragraph(text)).collect();
    Package::docx(&body).build()
}

/// A ZIP archive of `count` empty entries.
fn entries_zip(count: usize) -> Vec<u8> {
    let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Stored);
    for index in 0..count {
        zip.start_file(index.to_string(), options).unwrap();
    }
    zip.finish().unwrap().into_inner()
}

/// The path and failure of each problem, by path.
fn problems(report: &ExtractReport) -> Vec<(String, ReadFailure)> {
    let mut problems: Vec<_> = report
        .problems
        .iter()
        .map(|problem| match problem {
            Problem::Unreadable { path, failure, .. } => (path.to_string(), *failure),
            other => panic!("not an extraction problem: {other:?}"),
        })
        .collect();
    problems.sort_by(|a, b| a.0.cmp(&b.0));
    problems
}

fn complete(extracted: u64) -> ExtractReport {
    ExtractReport {
        extracted,
        complete: true,
        ..ExtractReport::default()
    }
}

#[test]
fn text_and_word_bodies_are_found_by_search() {
    let f = Fixture::new();
    f.fs.file(
        "线代/笔记.md",
        "# 特征值\n\neigenvalue decomposition".as_bytes(),
    );
    f.fs.file("信号/作业.docx", &docx(&["傅里叶变换", "Fourier homework"]));
    f.scan_and_hash();
    let mut progress = Vec::new();
    let mut commits = 0;
    let cancel = AtomicBool::new(false);
    // No write for the time passed, so both files go in one however slowly the test runs.
    let pass = Pass {
        write_every: Duration::MAX,
        ..f.pass(&cancel)
    };
    let report = f
        .library
        .extract(
            &pass,
            &mut || false,
            &mut |done, total| progress.push((done, total)),
            &mut || commits += 1,
        )
        .unwrap();
    assert_eq!(report, complete(2));
    assert_eq!(progress, [(1, 2), (2, 2)]);
    assert_eq!(commits, 1);
    assert_eq!(f.found("eigenvalue"), ["线代/笔记.md"]);
    assert_eq!(f.found("特征值"), ["线代/笔记.md"]);
    assert_eq!(f.found("傅里叶"), ["信号/作业.docx"]);
    assert_eq!(f.found("homework"), ["信号/作业.docx"]);
    assert_eq!(
        f.body("信号/作业.docx").as_deref(),
        Some("傅里叶变换\n\nFourier homework")
    );
    assert_eq!(f.outcome("线代/笔记.md"), outcome("text", None));
    assert_eq!(f.outcome("信号/作业.docx"), outcome("text", None));

    // Nothing is pending any more: the next pass opens nothing and has nothing to count.
    f.gate.set("线代/笔记.md", Some(OnOpen::Panic));
    f.gate.set("信号/作业.docx", Some(OnOpen::Panic));
    let mut counted = false;
    let report = f
        .library
        .extract_pending(&f.catalog, &AtomicBool::new(false), &mut |_, _| {
            counted = true;
        })
        .unwrap();
    assert_eq!(report, complete(0));
    assert!(!counted);
}

#[test]
fn an_edited_file_keeps_its_body_until_its_new_content_is_extracted() {
    let f = Fixture::new();
    f.fs.file("a.md", b"first draft");
    f.scan_and_hash();
    assert_eq!(f.extract(), complete(1));
    f.fs.file("a.md", b"second version");
    f.scan();
    // Waiting for its hash, the file is not pending, and search still finds the old text.
    assert_eq!(f.pending(), 0);
    assert_eq!(f.found("draft"), ["a.md"]);
    f.hash();
    assert_eq!(f.pending(), 1);
    assert_eq!(f.extract(), complete(1));
    assert!(f.found("draft").is_empty());
    assert_eq!(f.found("second"), ["a.md"]);
    assert_eq!(f.extract(), complete(0));
}

#[test]
fn outcomes_of_an_older_extractor_are_extracted_again() {
    let f = Fixture::new();
    f.fs.file("a.md", b"lecture notes");
    f.scan_and_hash();
    f.extract();
    let file = f.entry("a.md");
    let older = extract::VERSION - 1;
    f.catalog
        .write(|tx| record_extract(tx, &file, older, &ExtractState::Empty))
        .unwrap();
    assert!(f.found("lecture").is_empty());
    assert_eq!(f.pending(), 1);
    assert_eq!(f.extract(), complete(1));
    assert_eq!(f.found("lecture"), ["a.md"]);
}

#[test]
fn a_file_that_changes_class_is_extracted_as_its_new_class_or_loses_its_body() {
    let f = Fixture::new();
    f.fs.file("notes.md", b"orthogonal matrices");
    f.fs.file("report.docx", &docx(&["frequency response"]));
    f.scan_and_hash();
    f.extract();
    // Moves keep entries and their hashes; the extensions decide the classes.
    f.fs.rename("notes.md", "notes.pdf");
    f.fs.rename("report.docx", "report.txt");
    f.scan();
    assert_eq!(f.entry("notes.pdf").record.class, FileClass::Other);
    // The scan's change of class took the row and the body with it.
    assert_eq!(f.outcome("notes.pdf"), None);
    assert!(f.found("orthogonal").is_empty());
    let mut commits = 0;
    let report = f
        .library
        .extract_pending_with_commits(
            &f.catalog,
            &AtomicBool::new(false),
            &mut || false,
            &mut |_, _| {},
            &mut || commits += 1,
        )
        .unwrap();
    // The document, read as text now, comes in one write.
    assert_eq!(report, complete(1));
    assert_eq!(commits, 1);
    assert_eq!(f.outcome("notes.pdf"), None);
    assert_eq!(f.body("notes.pdf"), None);
    assert!(f.found("orthogonal").is_empty());
    // A ZIP read as text has NUL bytes near its start.
    assert_eq!(f.outcome("report.txt"), outcome("binary", None));
    assert!(f.found("frequency").is_empty());
}

#[test]
fn placeholders_empty_files_and_generated_files_are_never_opened() {
    let f = Fixture::new();
    let files = [
        ("cloud.md", b"cumulus".to_vec()),
        ("cloud.docx", docx(&["cumulus"])),
        ("empty.md", Vec::new()),
        ("empty.docx", Vec::new()),
        ("package-lock.json", b"{}".to_vec()),
        ("vendor/jquery.min.js", b"!function(){}".to_vec()),
    ];
    for (at, bytes) in &files {
        f.fs.file(at, bytes);
    }
    f.scan_and_hash();
    for (at, _) in &files {
        f.gate.set(at, Some(OnOpen::Panic));
    }
    f.fs.set_presence("cloud.md", Presence::Placeholder);
    f.fs.set_presence("cloud.docx", Presence::Offline);
    let report = f.extract();
    assert_eq!(
        report,
        ExtractReport {
            extracted: 4,
            not_local: 2,
            complete: true,
            ..ExtractReport::default()
        }
    );
    assert_eq!(f.outcome("empty.md"), outcome("empty", None));
    assert_eq!(f.outcome("empty.docx"), outcome("empty", None));
    assert_eq!(f.outcome("package-lock.json"), outcome("skipped", None));
    assert_eq!(f.outcome("vendor/jquery.min.js"), outcome("skipped", None));
    assert_eq!(f.outcome("cloud.md"), None);
    assert_eq!(f.pending(), 2);

    // Downloaded, a placeholder is read like any file.
    f.fs.set_presence("cloud.md", Presence::Local);
    f.gate.set("cloud.md", None);
    let report = f.extract();
    assert_eq!((report.extracted, report.not_local), (1, 1));
    assert_eq!(f.found("cumulus"), ["cloud.md"]);
}

#[test]
fn files_without_text_have_no_body_and_are_no_problem() {
    let f = Fixture::new();
    f.fs.file("blank.md", b" \r\n\t\n");
    f.fs.file("image.md", b"\x89PNG\r\n\x1a\n\0\0\0\rIHDR");
    f.fs.file("cover.docx", &docx(&[]));
    f.scan_and_hash();
    assert_eq!(f.extract(), complete(3));
    assert_eq!(f.outcome("blank.md"), outcome("empty", None));
    assert_eq!(f.outcome("image.md"), outcome("binary", None));
    assert_eq!(f.outcome("cover.docx"), outcome("empty", None));
    for at in ["blank.md", "image.md", "cover.docx"] {
        assert_eq!(f.body(at), None, "{at}");
    }
}

#[test]
fn a_file_that_changes_while_it_is_read_or_goes_is_passed_over() {
    let f = Fixture::new();
    f.fs.file("moving.md", b"draft");
    f.fs.file("moving.docx", &docx(&["draft"]));
    f.fs.file("gone.md", b"gone");
    f.scan_and_hash();
    f.fs.change_while_read("moving.md");
    f.fs.change_while_read("moving.docx");
    f.fs.remove("gone.md");
    assert_eq!(f.extract(), complete(0));
    for at in ["moving.md", "moving.docx", "gone.md"] {
        assert_eq!(f.outcome(at), None, "{at}");
    }
    assert_eq!(f.pending(), 3);
}

#[test]
fn a_file_that_cannot_be_read_is_a_problem_until_it_can() {
    let f = Fixture::new();
    f.fs.file("locked.md", b"exam answers");
    f.fs.file("locked.docx", &docx(&["exam answers"]));
    f.scan_and_hash();
    f.gate.set("locked.md", Some(OnOpen::Fail));
    f.gate.set("locked.docx", Some(OnOpen::Fail));
    // Not recorded, so tried again by every pass.
    for _ in 0..2 {
        let report = f.extract();
        assert_eq!(
            problems(&report),
            [
                ("locked.docx".to_owned(), ReadFailure::Denied),
                ("locked.md".to_owned(), ReadFailure::Denied)
            ]
        );
        assert_eq!((report.extracted, report.complete), (0, true));
        assert_eq!(f.outcome("locked.md"), None);
        assert_eq!(f.pending(), 2);
    }
    f.gate.set("locked.md", None);
    f.gate.set("locked.docx", None);
    assert_eq!(f.extract(), complete(2));
    assert_eq!(f.found("answers"), ["locked.docx", "locked.md"]);
}

#[test]
fn a_file_whose_reading_fails_is_a_problem_until_it_does_not() {
    let f = Fixture::new();
    f.fs.file("locked.md", "exam answers, ".repeat(100).as_bytes());
    f.fs.file("locked.docx", &docx(&["exam answers"]));
    f.scan_and_hash();
    // Open, then failing after the first bytes: a text file's start, a document's end.
    f.gate.set("locked.md", Some(OnOpen::FailAfter(64)));
    f.gate.set("locked.docx", Some(OnOpen::FailAfter(64)));
    // Not recorded, so tried again by every pass.
    for _ in 0..2 {
        let report = f.extract();
        assert_eq!(
            problems(&report),
            [
                ("locked.docx".to_owned(), ReadFailure::Denied),
                ("locked.md".to_owned(), ReadFailure::Denied)
            ]
        );
        assert_eq!((report.extracted, report.complete), (0, true));
        for at in ["locked.md", "locked.docx"] {
            assert_eq!(f.outcome(at), None, "{at}");
            assert_eq!(f.body(at), None, "{at}");
        }
        assert_eq!(f.pending(), 2);
    }
    f.gate.set("locked.md", None);
    f.gate.set("locked.docx", None);
    assert_eq!(f.extract(), complete(2));
    assert_eq!(f.found("answers"), ["locked.docx", "locked.md"]);
}

#[test]
fn a_long_text_file_is_read_up_to_the_read_limit_as_the_start_of_a_file() {
    let f = Fixture::new();
    // 3 MiB of a three-byte character: the read limit ends inside one.
    assert_eq!(extract::READ_LIMIT % 3, 1);
    f.fs.file("long.md", "线".repeat(1 << 20).as_bytes());
    f.scan_and_hash();
    let hashed = f.gate.bytes_read("long.md");
    assert_eq!(f.extract(), complete(1));
    // One byte past the limit tells that the file goes on.
    assert_eq!(
        f.gate.bytes_read("long.md") - hashed,
        extract::READ_LIMIT + 1
    );
    // The start of a UTF-8 file, not a whole file that fails UTF-8 and reads as GB18030.
    assert_eq!(f.body("long.md").unwrap(), "线".repeat(MAX_BODY_BYTES / 3));
}

#[test]
fn a_damaged_document_is_recorded_once_and_listed_until_it_changes() {
    let f = Fixture::new();
    f.fs.file("thesis.docx", b"not really a document");
    f.scan_and_hash();
    let report = f.extract();
    assert_eq!((report.extracted, report.complete), (1, true));
    assert_eq!(
        problems(&report),
        [("thesis.docx".to_owned(), ReadFailure::Damaged)]
    );
    let Problem::Unreadable { detail, .. } = &report.problems[0] else {
        unreachable!()
    };
    assert!(detail.contains("not a Word document"), "{detail}");
    assert_eq!(f.outcome("thesis.docx"), outcome("failed", Some("invalid")));

    // Every complete pass lists it, without reading it again.
    f.gate.set("thesis.docx", Some(OnOpen::Panic));
    let again = f.extract();
    assert_eq!(again.extracted, 0);
    assert_eq!(again.problems, report.problems);

    // Its new content is read.
    f.gate.set("thesis.docx", None);
    f.fs.file("thesis.docx", &docx(&["Chapter one"]));
    f.scan_and_hash();
    assert_eq!(f.extract(), complete(1));
    assert_eq!(f.found("chapter"), ["thesis.docx"]);
    assert_eq!(f.extract(), complete(0));
}

#[test]
fn every_document_the_reader_refuses_is_damaged() {
    let f = Fixture::new();
    // What Word saves with a password to open it: a compound file, not a ZIP archive.
    let mut protected = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    protected.resize(4 << 10, 0);
    f.fs.file("protected.docx", &protected);
    // Another format under a .docx name.
    f.fs.file("scan.docx", b"%PDF-1.7\n% an invented page\n%%EOF\n");
    // A package whose main part is encrypted.
    let mut sealed = docx(&["kept apart"]);
    set_encrypted(&mut sealed, "word/document.xml");
    f.fs.file("sealed.docx", &sealed);
    f.scan_and_hash();
    let report = f.extract();
    assert_eq!((report.extracted, report.complete), (3, true));
    let names = ["protected.docx", "scan.docx", "sealed.docx"];
    assert_eq!(
        problems(&report),
        names.map(|name| (name.to_owned(), ReadFailure::Damaged))
    );
    // The catalog keeps them as it did before `Damaged`: no migration.
    for name in names {
        assert_eq!(
            f.outcome(name),
            outcome("failed", Some("invalid")),
            "{name}"
        );
    }
}

#[test]
fn documents_over_a_cap_are_too_large() {
    let f = Fixture::new();
    f.fs.file("many.docx", &entries_zip(extract::MAX_ENTRIES + 1));
    f.scan_and_hash();
    let report = f.extract();
    assert_eq!(report.extracted, 1);
    assert_eq!(
        problems(&report),
        [("many.docx".to_owned(), ReadFailure::TooLarge)]
    );
    assert_eq!(f.outcome("many.docx"), outcome("failed", Some("too_large")));
}

#[test]
fn a_document_not_read_in_time_is_a_problem_until_it_is() {
    let f = Fixture::new();
    f.fs.file("slow.docx", &docx(&["takes a while"]));
    f.scan_and_hash();
    let cancel = AtomicBool::new(false);
    let pass = Pass {
        time_limit: Duration::ZERO,
        ..f.pass(&cancel)
    };
    // Not recorded, so tried again by every pass: the caps bound the work far below the limit,
    // so the machine more likely stalled than the document took that long.
    for _ in 0..2 {
        let (report, commits) = f.extract_with(&pass, &mut || false);
        assert_eq!((report.extracted, report.complete, commits), (0, true, 0));
        assert_eq!(
            problems(&report),
            [("slow.docx".to_owned(), ReadFailure::Other)]
        );
        let Problem::Unreadable { detail, .. } = &report.problems[0] else {
            unreachable!()
        };
        assert!(detail.contains("longer than allowed"), "{detail}");
        assert_eq!(f.outcome("slow.docx"), None);
        assert_eq!(f.pending(), 1);
    }
    assert_eq!(f.extract(), complete(1));
    assert_eq!(f.found("while"), ["slow.docx"]);
}

#[test]
fn cancelling_keeps_what_was_extracted() {
    let f = Fixture::new();
    for name in ["a.md", "b.md", "c.md"] {
        f.fs.file(name, b"kept");
    }
    f.scan_and_hash();
    let cancel = AtomicBool::new(false);
    let report = f
        .library
        .extract_pending(&f.catalog, &cancel, &mut |_, _| {
            cancel.store(true, Ordering::Relaxed);
        })
        .unwrap();
    assert_eq!(
        report,
        ExtractReport {
            extracted: 1,
            cancelled: true,
            ..ExtractReport::default()
        }
    );
    assert_eq!(f.pending(), 2);
    assert_eq!(f.extract(), complete(2));
}

#[test]
fn cancelling_while_a_document_is_read_records_nothing_for_it() {
    let f = Fixture::new();
    f.fs.file("thesis.docx", &docx(&["a long chapter"]));
    f.scan_and_hash();
    let cancel = Arc::new(AtomicBool::new(false));
    f.gate
        .set("thesis.docx", Some(OnOpen::Cancel(cancel.clone())));
    let report = f
        .library
        .extract_pending(&f.catalog, &cancel, &mut |_, _| {})
        .unwrap();
    assert_eq!(
        report,
        ExtractReport {
            cancelled: true,
            ..ExtractReport::default()
        }
    );
    assert_eq!(f.outcome("thesis.docx"), None);
    assert_eq!(f.pending(), 1);
}

#[test]
fn an_incomplete_pass_lists_only_the_failures_it_found() {
    let f = Fixture::new();
    f.fs.file("old.docx", b"damaged long ago");
    f.scan_and_hash();
    f.extract();
    // Each scan adds its files with higher ids, the order the pass takes them in.
    f.fs.file("new.docx", b"damaged just now");
    f.scan_and_hash();
    f.fs.file("later.md", b"not reached");
    f.scan_and_hash();
    let cancel = AtomicBool::new(false);
    let report = f
        .library
        .extract_pending(&f.catalog, &cancel, &mut |_, _| {
            cancel.store(true, Ordering::Relaxed);
        })
        .unwrap();
    assert!(report.cancelled && !report.complete);
    assert_eq!(
        problems(&report),
        [("new.docx".to_owned(), ReadFailure::Damaged)]
    );
    let report = f.extract();
    assert_eq!(report.extracted, 1);
    assert_eq!(
        problems(&report),
        [
            ("new.docx".to_owned(), ReadFailure::Damaged),
            ("old.docx".to_owned(), ReadFailure::Damaged)
        ]
    );
}

#[test]
fn an_incomplete_pass_lists_a_failure_with_the_detail_the_catalog_keeps() {
    let f = Fixture::new();
    // A mismatched end tag, which quick-xml's error names in full: a megabyte from a small file.
    let main = format!("<a></{}>", "B".repeat(1 << 20));
    let crafted = Package::default().part("word/document.xml", main).build();
    assert!(crafted.len() < 8 << 10, "{}", crafted.len());
    f.fs.file("crafted.docx", &crafted);
    f.scan_and_hash();
    f.fs.file("later.md", b"not reached");
    f.scan_and_hash();
    let detail = |report: &ExtractReport| match &report.problems[..] {
        [Problem::Unreadable { detail, .. }] => detail.clone(),
        other => panic!("{other:?}"),
    };
    let cancel = AtomicBool::new(false);
    let report = f
        .library
        .extract_pending(&f.catalog, &cancel, &mut |_, _| {
            cancel.store(true, Ordering::Relaxed);
        })
        .unwrap();
    assert!(!report.complete);
    let listed = detail(&report);
    assert!(listed.chars().count() <= 500, "{}", listed.len());
    // A complete pass lists what the catalog kept: the same.
    let report = f.extract();
    assert!(report.complete);
    assert_eq!(detail(&report), listed);
}

#[test]
fn yielding_stops_at_a_write_and_the_next_pass_goes_on() {
    let f = Fixture::new();
    for index in 0..=BATCH {
        f.fs.file(&format!("{index}.md"), b"batch");
    }
    f.scan_and_hash();
    let all = u64::from(BATCH) + 1;
    let (mut asked, mut total) = (0, 0);
    let report = f
        .library
        .extract_pending_with_commits(
            &f.catalog,
            &AtomicBool::new(false),
            &mut || {
                asked += 1;
                true
            },
            &mut |_, of| total = of,
            &mut || {},
        )
        .unwrap();
    assert_eq!(total, all);
    assert_eq!(asked, 1);
    assert!(!report.complete && !report.cancelled);
    assert!((1..=u64::from(BATCH)).contains(&report.extracted));
    assert_eq!(f.pending(), all - report.extracted);
    let rest = f.extract();
    assert_eq!(rest, complete(all - report.extracted));
}

#[test]
fn a_write_after_the_last_file_does_not_yield() {
    let f = Fixture::new();
    for name in ["a.md", "b.md", "c.md"] {
        f.fs.file(name, b"one write each");
        // Its own scan, so the files are extracted in this order.
        f.scan_and_hash();
    }
    let cancel = AtomicBool::new(false);
    // A write after every file.
    let pass = Pass {
        write_every: Duration::ZERO,
        ..f.pass(&cancel)
    };
    let mut asked = 0;
    let (report, commits) = f.extract_with(&pass, &mut || {
        asked += 1;
        true
    });
    assert_eq!(
        (report.extracted, report.complete, commits, asked),
        (1, false, 1, 1)
    );
    // With no file left after its write, the pass is complete whatever `should_yield` would say:
    // no, after b.md; yes, were it asked after c.md.
    let (report, commits) = f.extract_with(&pass, &mut || {
        asked += 1;
        asked > 2
    });
    assert_eq!(report, complete(2));
    assert_eq!((commits, asked), (2, 2));
}

#[test]
fn body_text_waiting_to_be_written_is_written_once_it_reaches_the_threshold() {
    let f = Fixture::new();
    for (name, text) in [
        ("a.md", &b"twenty bytes of text"[..]),
        ("b.md", b"   "),
        ("c.md", b"and twenty more here"),
        ("d.md", b"the last one"),
    ] {
        f.fs.file(name, text);
        f.scan_and_hash();
    }
    let cancel = AtomicBool::new(false);
    // Never for the time passed; for 20 bytes of body text, which an empty file does not add.
    let pass = Pass {
        write_every: Duration::MAX,
        write_bytes: 20,
        ..f.pass(&cancel)
    };
    let mut asked = 0;
    let (report, commits) = f.extract_with(&pass, &mut || {
        asked += 1;
        false
    });
    assert_eq!(report, complete(4));
    // After a.md, after c.md, and the rest at the batch's end.
    assert_eq!((commits, asked), (3, 2));
}

#[test]
fn reports_committed_extracts_before_a_later_write_fails() {
    let f = Fixture::new();
    for index in 0..=BATCH {
        f.fs.file(&format!("{index}.md"), b"extract me");
    }
    f.scan_and_hash();
    let mut commits = 0;
    let result = f.library.extract_pending_with_commits(
        &f.catalog,
        &AtomicBool::new(false),
        &mut || false,
        &mut |_, _| {},
        &mut || {
            commits += 1;
            // This write would deadlock if notifications still held the catalog writer.
            f.catalog
                .write(|tx| {
                    tx.execute_batch(
                        "CREATE TRIGGER stop_extract BEFORE INSERT ON extracts
                         BEGIN SELECT RAISE(ABORT, 'injected later write failure'); END;",
                    )?;
                    Ok(())
                })
                .unwrap();
        },
    );
    assert!(matches!(result, Err(LibraryError::Catalog(_))));
    assert_eq!(commits, 1);
    assert!((1..=u64::from(BATCH)).contains(&f.pending()));
}
