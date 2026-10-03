//! The formats Folio v0.1 wrote, frozen (ADR-0002 action item 5). The files under
//! `tests/fixtures/formats/v0.1/` were written once by the v0.1 code (README there) and never
//! change: every later Folio must open them. A format change ships with a migration that keeps
//! these tests passing, and with fixtures of its own.

use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::SystemTime;

use folio_core::catalog::{self, Catalog, queries as browse};
use folio_core::library::Library;
use folio_core::library::state::{ReduceMotion, Settings, Theme};
use folio_core::meta::{
    Abbr, Assignments, Color, CourseCode, CourseMeta, CourseSettings, DisplayName, GroupMeta,
    GroupSettings, Layout, LibraryId, MetaTree, RootMeta, ScanJournal, TagId,
};
use folio_core::paths::{CoursePath, RelPath, SemesterPath};
use folio_core::search::SearchQuery;
use folio_core::win::WindowsFileSystem;

const LIBRARY_ID: &str = "48ffdfb335860f2c15c8bccf2a90e720";
/// The tag "Lab reports", made in Library settings.
const LAB_REPORTS: &str = "88a8ea5c2a25ea7f";

fn v0_1(path: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("tests/fixtures/formats/v0.1")
        .join(path)
}

fn path(text: &str) -> RelPath {
    RelPath::parse(text).unwrap()
}

fn tags<const N: usize>(ids: [&str; N]) -> BTreeSet<TagId> {
    ids.into_iter()
        .map(|id| TagId::parse(id).unwrap())
        .collect()
}

fn assignments<const N: usize>(entries: [(&str, BTreeSet<TagId>); N]) -> Assignments {
    let mut assignments = Assignments::default();
    for (key, ids) in entries {
        assignments.set(path(key), ids);
    }
    assignments
}

fn semester(text: &str) -> SemesterPath {
    SemesterPath::new(path(text)).unwrap()
}

fn course(text: &str) -> CoursePath {
    CoursePath::new(path(text)).unwrap()
}

fn settings(
    abbr: Option<&str>,
    archived: bool,
    code: Option<&str>,
    color: Option<&str>,
    order: u32,
) -> CourseSettings {
    CourseSettings {
        abbr: abbr.map(|text| Abbr::parse(text).unwrap()),
        archived,
        code: code.map(|text| CourseCode::parse(text).unwrap()),
        color: color.map(|text| Color::parse(text).unwrap()),
        order,
    }
}

/// Copies a fixture folder, so a test that opens or scans it never changes the checked-in files.
fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for item in fs::read_dir(from).unwrap() {
        let item = item.unwrap();
        let target = to.join(item.file_name());
        if item.file_type().unwrap().is_dir() {
            copy_tree(&item.path(), &target);
        } else {
            fs::copy(item.path(), target).unwrap();
        }
    }
}

/// Every file below `root`, by relative path, with its bytes.
fn snapshot(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    let mut files = BTreeMap::new();
    let mut folders = vec![root.to_owned()];
    while let Some(folder) = folders.pop() {
        for item in fs::read_dir(&folder).unwrap() {
            let item = item.unwrap();
            if item.file_type().unwrap().is_dir() {
                folders.push(item.path());
            } else {
                let relative = item.path().strip_prefix(root).unwrap().to_owned();
                files.insert(relative, fs::read(item.path()).unwrap());
            }
        }
    }
    files
}

