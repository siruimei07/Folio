//! Library settings → Ignore rules against a real library session (ipc-m1 §22).

use std::fs;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use folio_core::catalog;
use folio_core::library::state::Settings;
use folio_core::meta::DisplayName;
use folio_core::paths::RelPath;
use tempfile::TempDir;

use super::super::tests::until;
use super::*;
use crate::ipc::jobs::{JobKind, JobStatus};

struct Fixture {
    state: LibraryState,
    root: PathBuf,
    _dir: TempDir,
}

impl Fixture {
    /// A library with `files`, opened the way the app opens it at start-up.
    fn open(files: &[&str]) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("library");
        let data = dir.path().join("data");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&data).unwrap();
        state::create(
            &root,
            DisplayName::parse("Library").unwrap(),
            ["Notes", "Slides", "Homework", "Exam", "Reference"]
                .map(|name| DisplayName::parse(name).unwrap()),
        )
        .unwrap();
        for file in files {
            let path = root.join(file);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, b"x").unwrap();
        }
        let root = root.canonicalize().unwrap();
        Settings::update(&data, |settings| settings.library_root = Some(root.clone())).unwrap();
        let state = LibraryState::new(Ok(data), Arc::new(|_| {}));
        state.initialize();
        let fixture = Self {
            state,
            root,
            _dir: dir,
        };
        fixture.scans_done();
        fixture
    }

    fn scans_done(&self) {
        until("scans to finish", || {
            let jobs = self.state.list_jobs().unwrap();
            jobs.iter()
                .all(|job| !matches!(job.status, JobStatus::Queued | JobStatus::Running { .. }))
                .then_some(())
        });
    }

    fn catalogued(&self, path: &str) -> bool {
        let path = RelPath::parse(path).unwrap();
        self.state
            .read_catalog(|catalog| {
                catalog
                    .read(|tx| catalog::entry(tx, &path))
                    .map_err(super::super::catalog_error)
            })
            .unwrap()
            .is_some()
    }

    fn file(&self) -> Option<String> {
        fs::read_to_string(self.root.join(".folio").join("ignore")).ok()
    }

    /// Saves `text` and returns the rules with what the change callback received.
    fn set(&self, text: &str) -> Result<(IgnoreRules, Vec<IgnoreRules>), AppError> {
        let announced = Mutex::new(Vec::new());
        let rules = self.state.set_ignore_rules(
            SetIgnoreRules {
                text: text.to_owned(),
            },
            |rules| announced.lock().unwrap().push(rules.clone()),
        )?;
        Ok((rules, announced.into_inner().unwrap()))
    }
}

impl Drop for Fixture {
    fn drop(&mut self) {
        let result = self.state.shutdown();
        if !std::thread::panicking() {
            result.unwrap();
        }
    }
}

#[test]
fn a_library_without_rules_has_empty_text() {
    let f = Fixture::open(&[]);
    let rules = f.state.ignore_rules().unwrap();
    assert_eq!(rules.text, "");
    assert!(rules.invalid_lines.is_empty());
}

#[test]
fn saving_stores_lf_text_marks_invalid_lines_and_announces_only_changes() {
    let f = Fixture::open(&[]);
    let (rules, announced) = f.set("Cafe\u{301}/\r\n[z-a]\r\n*.bak\n\n").unwrap();
    // Scans convert each rule to NFC; the file keeps what the user typed.
    assert_eq!(rules.text, "Cafe\u{301}/\n[z-a]\n*.bak\n");
    assert_eq!(rules.invalid_lines, [2]);
    assert_eq!(f.file().as_deref(), Some(rules.text.as_str()));
    assert_eq!(announced, std::slice::from_ref(&rules));
    assert_eq!(f.state.ignore_rules().unwrap(), rules);

    // The same rules again: nothing is written, announced or scanned.
    let (again, announced) = f.set(&rules.text).unwrap();
    assert_eq!(again, rules);
    assert!(announced.is_empty());

    // Empty text keeps an empty file: the defaults alone apply.
    let (empty, announced) = f.set("").unwrap();
    assert_eq!(empty.text, "");
    assert_eq!(announced.len(), 1);
    assert_eq!(f.file().as_deref(), Some(""));
}

#[test]
fn rules_over_the_limit_are_refused_before_anything_is_written() {
    let f = Fixture::open(&[]);
    let text = "a".repeat(LIMITS.ignore_rules_chars as usize + 1);
    assert!(matches!(f.set(&text), Err(AppError::InvalidArgument(_))));
    assert_eq!(f.file(), None);
    // The limit counts characters, not bytes or UTF-16 units, and not the final line breaks: the
    // longest text the shell stores saves again unchanged.
    let longest = "😀".repeat(LIMITS.ignore_rules_chars as usize);
    let stored = stored_text(&longest).unwrap();
    assert_eq!(stored, format!("{longest}\n"));
    assert_eq!(stored_text(&stored).unwrap(), stored);
    assert_eq!(stored_text(&format!("{longest}\r\n\r\n")).unwrap(), stored);
    assert_eq!(stored_text("a\n\n\n").unwrap(), "a\n");
    assert_eq!(stored_text("\r\n").unwrap(), "");
}

#[test]
fn a_change_rescans_the_library_with_the_new_rules() {
    let f = Fixture::open(&["Fall/CSC101/build/out.o", "Fall/CSC101/notes.md"]);
    assert!(f.catalogued("Fall/CSC101/build/out.o"));
    f.set("build/\n").unwrap();
    until("the build folder to leave the catalog", || {
        (!f.catalogued("Fall/CSC101/build")).then_some(())
    });
    assert!(f.catalogued("Fall/CSC101/notes.md"));
    f.scans_done();
    assert!(
        f.state
            .list_jobs()
            .unwrap()
            .iter()
            .any(|job| job.kind == JobKind::Scan && matches!(job.status, JobStatus::Done { .. }))
    );

    // Taking the rule back brings the folder back.
    f.set("").unwrap();
    until("the build folder to return", || {
        f.catalogued("Fall/CSC101/build/out.o").then_some(())
    });
}

#[test]
fn rules_saved_during_a_rebuild_apply_once_it_is_done() {
    let f = Fixture::open(&["Fall/CSC101/build/out.o", "Fall/CSC101/notes.md"]);
    f.state.rebuild().unwrap();
    f.set("build/\n").unwrap();
    f.scans_done();
    until("the build folder to leave the catalog", || {
        (!f.catalogued("Fall/CSC101/build")).then_some(())
    });
    assert!(f.catalogued("Fall/CSC101/notes.md"));
}

#[test]
fn rules_need_an_open_library() {
    let dir = tempfile::tempdir().unwrap();
    let none = LibraryState::new(Ok(dir.path().to_owned()), Arc::new(|_| {}));
    none.initialize();
    assert!(matches!(none.ignore_rules(), Err(AppError::NoLibrary(_))));
    let set = none.set_ignore_rules(
        SetIgnoreRules {
            text: "x\n".to_owned(),
        },
        |_| panic!("nothing was saved"),
    );
    assert!(matches!(set, Err(AppError::NoLibrary(_))));
    none.shutdown().unwrap();
}
