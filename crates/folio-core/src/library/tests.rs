use std::collections::{BTreeMap, BTreeSet};
use std::ffi::OsString;
use std::fs as std_fs;
use std::sync::atomic::{AtomicBool, Ordering};

use tempfile::TempDir;

use super::*;
use crate::catalog::{
    Entry, EntryId, all_courses, entries_in, entry, entry_tags, semesters, tag_definitions,
};
use crate::fs::{FileKind, StdFileSystem};
use crate::hash::ContentHash;
use crate::meta::{
    Abbr, Assignments, Color, CourseMeta, CourseSettings, DisplayName, FileClass, GroupMeta,
    GroupSettings, LibraryConfig, Moves, StrandedCause, TagFile, TagId, VersioningRules,
    tag_location,
};
use crate::test_support::{
    MemFs, course_at, library_id, open_catalog, path, presets, semester, tags,
};

mod property;

/// A library on a [`MemFs`] whose `.folio/` lives in a temporary folder, and its catalog.
struct Fixture {
    _dir: TempDir,
    fs: Arc<MemFs>,
    library: Library,
    catalog: Catalog,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("资料库");
        let fs = MemFs::new(&root);
        let library = Library::new(&root, fs.clone());
        write_config(library.layout());
        let catalog = open_catalog(dir.path());
        Self {
            _dir: dir,
            fs,
            library,
            catalog,
        }
    }

    fn layout(&self) -> &Layout {
        self.library.layout()
    }

    fn scan(&self) -> ScanReport {
        self.scan_into(&self.catalog)
    }

    /// Scans into `catalog`, say a rebuilt one.
    fn scan_into(&self, catalog: &Catalog) -> ScanReport {
        self.library.scan(catalog, None, self.fs.now_ns()).unwrap()
    }

    fn scan_in(&self, scope: &str) -> ScanReport {
        self.library
            .scan(&self.catalog, Some(&path(scope)), self.fs.now_ns())
            .unwrap()
    }

    fn entries(&self) -> Vec<Entry> {
        self.catalog.read(|tx| entries_in(tx, None)).unwrap()
    }

    fn paths(&self) -> Vec<String> {
        self.entries()
            .into_iter()
            .map(|entry| entry.record.path.to_string())
            .collect()
    }

    fn entry(&self, text: &str) -> Entry {
        self.catalog
            .read(|tx| entry(tx, &path(text)))
            .unwrap()
            .unwrap_or_else(|| panic!("no entry at {text}"))
    }

    fn tags(&self, text: &str) -> Vec<String> {
        let id = self.entry(text).id;
        let tags = self.catalog.read(|tx| entry_tags(tx, id)).unwrap();
        tags.iter().map(ToString::to_string).collect()
    }

    fn write_ignore(&self, rules: &str) {
        std_fs::write(self.layout().ignore_file(), rules).unwrap();
    }

    /// Hashes everything, however recently it changed.
    fn hash_all(&self) -> HashReport {
        self.hash_all_into(&self.catalog)
    }

    fn hash_all_into(&self, catalog: &Catalog) -> HashReport {
        let later = self.fs.now_ns() + 10_000_000_000;
        self.library
            .hash_pending(catalog, later, &AtomicBool::new(false), &mut |_, _| {})
            .unwrap()
    }
}

fn write_config(layout: &Layout) {
    let config = LibraryConfig {
        id: library_id(),
        name: DisplayName::parse("资料").unwrap(),
        versioning: VersioningRules::default(),
    };
    layout.write_library(&config).unwrap();
    layout.write_tags(&presets("课件")).unwrap();
}

fn sorted(paths: &[&str]) -> Vec<String> {
    let mut paths: Vec<String> = paths.iter().map(|path| (*path).to_owned()).collect();
    paths.sort();
    paths
}

fn settings(abbr: &str, order: u32) -> CourseSettings {
    CourseSettings {
        abbr: Abbr::parse(abbr).unwrap(),
        archived: false,
        color: Color::parse("blue").unwrap(),
        order,
    }
}

/// Tags an entry the way library operations do: in the file and under the key that
/// `tag_location` names.
fn set_tags(layout: &Layout, entry: &str, kind: EntryKind, ids: BTreeSet<TagId>) {
    let (file, key) = tag_location(&path(entry), kind).unwrap();
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

fn set_course(layout: &Layout, course: &str, settings: CourseSettings) {
    let course = course_at(course);
    let mut meta = layout
        .read_course_meta(&course)
        .unwrap()
        .unwrap_or_default();
    meta.course = Some(settings);
    layout.write_course_meta(&course, &meta).unwrap();
}

fn course_file(layout: &Layout, course: &str) -> std::path::PathBuf {
    layout
        .tag_file_path(&TagFile::Course(course_at(course)))
        .unwrap()
}

/// A name that is not valid Unicode on this platform.
fn not_unicode() -> OsString {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        OsString::from_vec(b"f\xff.txt".to_vec())
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStringExt;
        OsString::from_wide(&[0x66, 0xD800])
    }
}