#[test]
fn v0_1_metadata_files_open_with_their_values() {
    let layout = Layout::new(v0_1("library"));
    let config = layout.read_library().unwrap().unwrap();
    assert_eq!(config.id.as_str(), LIBRARY_ID);
    assert_eq!(config.name.as_str(), "我的资料库");
    let rules = &config.versioning;
    for extension in ["md", "py", "java", "tex", "txt"] {
        assert!(rules.text_extensions.contains(extension), "{extension}");
    }
    assert_eq!(
        rules
            .word_extensions
            .iter()
            .map(|e| e.as_str())
            .collect::<Vec<_>>(),
        ["docx"]
    );
    assert_eq!(rules.text_max_size, 10 * 1024 * 1024);

    let definitions = layout.read_tags().unwrap().unwrap();
    let defined: Vec<_> = definitions
        .tags
        .iter()
        .map(|(id, tag)| {
            (
                id.as_str(),
                tag.name.as_str(),
                tag.color.as_str(),
                tag.order,
            )
        })
        .collect();
    assert_eq!(
        defined,
        [
            (LAB_REPORTS, "Lab reports", "violet", 6),
            ("exam", "Exams", "red", 4),
            ("homework", "Homework", "orange", 3),
            ("notes", "Notes", "blue", 1),
            ("reference", "Reference", "stone", 5),
            ("slides", "Slides", "green", 2),
        ]
    );
    assert_eq!(
        layout.read_ignore().unwrap().as_deref(),
        Some("*.tmp\nscratch/\n")
    );

    assert_eq!(
        layout.read_root_meta().unwrap().unwrap(),
        RootMeta {
            tags: assignments([("readme.md", tags(["reference"]))]),
        }
    );
    assert_eq!(
        layout
            .read_group_meta(&semester("2026 秋"))
            .unwrap()
            .unwrap(),
        GroupMeta {
            group: Some(GroupSettings {
                archived: false,
                order: 1,
            }),
            tags: assignments([("日程.pdf", tags(["notes"]))]),
        }
    );
    assert_eq!(
        layout
            .read_group_meta(&semester("2026 春"))
            .unwrap()
            .unwrap(),
        GroupMeta {
            group: Some(GroupSettings {
                archived: true,
                order: 0,
            }),
            tags: Assignments::default(),
        }
    );
    let courses = [
        (
            "2026 秋/线性代数",
            CourseMeta {
                course: Some(settings(
                    Some("线代"),
                    false,
                    Some("MAT232"),
                    Some("blue"),
                    1,
                )),
                tags: assignments([
                    ("作业", tags(["homework"])),
                    ("复习笔记.md", tags(["exam", "notes"])),
                    ("第3讲 特征值.pptx", tags(["slides"])),
                ]),
            },
        ),
        (
            // A name that starts with `_`: `.folio/meta/2026 秋/__杂项.json`.
            "2026 秋/_杂项",
            CourseMeta {
                course: Some(settings(None, false, None, None, 0)),
                tags: assignments([("a.txt", tags([LAB_REPORTS]))]),
            },
        ),
        (
            "2026 秋/Calculus",
            CourseMeta {
                course: Some(settings(None, false, Some("MAT237"), Some("teal"), 2)),
                tags: Assignments::default(),
            },
        ),
        (
            "2026 春/CSC207 Software Design",
            CourseMeta {
                course: Some(settings(None, true, Some("CSC207"), None, 0)),
                tags: assignments([("lab1.java", tags([LAB_REPORTS, "homework"]))]),
            },
        ),
    ];
    for (folder, expected) in &courses {
        assert_eq!(
            &layout.read_course_meta(&course(folder)).unwrap().unwrap(),
            expected,
            "{folder}"
        );
    }

    let tree = MetaTree::read(&layout).unwrap();
    assert!(tree.broken().is_empty(), "{:?}", tree.broken());
    assert!(!tree.is_read_only());
    assert_eq!(tree.loaded().len(), 3 + courses.len());
}

/// What this Folio writes is still v0.1's format. When the metadata format changes, add the new
/// version's fixtures and point this test at them; the reads above stay on v0.1.
#[test]
fn v0_1_metadata_bytes_are_what_this_folio_writes() {
    assert_eq!(
        folio_core::meta::FORMAT_VERSION,
        2,
        "a new metadata format needs fixtures of its own (tests/fixtures/formats/README.md)"
    );
    let fixture = Layout::new(v0_1("library"));
    let temp = tempfile::tempdir().unwrap();
    let written = Layout::new(temp.path());
    written
        .write_library(&fixture.read_library().unwrap().unwrap())
        .unwrap();
    written
        .write_tags(&fixture.read_tags().unwrap().unwrap())
        .unwrap();
    written
        .write_ignore(&fixture.read_ignore().unwrap().unwrap())
        .unwrap();
    written
        .write_root_meta(&fixture.read_root_meta().unwrap().unwrap())
        .unwrap();
    for name in ["2026 秋", "2026 春"] {
        let group = semester(name);
        written
            .write_group_meta(&group, &fixture.read_group_meta(&group).unwrap().unwrap())
            .unwrap();
    }
    for name in [
        "2026 秋/线性代数",
        "2026 秋/_杂项",
        "2026 秋/Calculus",
        "2026 春/CSC207 Software Design",
    ] {
        let folder = course(name);
        written
            .write_course_meta(
                &folder,
                &fixture.read_course_meta(&folder).unwrap().unwrap(),
            )
            .unwrap();
    }
    let _ = fs::remove_dir_all(written.folio_dir().join("local"));
    assert_eq!(
        snapshot(&written.folio_dir()),
        snapshot(&fixture.folio_dir())
    );
}