#[test]
fn catalogs_a_library_with_classes_sizes_and_times() {
    let f = Fixture::new();
    f.fs.file("2026 秋/线性代数/第3讲.pptx", b"slides");
    f.fs.file("2026 秋/线性代数/笔记.md", b"# notes");
    f.fs.file("2026 秋/线性代数/报告.DOCX", b"docx");
    f.fs.folder("2026 秋/数据结构");
    f.fs.file("readme.txt", b"hi");

    let report = f.scan();
    assert_eq!(report.problems, []);
    let expected = sorted(&[
        "2026 秋",
        "2026 秋/数据结构",
        "2026 秋/线性代数",
        "2026 秋/线性代数/第3讲.pptx",
        "2026 秋/线性代数/笔记.md",
        "2026 秋/线性代数/报告.DOCX",
        "readme.txt",
    ]);
    assert_eq!(f.paths(), expected);
    let added: Vec<String> = report
        .changes
        .iter()
        .map(|change| match change {
            Change::Added(path) => path.to_string(),
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(added, expected);

    let notes = f.entry("2026 秋/线性代数/笔记.md").record;
    assert_eq!(
        (notes.kind, notes.class, notes.size, notes.hash),
        (EntryKind::File, FileClass::Text, 7, None)
    );
    assert!(notes.mtime_ns.is_some() && notes.file_id.is_some());
    assert_eq!(
        f.entry("2026 秋/线性代数/报告.DOCX").record.class,
        FileClass::Word
    );
    assert_eq!(
        f.entry("2026 秋/线性代数/第3讲.pptx").record.class,
        FileClass::Other
    );
    let folder = f.entry("2026 秋/数据结构").record;
    assert_eq!(
        (folder.kind, folder.class, folder.size),
        (EntryKind::Folder, FileClass::Other, 0)
    );

    // Nothing changed, nothing to do.
    assert_eq!(f.scan(), ScanReport::default());
}

#[test]
fn leaves_out_folios_folder_and_ignored_entries() {
    let f = Fixture::new();
    for file in [
        ".folio/local/HEAD",
        ".FOLIO/x.json",
        "2026 秋/Thumbs.db",
        "2026 秋/thumbs.DB",
        "2026 秋/.DS_Store",
        "2026 秋/~$报告.docx",
        "2026 秋/草稿.TMP",
        "2026 秋/a.nosync/x.md",
        "2026 秋/Icon\r",
        "proj/node_modules/pkg/index.js",
        "proj/.git/HEAD",
        "proj/env/pyvenv.cfg",
        "proj/env/lib/site.py",
        "proj/main.py",
        "sub/.folio/x.md",
    ] {
        f.fs.file(file, b"x");
    }
    let report = f.scan();
    assert_eq!(report.problems, []);
    assert_eq!(
        f.paths(),
        sorted(&[
            "2026 秋",
            "proj",
            "proj/main.py",
            "sub",
            "sub/.folio",
            "sub/.folio/x.md"
        ])
    );
}

#[test]
fn rules_follow_their_precedence() {
    let f = Fixture::new();
    f.fs.file("a.log", b"x");
    f.fs.file("keep/node_modules/x.js", b"x");
    f.fs.file("b.tmp", b"x");
    f.fs.file("proj/.gitignore", b"build/\n!important.log\n/top.txt\n");
    f.fs.file("proj/build/out.o", b"x");
    f.fs.file("proj/important.log", b"x");
    f.fs.file("proj/top.txt", b"x");
    f.fs.file("proj/sub/top.txt", b"x");
    f.fs.file("proj/sub/.gitignore", b"!build/\n");
    f.fs.file("proj/sub/build/x", b"x");
    f.fs.file("venv/pyvenv.cfg", b"x");
    f.fs.file("env/pyvenv.cfg", b"x");
    f.write_ignore("*.log\n!node_modules/\n!*.tmp\n!env/\n");

    f.scan();
    assert_eq!(
        f.paths(),
        sorted(&[
            "env",
            "env/pyvenv.cfg",
            "keep",
            "keep/node_modules",
            "keep/node_modules/x.js",
            "proj",
            "proj/.gitignore",
            "proj/important.log",
            "proj/sub",
            "proj/sub/.gitignore",
            "proj/sub/build",
            "proj/sub/build/x",
            "proj/sub/top.txt",
        ])
    );

    // New rules take effect with the next scan, both ways.
    f.write_ignore("keep/\n");
    let report = f.scan();
    assert!(report.changes.contains(&Change::Added(path("a.log"))));
    assert!(report.changes.contains(&Change::Removed(path("keep"))));
    assert!(!f.paths().contains(&"env".to_owned()));
}

#[test]
fn rules_ignore_case_and_unicode_normalization() {
    let f = Fixture::new();
    // `résumé.txt` typed on a Mac, which decomposes accented letters.
    f.write_ignore("re\u{301}sume\u{301}.txt\n");
    f.fs.file("résumé.txt", b"x");
    f.fs.file("THUMBS.DB", b"x");
    f.fs.file("cv.txt", b"x");
    f.scan();
    assert_eq!(f.paths(), ["cv.txt"]);
}

#[test]
fn invalid_rules_are_reported_and_the_others_apply() {
    let f = Fixture::new();
    f.write_ignore("*.log\n{unclosed\n*.bak\n");
    f.fs.file("proj/.gitignore", b"[z-a]\n*.o\n");
    for file in ["a.log", "b.bak", "c.txt", "proj/x.o", "proj/y.c"] {
        f.fs.file(file, b"x");
    }
    let report = f.scan();
    let lines: Vec<(Option<String>, usize)> = report
        .problems
        .iter()
        .map(|problem| match problem {
            Problem::InvalidIgnoreRule { file, line, .. } => {
                (file.as_ref().map(ToString::to_string), *line)
            }
            other => panic!("unexpected {other:?}"),
        })
        .collect();
    assert_eq!(lines, [(None, 2), (Some("proj/.gitignore".to_owned()), 1)]);
    assert_eq!(
        f.paths(),
        sorted(&["c.txt", "proj", "proj/.gitignore", "proj/y.c"])
    );
}

#[test]
fn reports_names_the_catalog_cannot_hold() {
    let f = Fixture::new();
    f.fs.file("a:b.txt", b"x");
    f.fs.file("dir/CON.txt", b"x");
    f.fs.file("trailing.", b"x");
    f.fs.file("Cafe\u{301}/menu.txt", b"x");
    f.fs.file("Café/menu.txt", b"x");
    f.fs.file("Notes.md", b"x");
    f.fs.file("notes.md", b"x");
    f.fs.raw_file(vec![OsString::from("dir"), not_unicode()], b"x");
    f.fs.special("link", FileKind::Link);
    f.fs.special("dir/pipe", FileKind::Other);

    let report = f.scan();
    let expected = [
        Problem::InvalidName {
            folder: None,
            name: "a:b.txt".to_owned(),
            error: PathError::ReservedCharacter(':'),
        },
        Problem::InvalidName {
            folder: Some(path("dir")),
            name: "CON.txt".to_owned(),
            error: PathError::ReservedName,
        },
        Problem::InvalidName {
            folder: None,
            name: "trailing.".to_owned(),
            error: PathError::TrailingDotOrSpace,
        },
        Problem::NotNfc {
            folder: None,
            name: "Cafe\u{301}".to_owned(),
            twin: true,
        },
        Problem::CaseTwins {
            paths: vec![path("Notes.md"), path("notes.md")],
        },
        Problem::NotUnicode {
            folder: Some(path("dir")),
            name: not_unicode().to_string_lossy().into_owned(),
        },
        Problem::Link {
            folder: None,
            name: "link".to_owned(),
        },
        Problem::Special {
            folder: Some(path("dir")),
            name: "pipe".to_owned(),
        },
    ];
    for problem in &expected {
        assert!(
            report.problems.contains(problem),
            "{problem:?} in {report:?}"
        );
    }
    assert_eq!(
        report.problems.len(),
        expected.len(),
        "{:?}",
        report.problems
    );
    assert_eq!(
        f.paths(),
        sorted(&["Café", "Café/menu.txt", "Notes.md", "dir", "notes.md"])
    );
}

#[test]
fn a_folder_that_cannot_be_listed_keeps_its_entries() {
    let f = Fixture::new();
    f.fs.file("a/b/c.md", b"x");
    f.scan();
    f.fs.fail_listing("a/b");
    f.fs.remove("a/b/c.md");
    let report = f.scan();
    assert_eq!(report.changes, []);
    assert!(matches!(
        &report.problems[..],
        [Problem::Unreadable { path: folder, .. }] if *folder == path("a/b")
    ));
    assert_eq!(f.paths(), ["a", "a/b", "a/b/c.md"]);
}

#[test]
fn finds_additions_modifications_and_removals() {
    let f = Fixture::new();
    f.fs.file("a.md", b"1");
    f.fs.file("dir/b.md", b"2");
    f.fs.file("gone.md", b"3");
    f.scan();
    f.hash_all();

    f.fs.file("a.md", b"11");
    f.fs.remove("gone.md");
    f.fs.file("dir/new.md", b"4");
    let report = f.scan();
    assert_eq!(
        report.changes,
        [
            Change::Modified(path("a.md")),
            Change::Removed(path("gone.md")),
            Change::Added(path("dir/new.md")),
        ]
    );
    assert_eq!(f.entry("a.md").record.hash, None);
    assert_eq!(f.entry("a.md").record.size, 2);
    assert_eq!(f.entry("dir/b.md").record.hash, Some(ContentHash::of(b"2")));

    // A folder that became a file is a new entry.
    f.fs.remove("dir");
    f.fs.file("dir", b"now a file");
    let report = f.scan();
    assert_eq!(
        report.changes,
        [
            Change::Removed(path("dir")),
            Change::Removed(path("dir/b.md")),
            Change::Removed(path("dir/new.md")),
            Change::Added(path("dir")),
        ]
    );
    assert_eq!(f.entry("dir").record.kind, EntryKind::File);
}

#[test]
fn moves_keep_entry_ids_hashes_and_descendants() {
    let f = Fixture::new();
    for file in [
        "2026 秋/线代/hw1.pdf",
        "2026 秋/线代/notes.md",
        "x.md",
        "p.md",
        "q.md",
    ] {
        f.fs.file(file, file.as_bytes());
    }
    f.scan();
    f.hash_all();
    let before: BTreeMap<String, EntryId> = f
        .entries()
        .into_iter()
        .map(|entry| (entry.record.path.to_string(), entry.id))
        .collect();

    f.fs.rename("2026 秋/线代", "2026 秋/线性代数");
    f.fs.rename("x.md", "X.md");
    f.fs.rename("p.md", "t.md");
    f.fs.rename("q.md", "p.md");
    f.fs.rename("t.md", "q.md");
    let report = f.scan();
    let moved = |from: &str, to: &str| Change::Moved {
        from: path(from),
        to: path(to),
    };
    let mut changes = report.changes.clone();
    changes.sort();
    let mut expected = vec![
        moved("2026 秋/线代", "2026 秋/线性代数"),
        moved("2026 秋/线代/hw1.pdf", "2026 秋/线性代数/hw1.pdf"),
        moved("2026 秋/线代/notes.md", "2026 秋/线性代数/notes.md"),
        moved("x.md", "X.md"),
        moved("p.md", "q.md"),
        moved("q.md", "p.md"),
    ];
    expected.sort();
    assert_eq!(changes, expected);

    for (from, to) in [
        ("2026 秋/线代", "2026 秋/线性代数"),
        ("2026 秋/线代/hw1.pdf", "2026 秋/线性代数/hw1.pdf"),
        ("x.md", "X.md"),
        ("p.md", "q.md"),
        ("q.md", "p.md"),
    ] {
        assert_eq!(f.entry(to).id, before[from], "{from} → {to}");
    }
    let hw1 = f.entry("2026 秋/线性代数/hw1.pdf").record;
    assert_eq!(
        hw1.hash,
        Some(ContentHash::of("2026 秋/线代/hw1.pdf".as_bytes()))
    );
    // Parents follow: the moved file lists under its new folder.
    let children = f
        .catalog
        .read(|tx| catalog::children(tx, Some(&path("2026 秋/线性代数"))))
        .unwrap();
    assert_eq!(children.len(), 2);
}

#[test]
fn entries_without_ids_follow_a_moved_folder() {
    let f = Fixture::new();
    f.fs.file("a/x.md", b"x");
    f.fs.file("loose.md", b"y");
    f.fs.without_id("a/x.md");
    f.fs.without_id("loose.md");
    f.scan();
    let x = f.entry("a/x.md").id;

    f.fs.rename("a", "b");
    f.fs.rename("loose.md", "found.md");
    let report = f.scan();
    assert_eq!(f.entry("b/x.md").id, x);
    assert!(report.changes.contains(&Change::Moved {
        from: path("a/x.md"),
        to: path("b/x.md")
    }));
    // Without an id, a renamed file is a new one.
    assert!(report.changes.contains(&Change::Removed(path("loose.md"))));
    assert!(report.changes.contains(&Change::Added(path("found.md"))));
}

#[test]
fn entries_under_a_folder_replaced_by_another_get_the_new_parent() {
    let f = Fixture::new();
    f.fs.file("s/a/sub/x.md", b"1");
    f.fs.file("s/b/y.md", b"2");
    f.scan();
    let sub = f.entry("s/a/sub").id;
    let b = f.entry("s/b").id;

    // `s/a` goes, `s/b` takes its name, and a new `sub` appears in it.
    f.fs.remove("s/a");
    f.fs.rename("s/b", "s/a");
    f.fs.file("s/a/sub/new.md", b"3");
    let report = f.scan();
    assert!(report.changes.contains(&Change::Moved {
        from: path("s/b"),
        to: path("s/a")
    }));
    assert_eq!((f.entry("s/a").id, f.entry("s/a/sub").id), (b, sub));
    let children = f
        .catalog
        .read(|tx| catalog::children(tx, Some(&path("s/a"))))
        .unwrap();
    let names: Vec<_> = children
        .iter()
        .map(|entry| entry.record.path.name())
        .collect();
    assert_eq!(names, ["sub", "y.md"]);
}

#[test]
fn entries_kept_below_a_folder_that_cannot_be_listed_get_the_folder_that_took_its_name() {
    let f = Fixture::new();
    f.fs.file("s/a/sub/x.md", b"1");
    f.fs.folder("s/b");
    f.scan();
    let sub = f.entry("s/a/sub").id;
    let b = f.entry("s/b").id;

    // `s/a` goes and `s/b` takes its name, but cannot be listed: what was below `s/a` stays.
    f.fs.remove("s/a");
    f.fs.rename("s/b", "s/a");
    f.fs.fail_listing("s/a");
    let report = f.scan();
    assert!(matches!(
        &report.problems[..],
        [Problem::Unreadable { path: folder, .. }] if *folder == path("s/a")
    ));
    assert_eq!(f.paths(), ["s", "s/a", "s/a/sub", "s/a/sub/x.md"]);
    assert_eq!((f.entry("s/a").id, f.entry("s/a/sub").id), (b, sub));
    let children = f
        .catalog
        .read(|tx| catalog::children(tx, Some(&path("s/a"))))
        .unwrap();
    let ids: Vec<_> = children.iter().map(|entry| entry.id).collect();
    assert_eq!(ids, [sub]);
}

#[test]
fn a_file_saved_through_a_temporary_file_is_modified_not_moved() {
    let f = Fixture::new();
    f.fs.file("r.docx", b"v1");
    f.scan();
    f.hash_all();
    set_tags(f.layout(), "r.docx", EntryKind::File, tags(["homework"]));
    let before = f.entry("r.docx");

    f.fs.replace("r.docx", b"v2");
    let report = f.scan();
    assert_eq!(report.changes, [Change::Modified(path("r.docx"))]);
    let after = f.entry("r.docx");
    assert_eq!(after.id, before.id);
    assert_eq!(after.record.hash, None);
    assert_ne!(after.record.file_id, before.record.file_id);
    assert_eq!(after.added_ns, before.added_ns);
    assert_eq!(f.tags("r.docx"), ["homework"]);
}

#[test]
fn tags_follow_files_inside_a_course_and_between_courses() {
    let f = Fixture::new();
    f.fs.file("2026 秋/线代/hw1.pdf", b"1");
    f.fs.file("2026 秋/线代/notes.md", b"2");
    f.fs.folder("2026 秋/数据结构");
    f.scan();
    set_course(f.layout(), "2026 秋/线代", settings("线代", 1));
    set_tags(
        f.layout(),
        "2026 秋/线代/hw1.pdf",
        EntryKind::File,
        tags(["homework"]),
    );
    set_tags(
        f.layout(),
        "2026 秋/线代/notes.md",
        EntryKind::File,
        tags(["notes"]),
    );
    f.scan();
    assert_eq!(f.tags("2026 秋/线代/hw1.pdf"), ["homework"]);

    f.fs.rename("2026 秋/线代/hw1.pdf", "2026 秋/线代/作业/hw1.pdf");
    f.fs.rename("2026 秋/线代/notes.md", "2026 秋/数据结构/notes.md");
    let report = f.scan();
    assert_eq!(report.problems, []);
    assert_eq!(f.tags("2026 秋/线代/作业/hw1.pdf"), ["homework"]);
    assert_eq!(f.tags("2026 秋/数据结构/notes.md"), ["notes"]);

    let linear = f
        .layout()
        .read_course_meta(&course_at("2026 秋/线代"))
        .unwrap()
        .unwrap();
    assert_eq!(linear.course, Some(settings("线代", 1)));
    assert_eq!(
        linear
            .tags
            .iter()
            .map(|(key, _)| key.as_str())
            .collect::<Vec<_>>(),
        ["作业/hw1.pdf"]
    );
    // The other course had no file: it gets one with tags and without settings.
    let structures = f
        .layout()
        .read_course_meta(&course_at("2026 秋/数据结构"))
        .unwrap()
        .unwrap();
    assert_eq!(structures.course, None);
    assert_eq!(
        structures.tags.get(&path("notes.md")),
        Some(&tags(["notes"]))
    );
}

#[test]
fn settings_and_tags_follow_renamed_courses_and_semesters() {
    let f = Fixture::new();
    f.fs.file("2026 秋/线代/hw1.pdf", b"1");
    f.fs.file("2026 秋/syllabus.pdf", b"2");
    f.scan();
    let group = GroupMeta {
        group: Some(GroupSettings {
            archived: false,
            order: 2,
        }),
        ..GroupMeta::default()
    };
    f.layout()
        .write_group_meta(&semester("2026 秋"), &group)
        .unwrap();
    set_tags(
        f.layout(),
        "2026 秋/syllabus.pdf",
        EntryKind::File,
        tags(["reference"]),
    );
    set_course(f.layout(), "2026 秋/线代", settings("线代", 1));
    set_tags(
        f.layout(),
        "2026 秋/线代/hw1.pdf",
        EntryKind::File,
        tags(["homework"]),
    );

    f.fs.rename("2026 秋/线代", "2026 秋/线性代数");
    f.scan();
    assert_eq!(f.tags("2026 秋/线性代数/hw1.pdf"), ["homework"]);
    assert!(!course_file(f.layout(), "2026 秋/线代").exists());

    f.fs.rename("2026 秋", "2026 Fall");
    let report = f.scan();
    assert_eq!(report.problems, []);
    assert_eq!(f.tags("2026 Fall/线性代数/hw1.pdf"), ["homework"]);
    assert_eq!(f.tags("2026 Fall/syllabus.pdf"), ["reference"]);
    let stored = f.catalog.read(|tx| semesters(tx)).unwrap();
    assert_eq!(
        stored,
        [(semester("2026 Fall"), group.group.clone().unwrap())]
    );
    let courses = f.catalog.read(|tx| all_courses(tx)).unwrap();
    assert_eq!(
        courses,
        [(course_at("2026 Fall/线性代数"), settings("线代", 1))]
    );
    // Nothing is left behind under the old names.
    let meta: Vec<_> = std_fs::read_dir(f.layout().meta_dir())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(meta, ["2026 Fall"]);
}

#[test]
fn a_change_of_case_renames_the_metadata_files() {
    let f = Fixture::new();
    f.fs.file("fall/Linear/hw1.pdf", b"1");
    f.scan();
    set_course(f.layout(), "fall/Linear", settings("LA", 1));
    set_tags(
        f.layout(),
        "fall/Linear/hw1.pdf",
        EntryKind::File,
        tags(["homework"]),
    );
    let group = GroupMeta {
        group: Some(GroupSettings {
            archived: true,
            order: 1,
        }),
        ..GroupMeta::default()
    };
    f.layout()
        .write_group_meta(&semester("fall"), &group)
        .unwrap();

    f.fs.rename("fall/Linear", "fall/linear");
    f.fs.rename("fall", "Fall");
    let report = f.scan();
    assert_eq!(report.problems, []);
    assert_eq!(f.tags("Fall/linear/hw1.pdf"), ["homework"]);
    let names: Vec<_> = std_fs::read_dir(f.layout().meta_dir().join("Fall"))
        .unwrap()
        .map(|entry| entry.unwrap().file_name().into_string().unwrap())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    assert_eq!(names, ["_group.json", "linear.json"]);
    // Exact names: on NTFS, `fall` finds `Fall` too.
    let semesters: Vec<_> = std_fs::read_dir(f.layout().meta_dir())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(semesters, ["Fall"]);
    assert_eq!(
        f.catalog.read(|tx| all_courses(tx)).unwrap(),
        [(course_at("Fall/linear"), settings("LA", 1))]
    );
}

#[test]
fn a_course_moved_into_another_keeps_its_tags_and_leaves_its_settings() {
    let f = Fixture::new();
    f.fs.file("s/a/x.md", b"1");
    f.fs.file("s/b/y.md", b"2");
    f.fs.file("root.md", b"3");
    f.scan();
    set_course(f.layout(), "s/a", settings("A", 1));
    set_tags(f.layout(), "s/a/x.md", EntryKind::File, tags(["notes"]));
    set_tags(f.layout(), "root.md", EntryKind::File, tags(["exam"]));

    f.fs.rename("s/a", "s/b/a");
    f.fs.rename("root.md", "s/b/root.md");
    let report = f.scan();
    assert_eq!(
        report.problems,
        [Problem::OrphanedMetadata {
            folder: path("s/a")
        }]
    );
    assert_eq!(f.tags("s/b/a/x.md"), ["notes"]);
    assert_eq!(f.tags("s/b/root.md"), ["exam"]);
    // The settings stay where they were, to reattach or delete; the tags moved out.
    let old = f
        .layout()
        .read_course_meta(&course_at("s/a"))
        .unwrap()
        .unwrap();
    assert_eq!((old.course, old.tags.len()), (Some(settings("A", 1)), 0));
    assert!(f.layout().read_root_meta().unwrap().is_none());
}

#[test]
fn tags_on_folders_that_become_courses_stay_behind() {
    let f = Fixture::new();
    f.fs.file("s/c/sub/x.md", b"1");
    f.scan();
    set_tags(f.layout(), "s/c/sub", EntryKind::Folder, tags(["notes"]));
    f.fs.rename("s/c/sub", "s/sub");
    let report = f.scan();
    assert_eq!(
        report.problems,
        [Problem::NotRelocated {
            from: path("s/c/sub"),
            to: path("s/sub"),
            cause: StrandedCause::FolderTags,
        }]
    );
    let course = f
        .layout()
        .read_course_meta(&course_at("s/c"))
        .unwrap()
        .unwrap();
    assert_eq!(course.tags.get(&path("sub")), Some(&tags(["notes"])));
}

#[test]
fn metadata_that_cannot_be_read_is_never_written() {
    let f = Fixture::new();
    f.fs.file("s/c/hw1.pdf", b"1");
    f.scan();
    let file = course_file(f.layout(), "s/c");
    std_fs::create_dir_all(file.parent().unwrap()).unwrap();
    std_fs::write(&file, "{").unwrap();

    f.fs.rename("s/c/hw1.pdf", "s/c/hw2.pdf");
    let report = f.scan();
    assert!(
        report.problems.iter().any(|problem| matches!(
            problem,
            Problem::NotRelocated { from, .. } if *from == path("s/c/hw1.pdf")
        )),
        "{:?}",
        report.problems
    );
    assert!(report.problems.iter().any(|problem| matches!(
        problem,
        Problem::Metadata {
            failure: MetadataFailure::Invalid,
            ..
        }
    )));
    assert_eq!(std_fs::read_to_string(&file).unwrap(), "{");
}

#[test]
fn a_newer_metadata_file_makes_all_of_them_read_only() {
    let f = Fixture::new();
    f.fs.file("s/c/hw1.pdf", b"1");
    f.scan();
    set_tags(
        f.layout(),
        "s/c/hw1.pdf",
        EntryKind::File,
        tags(["homework"]),
    );
    std_fs::write(
        f.layout().tags_file(),
        r#"{"format_version": 2, "tags": {}}"#,
    )
    .unwrap();
    let before = std_fs::read(course_file(f.layout(), "s/c")).unwrap();

    f.fs.rename("s/c/hw1.pdf", "s/c/hw2.pdf");
    let report = f.scan();
    assert!(report.problems.contains(&Problem::NotRelocated {
        from: path("s/c/hw1.pdf"),
        to: path("s/c/hw2.pdf"),
        cause: StrandedCause::ReadOnly,
    }));
    assert!(report.problems.iter().any(|problem| matches!(
        problem,
        Problem::Metadata {
            failure: MetadataFailure::Newer,
            ..
        }
    )));
    assert_eq!(
        std_fs::read(course_file(f.layout(), "s/c")).unwrap(),
        before
    );
    // The catalog still has the definitions from before.
    assert_eq!(
        f.catalog.read(|tx| tag_definitions(tx)).unwrap(),
        presets("课件")
    );
}

#[test]
fn mirrors_definitions_settings_and_tags() {
    let f = Fixture::new();
    f.fs.file("2026 秋/syllabus.pdf", b"1");
    f.fs.file("2026 秋/线代/作业/hw1.pdf", b"2");
    f.fs.folder("2027 春");
    f.fs.file("readme.md", b"3");
    f.scan();
    let group = GroupSettings {
        archived: false,
        order: 1,
    };
    let mut group_meta = GroupMeta {
        group: Some(group.clone()),
        ..GroupMeta::default()
    };
    group_meta
        .tags
        .set(path("syllabus.pdf"), tags(["reference"]));
    // A course folder carries no tags, so this key is ignored.
    group_meta.tags.set(path("线代"), tags(["notes"]));
    f.layout()
        .write_group_meta(&semester("2026 秋"), &group_meta)
        .unwrap();
    set_course(f.layout(), "2026 秋/线代", settings("线代", 1));
    set_tags(
        f.layout(),
        "2026 秋/线代/作业/hw1.pdf",
        EntryKind::File,
        tags(["homework"]),
    );
    set_tags(
        f.layout(),
        "readme.md",
        EntryKind::File,
        tags(["notes", "exam"]),
    );
    set_course(f.layout(), "2026 秋/gone", settings("G", 2));

    let report = f.scan();
    assert_eq!(
        report.problems,
        [Problem::OrphanedMetadata {
            folder: path("2026 秋/gone")
        }]
    );
    assert_eq!(
        f.catalog.read(|tx| semesters(tx)).unwrap(),
        [(semester("2026 秋"), group)]
    );
    assert_eq!(
        f.catalog.read(|tx| all_courses(tx)).unwrap(),
        [(course_at("2026 秋/线代"), settings("线代", 1))]
    );
    assert_eq!(f.tags("2026 秋/syllabus.pdf"), ["reference"]);
    assert_eq!(f.tags("2026 秋/线代"), Vec::<String>::new());
    assert_eq!(f.tags("2026 秋/线代/作业/hw1.pdf"), ["homework"]);
    assert_eq!(f.tags("readme.md"), ["exam", "notes"]);

    // Changes outside Folio reach the catalog through `sync_metadata`.
    std_fs::remove_file(course_file(f.layout(), "2026 秋/线代")).unwrap();
    f.layout().write_tags(&presets("幻灯片")).unwrap();
    let problems = f.library.sync_metadata(&f.catalog).unwrap();
    assert_eq!(
        problems,
        [Problem::OrphanedMetadata {
            folder: path("2026 秋/gone")
        }]
    );
    assert_eq!(f.catalog.read(|tx| all_courses(tx)).unwrap(), []);
    assert_eq!(f.tags("2026 秋/线代/作业/hw1.pdf"), Vec::<String>::new());
    assert_eq!(
        f.catalog.read(|tx| tag_definitions(tx)).unwrap(),
        presets("幻灯片")
    );
}

/// What a scan's relocation writes, without the catalog update that would follow: a crash
/// between the two.
fn crash_after_metadata(f: &Fixture, moves: &[(&str, &str)]) {
    let moves: Moves = moves
        .iter()
        .map(|(from, to)| (path(from), (path(to), EntryKind::File)))
        .collect();
    let mut tree = MetaTree::read(f.layout()).unwrap();
    assert_eq!(tree.relocate(&moves), []);
    assert!(tree.save(f.layout()).unwrap().is_some());
}

#[test]
fn a_scan_after_a_crash_undoes_and_redoes_the_moves() {
    let f = Fixture::new();
    f.fs.file("s/a/x.pdf", b"1");
    f.fs.file("s/b/y.pdf", b"2");
    f.scan();
    set_tags(f.layout(), "s/a/x.pdf", EntryKind::File, tags(["homework"]));
    set_tags(f.layout(), "s/b/y.pdf", EntryKind::File, tags(["notes"]));
    f.scan();

    // The two files swap places, and the scan stops after the metadata files; moving the
    // tags again would swap them back.
    f.fs.rename("s/a/x.pdf", "s/t.pdf");
    f.fs.rename("s/b/y.pdf", "s/a/x.pdf");
    f.fs.rename("s/t.pdf", "s/b/y.pdf");
    crash_after_metadata(
        &f,
        &[("s/a/x.pdf", "s/b/y.pdf"), ("s/b/y.pdf", "s/a/x.pdf")],
    );
    assert!(f.layout().scan_journal_file().exists());

    let report = f.scan();
    assert_eq!(report.problems, []);
    assert_eq!(f.tags("s/b/y.pdf"), ["homework"]);
    assert_eq!(f.tags("s/a/x.pdf"), ["notes"]);
    assert!(!f.layout().scan_journal_file().exists());
}

#[test]
fn a_scan_after_a_crash_finishes_half_written_moves() {
    let f = Fixture::new();
    f.fs.file("s/a/x.pdf", b"1");
    f.fs.folder("s/b");
    f.scan();
    set_tags(f.layout(), "s/a/x.pdf", EntryKind::File, tags(["homework"]));
    let source = std_fs::read(course_file(f.layout(), "s/a")).unwrap();

    // Moving to another course writes two files; the crash comes after the first.
    f.fs.rename("s/a/x.pdf", "s/b/x.pdf");
    crash_after_metadata(&f, &[("s/a/x.pdf", "s/b/x.pdf")]);
    std_fs::write(course_file(f.layout(), "s/a"), &source).unwrap();

    let report = f.scan();
    assert_eq!(report.problems, []);
    assert_eq!(f.tags("s/b/x.pdf"), ["homework"]);
    assert!(!course_file(f.layout(), "s/a").exists());
}

#[test]
fn syncing_the_metadata_settles_an_interrupted_scan_first() {
    let f = Fixture::new();
    f.fs.file("s/c/hw1.pdf", b"1");
    f.scan();
    set_tags(
        f.layout(),
        "s/c/hw1.pdf",
        EntryKind::File,
        tags(["homework"]),
    );
    f.scan();
    f.fs.rename("s/c/hw1.pdf", "s/c/hw2.pdf");
    crash_after_metadata(&f, &[("s/c/hw1.pdf", "s/c/hw2.pdf")]);

    assert_eq!(f.library.sync_metadata(&f.catalog).unwrap(), []);
    assert_eq!(f.tags("s/c/hw1.pdf"), ["homework"]);
    assert!(!f.layout().scan_journal_file().exists());
    assert_eq!(f.scan().problems, []);
    assert_eq!(f.tags("s/c/hw2.pdf"), ["homework"]);
}

#[test]
fn a_journal_whose_scan_committed_is_removed_not_undone() {
    let f = Fixture::new();
    f.fs.file("s/c/hw1.pdf", b"1");
    f.scan();
    set_tags(
        f.layout(),
        "s/c/hw1.pdf",
        EntryKind::File,
        tags(["homework"]),
    );
    f.fs.rename("s/c/hw1.pdf", "s/c/hw2.pdf");
    f.scan();
    let moved = std_fs::read(course_file(f.layout(), "s/c")).unwrap();

    // The scan committed but could not remove its journal.
    let id = f
        .catalog
        .read(|tx| catalog::committed_scan_journal(tx))
        .unwrap()
        .unwrap();
    let journal =
        format!(r#"{{"format_version": 1, "id": "{id}", "before": [["s/c.json", "{{}}"]]}}"#);
    std_fs::create_dir_all(f.layout().scan_journal_file().parent().unwrap()).unwrap();
    std_fs::write(f.layout().scan_journal_file(), journal).unwrap();

    assert_eq!(f.scan().problems, []);
    assert_eq!(std_fs::read(course_file(f.layout(), "s/c")).unwrap(), moved);
    assert!(!f.layout().scan_journal_file().exists());
    assert_eq!(f.tags("s/c/hw2.pdf"), ["homework"]);
}

#[test]
fn a_journal_that_names_other_files_stops_the_scan_and_touches_nothing() {
    let f = Fixture::new();
    f.fs.file("s/c/hw1.pdf", b"1");
    f.scan();
    // `.folio/meta/` is three folders below the temporary folder.
    let outside = f.library.root().parent().unwrap().join("outside.txt");
    std_fs::write(&outside, "keep").unwrap();

    for file in [
        "../../../outside.txt",
        "s/../../../../outside.txt",
        "..\\..\\..\\outside.txt",
        "s/..\\..\\..\\..\\outside.txt",
        &outside.to_string_lossy(),
        "C:\\outside.txt",
        "\\\\server\\share\\outside.txt",
        "s/c.json/../../../../outside.txt",
        "s/_c.json",
        "_s/c.json",
        "s/c.JSON",
        "",
    ] {
        for content in [None, Some("planted")] {
            let journal = serde_json::json!({
                "format_version": 1,
                "id": "planted",
                "before": [["s/c.json", "{}"], [file, content]],
            });
            std_fs::create_dir_all(f.layout().scan_journal_file().parent().unwrap()).unwrap();
            std_fs::write(f.layout().scan_journal_file(), journal.to_string()).unwrap();
            let error = f.library.scan(&f.catalog, None, f.fs.now_ns()).unwrap_err();
            assert!(
                matches!(error, LibraryError::Meta(MetaError::Invalid { .. })),
                "{file:?}: {error}"
            );
            assert_eq!(std_fs::read_to_string(&outside).unwrap(), "keep");
            assert!(!course_file(f.layout(), "s/c").exists(), "{file:?}");
        }
    }

    // A rebuild starts from a new catalog, which the journal does not stand in the way of.
    let dir = tempfile::tempdir().unwrap();
    assert_eq!(f.scan_into(&open_catalog(dir.path())).problems, []);
    assert!(!f.layout().scan_journal_file().exists());
    assert_eq!(std_fs::read_to_string(&outside).unwrap(), "keep");
}

#[test]
fn metadata_that_differs_in_case_still_follows_moves() {
    let f = Fixture::new();
    f.fs.file("Fall/线代/hw1.pdf", b"1");
    f.scan();
    // Written by another device, say, with other cases than the disk has.
    let mut course = CourseMeta {
        course: Some(settings("线", 1)),
        ..CourseMeta::default()
    };
    course.tags.set(path("HW1.pdf"), tags(["homework"]));
    f.layout()
        .write_course_meta(&course_at("fall/线代"), &course)
        .unwrap();
    assert_eq!(f.scan().problems, []);
    assert_eq!(f.tags("Fall/线代/hw1.pdf"), ["homework"]);

    f.fs.rename("Fall/线代/hw1.pdf", "Fall/线代/作业/hw1.pdf");
    f.fs.rename("Fall", "Spring");
    let report = f.scan();
    assert_eq!(report.problems, []);
    assert_eq!(f.tags("Spring/线代/作业/hw1.pdf"), ["homework"]);
    assert_eq!(
        f.catalog.read(|tx| all_courses(tx)).unwrap(),
        [(course_at("Spring/线代"), settings("线", 1))]
    );
}

#[test]
fn of_two_files_that_name_one_folder_the_one_spelled_like_it_holds_moved_tags() {
    let f = Fixture::new();
    f.fs.file("s/C1/a.txt", b"1");
    f.scan();
    let mut exact = CourseMeta::default();
    exact.tags.set(path("a.txt"), tags(["homework"]));
    f.layout()
        .write_course_meta(&course_at("s/C1"), &exact)
        .unwrap();
    let stray = CourseMeta {
        course: Some(settings("C", 1)),
        ..CourseMeta::default()
    };
    f.layout()
        .write_course_meta(&course_at("s/c1"), &stray)
        .unwrap();
    let semester = course_file(f.layout(), "s/C1");
    if std_fs::read_dir(semester.parent().unwrap())
        .unwrap()
        .count()
        < 2
    {
        // Only a disk that tells case apart holds both files: there is nothing to choose.
        return;
    }
    let orphaned = [Problem::OrphanedMetadata {
        folder: path("s/c1"),
    }];
    assert_eq!(f.scan().problems, orphaned);
    assert_eq!(f.tags("s/C1/a.txt"), ["homework"]);

    f.fs.rename("s/C1/a.txt", "s/C1/b.txt");
    assert_eq!(f.scan().problems, orphaned);
    assert_eq!(f.tags("s/C1/b.txt"), ["homework"]);
    let read = |course| std_fs::read_to_string(course_file(f.layout(), course)).unwrap();
    assert!(read("s/C1").contains("b.txt"));
    assert!(!read("s/c1").contains("b.txt"));
}

#[test]
fn entries_below_a_moved_folder_that_cannot_be_listed_move_with_it() {
    let f = Fixture::new();
    f.fs.file("a/u/x.txt", b"1");
    f.scan();
    let x = f.entry("a/u/x.txt").id;

    f.fs.rename("a", "b");
    f.fs.fail_listing("b/u");
    let report = f.scan();
    assert!(matches!(
        &report.problems[..],
        [Problem::Unreadable { path: folder, .. }] if *folder == path("b/u")
    ));
    assert_eq!(f.paths(), ["b", "b/u", "b/u/x.txt"]);
    assert_eq!(f.entry("b/u/x.txt").id, x);
}

#[test]
fn a_metadata_file_that_cannot_be_read_keeps_what_it_gave() {
    let f = Fixture::new();
    f.fs.file("s/c/hw1.pdf", b"1");
    f.scan();
    set_course(f.layout(), "s/c", settings("C", 1));
    set_tags(
        f.layout(),
        "s/c/hw1.pdf",
        EntryKind::File,
        tags(["homework"]),
    );
    f.scan();

    std_fs::write(course_file(f.layout(), "s/c"), "{").unwrap();
    let report = f.scan();
    assert!(matches!(
        &report.problems[..],
        [Problem::Metadata {
            failure: MetadataFailure::Invalid,
            ..
        }]
    ));
    assert_eq!(f.tags("s/c/hw1.pdf"), ["homework"]);
    assert_eq!(
        f.catalog.read(|tx| all_courses(tx)).unwrap(),
        [(course_at("s/c"), settings("C", 1))]
    );
}

#[test]
fn entries_are_dated_by_their_files_first_and_by_the_scan_later() {
    let f = Fixture::new();
    f.fs.file("old.md", b"1");
    let created =
        f.fs.metadata(&f.library.root().join("old.md"))
            .unwrap()
            .created_ns
            .unwrap();
    f.scan();
    assert_eq!(f.entry("old.md").added_ns, created);

    f.fs.file("new.md", b"2");
    let now = f.fs.now_ns() + 5_000_000_000;
    f.library.scan(&f.catalog, None, now).unwrap();
    assert_eq!(f.entry("new.md").added_ns, now);

    // Moving keeps the entry, and with it the time.
    f.fs.rename("old.md", "moved.md");
    f.scan();
    assert_eq!(f.entry("moved.md").added_ns, created);
}

#[test]
fn a_library_that_started_empty_dates_what_comes_in_by_the_scan() {
    let f = Fixture::new();
    f.scan();
    // Moved in from elsewhere on the volume, with its old creation time.
    f.fs.file("moved in.md", b"1");
    let now = f.fs.now_ns() + 5_000_000_000;
    f.library.scan(&f.catalog, None, now).unwrap();
    assert_eq!(f.entry("moved in.md").added_ns, now);
}

#[test]
fn tags_whose_new_path_would_be_too_long_are_reported() {
    let f = Fixture::new();
    f.fs.folder("s/c");
    f.scan();
    // A tag for a file that has not arrived yet, 32,634 UTF-16 units from the root.
    let deep = vec!["a".repeat(250); 130].join("/");
    set_tags(
        f.layout(),
        &format!("s/c/{deep}"),
        EntryKind::File,
        tags(["notes"]),
    );

    let long = format!("s/{}", "c".repeat(255));
    f.fs.rename("s/c", &long);
    let report = f.scan();
    // The tag stays in the file of the old course name, which no folder has now.
    assert_eq!(
        report.problems,
        [
            Problem::NotRelocated {
                from: path(&format!("s/c/{deep}")),
                to: path(&long),
                cause: StrandedCause::TooLong,
            },
            Problem::OrphanedMetadata {
                folder: path("s/c")
            },
        ]
    );
}

#[test]
fn hashes_files_defers_fresh_ones_and_resumes() {
    let f = Fixture::new();
    f.fs.file("a.md", b"a");
    f.fs.file("b.md", b"b");
    f.scan();
    let mut calls = Vec::new();
    let now = f.fs.now_ns() + 1_500_000_000;
    let report = f
        .library
        .hash_pending(
            &f.catalog,
            now,
            &AtomicBool::new(false),
            &mut |done, total| calls.push((done, total)),
        )
        .unwrap();
    // `b.md` was written 1.5 seconds before `now`, `a.md` a second earlier.
    assert_eq!((report.hashed, report.deferred), (1, 1));
    assert_eq!(calls, [(1, 2), (2, 2)]);
    assert_eq!(f.entry("a.md").record.hash, Some(ContentHash::of(b"a")));
    assert_eq!(f.entry("b.md").record.hash, None);

    let report = f.hash_all();
    assert_eq!((report.hashed, report.deferred), (1, 0));
    assert_eq!(f.entry("b.md").record.hash, Some(ContentHash::of(b"b")));
    assert_eq!(f.hash_all(), HashReport::default());
}

#[test]
fn files_that_change_or_cannot_be_read_stay_pending() {
    let f = Fixture::new();
    f.fs.file("moving.md", b"a");
    f.fs.file("locked.md", b"b");
    f.fs.file("gone.md", b"c");
    f.scan();
    f.fs.change_while_read("moving.md");
    f.fs.fail_reading("locked.md");
    f.fs.remove("gone.md");

    let report = f.hash_all();
    assert_eq!(report.hashed, 0);
    assert!(matches!(
        &report.problems[..],
        [Problem::Unreadable { path: file, .. }] if *file == path("locked.md")
    ));
    for file in ["moving.md", "locked.md", "gone.md"] {
        assert_eq!(f.entry(file).record.hash, None, "{file}");
    }
}

#[test]
fn cancelling_keeps_what_was_hashed() {
    let f = Fixture::new();
    for file in ["a.md", "b.md", "c.md"] {
        f.fs.file(file, file.as_bytes());
    }
    f.scan();
    let cancel = AtomicBool::new(false);
    let later = f.fs.now_ns() + 10_000_000_000;
    let report = f
        .library
        .hash_pending(&f.catalog, later, &cancel, &mut |_, _| {
            cancel.store(true, Ordering::Relaxed)
        })
        .unwrap();
    assert!(report.cancelled);
    assert_eq!(report.hashed, 1);
    assert_eq!(f.hash_all().hashed, 2);
}

#[test]
fn a_scoped_scan_changes_only_its_folder() {
    let f = Fixture::new();
    f.fs.file("a/x.md", b"1");
    f.fs.file("b/y.md", b"2");
    f.scan();
    f.fs.file("a/x.md", b"11");
    f.fs.file("b/y.md", b"22");
    f.fs.file("a/new/deep.md", b"3");

    let report = f.scan_in("a/new/deep.md");
    assert_eq!(
        report.changes,
        [
            Change::Modified(path("a/x.md")),
            Change::Added(path("a/new")),
            Change::Added(path("a/new/deep.md")),
        ]
    );
    assert_eq!(f.entry("b/y.md").record.size, 1);
}

#[test]
fn a_scope_that_is_gone_ignored_or_unknown_is_handled() {
    let f = Fixture::new();
    f.fs.file("a/b/x.md", b"1");
    f.fs.file("c/y.md", b"2");
    f.scan();

    f.fs.fail_listing("a");
    let report = f.scan_in("a/b");
    assert_eq!(report.changes, []);
    assert!(matches!(&report.problems[..], [Problem::Unreadable { .. }]));

    f.write_ignore("c/\n");
    let report = f.scan_in("c");
    assert_eq!(
        report.changes,
        [Change::Removed(path("c")), Change::Removed(path("c/y.md"))]
    );

    f.fs.remove("a");
    let report = f.scan_in("a/b");
    assert_eq!(
        report.changes,
        [
            Change::Removed(path("a/b")),
            Change::Removed(path("a/b/x.md"))
        ]
    );
    assert_eq!(
        f.library
            .scan(&f.catalog, Some(&path(".folio/meta")), f.fs.now_ns())
            .unwrap(),
        ScanReport::default()
    );
}

#[test]
fn scans_and_hashes_a_real_folder() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("library");
    let library = Library::new(&root, Arc::new(StdFileSystem));
    write_config(library.layout());
    std_fs::create_dir_all(root.join("2026 秋/线代")).unwrap();
    std_fs::write(root.join("2026 秋/线代/笔记.md"), "# 特征值").unwrap();
    std_fs::write(root.join("Thumbs.db"), "x").unwrap();
    let catalog = open_catalog(dir.path());

    let report = library.scan(&catalog, None, 0).unwrap();
    assert_eq!(report.problems, []);
    let paths: Vec<String> = catalog
        .read(|tx| entries_in(tx, None))
        .unwrap()
        .into_iter()
        .map(|entry| entry.record.path.to_string())
        .collect();
    assert_eq!(paths, ["2026 秋", "2026 秋/线代", "2026 秋/线代/笔记.md"]);

    let far_future = i64::MAX;
    let report = library
        .hash_pending(
            &catalog,
            far_future,
            &AtomicBool::new(false),
            &mut |_, _| {},
        )
        .unwrap();
    assert_eq!(report.hashed, 1);
    let notes = catalog
        .read(|tx| entry(tx, &path("2026 秋/线代/笔记.md")))
        .unwrap()
        .unwrap();
    assert_eq!(
        notes.record.hash,
        Some(ContentHash::of("# 特征值".as_bytes()))
    );

    std_fs::write(root.join("2026 秋/线代/笔记.md"), "# 特征值与特征向量").unwrap();
    std_fs::rename(root.join("2026 秋/线代"), root.join("2026 秋/线性代数")).unwrap();
    let mut changes = library.scan(&catalog, None, 0).unwrap().changes;
    changes.sort();
    // Without file ids, a renamed folder is a new one.
    assert_eq!(
        changes,
        [
            Change::Added(path("2026 秋/线性代数")),
            Change::Added(path("2026 秋/线性代数/笔记.md")),
            Change::Removed(path("2026 秋/线代")),
            Change::Removed(path("2026 秋/线代/笔记.md")),
        ]
    );
}