#[test]
fn v0_1_app_settings_open() {
    let settings = Settings::load(&v0_1("app-data")).unwrap();
    assert_eq!(
        settings,
        Settings {
            format_version: 1,
            library_root: Some(PathBuf::from(r"\\?\C:\Users\Student\Documents\我的资料库")),
            device_name: Some(DisplayName::parse("Lab PC").unwrap()),
            theme: Theme::Dark,
            reduce_motion: ReduceMotion::On,
            extra: BTreeMap::new(),
        }
    );
}

/// The journal a crash leaves between recording a rename and Windows doing it.
#[test]
fn v0_1_scan_journal_opens() {
    let temp = tempfile::tempdir().unwrap();
    let layout = Layout::new(temp.path());
    let journal = layout.scan_journal_file();
    fs::create_dir_all(journal.parent().unwrap()).unwrap();
    fs::copy(v0_1("journals/scan.json"), &journal).unwrap();

    let read = ScanJournal::read(&layout).unwrap().unwrap();
    assert!(read.has_after_images());
    let from = path("2026 秋/线性代数/复习笔记.md");
    let to = path("2026 秋/线性代数/复习笔记 (final).md");
    assert_eq!(read.moved(), Some((&from, &to)));
    // Version 3 records each entry's catalog and disk identity.
    let entries = read.move_entries().unwrap();
    let moves: Vec<_> = entries
        .iter()
        .map(|(entry, to, _)| (entry.record.path.as_str(), to.as_str()))
        .collect();
    assert_eq!(
        moves,
        [(
            "2026 秋/线性代数/复习笔记.md",
            "2026 秋/线性代数/复习笔记 (final).md"
        )]
    );
}

/// The intent a crash leaves after an import published it, before the file it replaces went to
/// the Recycle Bin. Recovery reads and validates it; in a copied library the folder's identity
/// differs, so it gives the copy up and touches no user file.
#[test]
fn v0_1_import_intent_is_read_and_settled() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    copy_tree(&v0_1("library"), &root);
    let library = Library::new(&root, Arc::new(WindowsFileSystem::open(&root).unwrap()));
    let id = LibraryId::parse(LIBRARY_ID).unwrap();
    let catalog = Catalog::open(&temp.path().join("catalog.sqlite"), &id)
        .unwrap()
        .catalog;
    let now = folio_core::fs::unix_ns(SystemTime::now()).unwrap();
    library.scan(&catalog, None, now).unwrap();
    let intent = library.layout().import_journal_file();
    fs::create_dir_all(intent.parent().unwrap()).unwrap();
    fs::copy(v0_1("journals/import.json"), &intent).unwrap();
    let before = snapshot(&root.join("2026 秋"));

    library.recover_import(&catalog).unwrap();
    assert!(!intent.exists());
    assert_eq!(snapshot(&root.join("2026 秋")), before);
}

#[test]
fn v0_1_catalog_opens_without_a_rebuild() {
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("catalog.sqlite");
    fs::copy(v0_1("catalog.sqlite"), &file).unwrap();
    let opened = Catalog::open(&file, &LibraryId::parse(LIBRARY_ID).unwrap()).unwrap();
    assert_eq!(opened.recovered, None);
    let catalog = opened.catalog;

    let notes = path("2026 秋/线性代数/复习笔记.md");
    catalog
        .read(|tx| {
            assert_eq!(catalog::count_entries(tx)?, 18);
            let entry = catalog::entry(tx, &notes)?.unwrap();
            assert!(entry.record.hash.is_some());
            assert_eq!(catalog::entry_tags(tx, entry.id)?, tags(["exam", "notes"]));
            // Ignored by `.folio/ignore`.
            for ignored in [
                "2026 秋/线性代数/draft.tmp",
                "2026 春/CSC207 Software Design/scratch",
            ] {
                assert!(catalog::entry(tx, &path(ignored))?.is_none(), "{ignored}");
            }
            Ok(())
        })
        .unwrap();

    let linear = path("2026 秋/线性代数");
    let sort = browse::EntrySort {
        key: browse::SortKey::Name,
        descending: false,
    };
    let page = browse::PageRequest {
        offset: 0,
        limit: 50,
    };
    let (names, hits) = catalog
        .read_stamped::<_, browse::QueryError>(|tx, _| {
            let course = catalog::entry(tx, &linear)?.unwrap();
            let children = browse::list_children(tx, Some((course.id, &linear)), sort, page)?;
            let names: Vec<String> = children
                .items
                .iter()
                .map(|row| row.entry.record.path.name().to_owned())
                .collect();
            let mut hits = Vec::new();
            // One and two Chinese characters, and a Latin word.
            for text in ["笔", "特征", "syllabus"] {
                let query = SearchQuery::parse(text).unwrap().unwrap();
                let found = browse::search_page(tx, &query, None, page, 0)?;
                hits.push(
                    found
                        .items
                        .iter()
                        .map(|hit| hit.entry.entry.record.path.name().to_owned())
                        .collect::<Vec<_>>(),
                );
            }
            Ok((names, hits))
        })
        .unwrap();
    assert_eq!(
        names,
        ["Lectures", "作业", "复习笔记.md", "第3讲 特征值.pptx"]
    );
    assert_eq!(
        hits,
        [
            vec!["复习笔记.md".to_owned()],
            vec!["第3讲 特征值.pptx".to_owned()],
            vec!["syllabus.md".to_owned()],
        ]
    );
}

/// The library and its catalog together, as v0.1 left them: this Folio opens and scans them,
/// keeps every tag and writes no metadata file.
#[test]
fn v0_1_library_opens_and_scans_with_its_catalog() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path().join("library");
    copy_tree(&v0_1("library"), &root);
    let file = temp.path().join("catalog.sqlite");
    fs::copy(v0_1("catalog.sqlite"), &file).unwrap();
    let opened = Catalog::open(&file, &LibraryId::parse(LIBRARY_ID).unwrap()).unwrap();
    assert_eq!(opened.recovered, None);
    let catalog = opened.catalog;
    let library = Library::new(&root, Arc::new(WindowsFileSystem::open(&root).unwrap()));
    let metadata = snapshot(&root.join(".folio"));

    let now = folio_core::fs::unix_ns(SystemTime::now()).unwrap();
    let report = library.scan(&catalog, None, now).unwrap();
    assert!(report.problems.is_empty(), "{:?}", report.problems);
    assert!(library.sync_metadata(&catalog).unwrap().is_empty());

    let tagged = [
        ("readme.md", tags(["reference"])),
        ("2026 秋/日程.pdf", tags(["notes"])),
        ("2026 秋/线性代数/作业", tags(["homework"])),
        ("2026 秋/线性代数/复习笔记.md", tags(["exam", "notes"])),
        ("2026 秋/_杂项/a.txt", tags([LAB_REPORTS])),
        (
            "2026 春/CSC207 Software Design/lab1.java",
            tags([LAB_REPORTS, "homework"]),
        ),
    ];
    catalog
        .read(|tx| {
            assert_eq!(catalog::count_entries(tx)?, 18);
            for (text, expected) in &tagged {
                let entry = catalog::entry(tx, &path(text))?.unwrap();
                assert_eq!(&catalog::entry_tags(tx, entry.id)?, expected, "{text}");
            }
            Ok(())
        })
        .unwrap();
    let mut after = snapshot(&root.join(".folio"));
    after.retain(|file, _| !file.starts_with("local"));
    assert_eq!(after, metadata);
}
