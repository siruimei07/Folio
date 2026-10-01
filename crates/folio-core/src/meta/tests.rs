use std::collections::BTreeSet;
use std::fs;

use proptest::prelude::*;

use super::layout::escape;
use super::*;
use crate::test_support::{course_at, library_id, path, presets, semester, tags};

fn text<T: MetaFile>(value: &T) -> String {
    String::from_utf8(to_bytes(value).unwrap()).unwrap()
}

fn parse<T: MetaFile>(json: &str) -> Result<T, Problem> {
    from_bytes(json.as_bytes())
}

fn invalid<T: MetaFile + std::fmt::Debug>(json: &str) -> String {
    match parse::<T>(json) {
        Err(Problem::Invalid(reason)) => reason,
        other => panic!("expected an invalid file, got {other:?}"),
    }
}

fn course() -> CourseMeta {
    let mut assignments = Assignments::default();
    assignments.set(path("第3讲 特征值.pptx"), tags(["slides"]));
    assignments.set(path("作业/hw2.pdf"), tags(["homework"]));
    assignments.set(path("复习笔记.md"), tags(["notes", "exam"]));
    CourseMeta {
        course: Some(CourseSettings {
            abbr: Some(Abbr::parse("线代").unwrap()),
            archived: false,
            code: None,
            color: Some(Color::parse("blue").unwrap()),
            order: 1,
        }),
        tags: assignments,
    }
}

#[test]
fn scan_journal_reads_prior_versions_and_rejects_invalid_move_pairs() {
    let temp = tempfile::tempdir().unwrap();
    let layout = Layout::new(temp.path());
    fs::create_dir_all(layout.scan_journal_file().parent().unwrap()).unwrap();
    for version in [1, 2] {
        let mut journal = serde_json::json!({"format_version":version,"id":"legacy","before":[["_root.json",null]]});
        if version == 2 {
            journal["moved"] = serde_json::json!(["s/c/a.md", "s/c/b.md"]);
        }
        fs::write(layout.scan_journal_file(), journal.to_string()).unwrap();
        let read = ScanJournal::read(&layout).unwrap().unwrap();
        assert_eq!(read.id(), "legacy");
        assert!(read.move_entries().is_none());
        assert_eq!(read.moved().is_some(), version == 2);
    }
    for (from, to) in [
        (".folio/a", "s/a"),
        ("s/a", ".FOLIO/a"),
        ("s/a", "s/a"),
        ("s/a", "s/a/b"),
    ] {
        let journal =
            serde_json::json!({"format_version":2,"id":"legacy","before":[],"moved":[from,to]});
        fs::write(layout.scan_journal_file(), journal.to_string()).unwrap();
        assert!(matches!(
            ScanJournal::read(&layout),
            Err(MetaError::Invalid { .. })
        ));
        assert_eq!(
            fs::read_to_string(layout.scan_journal_file()).unwrap(),
            journal.to_string()
        );
    }
}

fn move_snapshot(
    id: i64,
    from: &str,
    to: &str,
    kind: EntryKind,
) -> (
    crate::catalog::Entry,
    crate::paths::RelPath,
    crate::fs::Metadata,
) {
    let file = kind == EntryKind::File;
    (
        crate::catalog::Entry {
            id: crate::catalog::EntryId(id),
            added_ns: 7,
            record: crate::catalog::EntryRecord {
                path: path(from),
                kind,
                class: if file {
                    FileClass::Text
                } else {
                    FileClass::Other
                },
                size: if file { 9 } else { 0 },
                mtime_ns: None,
                file_id: None,
                hash: None,
            },
        },
        path(to),
        crate::fs::Metadata {
            kind: if file {
                crate::fs::FileKind::File
            } else {
                crate::fs::FileKind::Folder
            },
            size: if file { 9 } else { 0 },
            modified_ns: None,
            created_ns: None,
            file_id: None,
            presence: crate::fs::Presence::Local,
        },
    )
}

#[test]
fn explicit_case_metadata_renames_have_paired_images_and_restore_twice() {
    for semester_move in [false, true] {
        let temp = tempfile::tempdir().unwrap();
        let layout = Layout::new(temp.path());
        let original = course();
        layout
            .write_course_meta(&course_at("s/c"), &original)
            .unwrap();
        let (from, to, course_target) = if semester_move {
            ("s", "S", "S/c")
        } else {
            ("s/c", "s/C", "s/C")
        };
        let mut snapshots = Vec::new();
        if semester_move {
            snapshots.push(move_snapshot(1, from, to, EntryKind::Folder));
        }
        snapshots.push(move_snapshot(2, "s/c", course_target, EntryKind::Folder));
        snapshots.push(move_snapshot(
            3,
            "s/c/a.md",
            &format!("{course_target}/a.md"),
            EntryKind::File,
        ));
        let moves: Moves = snapshots
            .iter()
            .map(|(entry, target, _)| {
                (
                    entry.record.path.clone(),
                    (target.clone(), entry.record.kind),
                )
            })
            .collect();
        let mut tree = MetaTree::read(&layout).unwrap();
        assert!(tree.relocate(&moves).is_empty());
        tree.save_operation(&layout, &path(from), &path(to), &snapshots)
            .unwrap();
        let encoded: serde_json::Value =
            serde_json::from_slice(&fs::read(layout.scan_journal_file()).unwrap()).unwrap();
        assert_eq!(encoded["before"][0][0], "s/c.json");
        assert_eq!(encoded["after"][0][0], format!("{course_target}.json"));
        let journal = ScanJournal::read(&layout).unwrap().unwrap();
        journal.validate_images(true).unwrap();
        journal.restore(&layout).unwrap();
        assert!(layout.scan_journal_file().exists());
        journal.validate_images(false).unwrap();
        journal.restore(&layout).unwrap();
        assert_eq!(
            layout.read_course_meta(&course_at("s/c")).unwrap(),
            Some(original)
        );
        journal.undo(&layout).unwrap();
        assert!(!layout.scan_journal_file().exists());
    }
}

#[test]
fn oversized_operation_intents_are_rejected_before_publication() {
    let temp = tempfile::tempdir().unwrap();
    let layout = Layout::new(temp.path());
    let mut snapshot = move_snapshot(1, "s/c/a.md", "s/c/b.md", EntryKind::File);
    snapshot.2.file_id = Some("x".repeat(super::MAX_FILE_BYTES as usize));
    let mut tree = MetaTree::read(&layout).unwrap();
    assert!(matches!(
        tree.save_operation(&layout, &path("s/c/a.md"), &path("s/c/b.md"), &[snapshot]),
        Err(MetaError::TooLarge { .. })
    ));
    assert!(!layout.scan_journal_file().exists());
    assert!(!layout.meta_dir().exists());
}

#[test]
fn writes_a_course_file_with_one_line_per_assignment() {
    assert_eq!(
        text(&course()),
        r#"{
  "format_version": 2,
  "course": {
    "abbr": "线代",
    "archived": false,
    "color": "blue",
    "order": 1
  },
  "tags": {
    "作业/hw2.pdf": ["homework"],
    "复习笔记.md": ["exam", "notes"],
    "第3讲 特征值.pptx": ["slides"]
  }
}
"#
    );
}

#[test]
fn writes_library_settings_and_tag_definitions() {
    let library = LibraryConfig {
        id: library_id(),
        name: DisplayName::parse("我的资料").unwrap(),
        versioning: VersioningRules {
            text_extensions: ["txt", "md"]
                .into_iter()
                .map(|extension| Extension::parse(extension).unwrap())
                .collect(),
            text_max_size: 10 * 1024 * 1024,
            word_extensions: [Extension::parse("docx").unwrap()].into(),
        },
    };
    assert_eq!(
        text(&library),
        r#"{
  "format_version": 2,
  "id": "0123456789abcdef0123456789abcdef",
  "name": "我的资料",
  "versioning": {
    "text_extensions": ["md", "txt"],
    "text_max_size": 10485760,
    "word_extensions": ["docx"]
  }
}
"#
    );

    assert_eq!(
        text(&presets("课件")),
        r#"{
  "format_version": 2,
  "tags": {
    "exam": {
      "color": "red",
      "name": "考试",
      "order": 4
    },
    "homework": {
      "color": "orange",
      "name": "作业",
      "order": 3
    },
    "notes": {
      "color": "blue",
      "name": "笔记",
      "order": 1
    },
    "reference": {
      "color": "stone",
      "name": "资料",
      "order": 5
    },
    "slides": {
      "color": "green",
      "name": "课件",
      "order": 2
    }
  }
}
"#
    );
}

#[test]
fn writes_empty_maps_on_one_line() {
    let group = GroupMeta {
        group: Some(GroupSettings {
            archived: true,
            order: 3,
        }),
        tags: Assignments::default(),
    };
    assert_eq!(
        text(&group),
        "{\n  \"format_version\": 2,\n  \"group\": {\n    \"archived\": true,\n    \"order\": 3\n  },\n  \"tags\": {}\n}\n"
    );
    assert_eq!(
        text(&RootMeta::default()),
        "{\n  \"format_version\": 2,\n  \"tags\": {}\n}\n"
    );
}

#[test]
fn every_file_round_trips() {
    assert_eq!(parse::<CourseMeta>(&text(&course())), Ok(course()));
    assert_eq!(
        parse::<TagDefinitions>(&text(&presets("课件"))),
        Ok(presets("课件"))
    );
    let library = LibraryConfig::new(DisplayName::parse("资料").unwrap()).unwrap();
    assert_eq!(parse::<LibraryConfig>(&text(&library)), Ok(library));
}

#[test]
fn both_versions_read_the_current_course_shape() {
    for version in 1..=FORMAT_VERSION {
        let json = format!(
            r#"{{"format_version": {version}, "course": {{"abbr": "CSC", "archived": true,
                 "code": "CSC 148", "color": "stone", "order": 7}}, "tags": {{}}}}"#
        );
        let meta: CourseMeta = parse(&json).unwrap();
        assert_eq!(
            meta.course,
            Some(CourseSettings {
                abbr: Some(Abbr::parse("CSC").unwrap()),
                archived: true,
                code: Some(CourseCode::parse("CSC 148").unwrap()),
                color: Some(Color::parse("stone").unwrap()),
                order: 7,
            })
        );
    }
}

#[test]
fn optional_course_information_is_absent_or_null_and_stays_unstored() {
    for version in 1..=FORMAT_VERSION {
        for fields in ["", r#", "abbr": null, "code": null, "color": null"#] {
            let json = format!(
                r#"{{"format_version": {version}, "course": {{"archived": false,
                     "order": 2{fields}}}, "tags": {{}}}}"#
            );
            let meta: CourseMeta = parse(&json).unwrap();
            assert_eq!(
                meta.course,
                Some(CourseSettings {
                    abbr: None,
                    archived: false,
                    code: None,
                    color: None,
                    order: 2,
                })
            );
            assert_eq!(
                text(&meta),
                "{\n  \"format_version\": 2,\n  \"course\": {\n    \"archived\": false,\n    \"order\": 2\n  },\n  \"tags\": {}\n}\n"
            );
        }
    }
}

#[test]
fn v1_course_values_are_read_without_a_legacy_mapping() {
    let json = r#"{"format_version": 1, "course": {"abbr": "LA", "archived": false,
                  "color": "gray", "order": 3}, "tags": {}}"#;
    let meta: CourseMeta = parse(json).unwrap();
    let settings = meta.course.unwrap();
    assert_eq!(settings.code, None);
    assert_eq!(settings.abbr.as_ref().map(Abbr::as_str), Some("LA"));
    assert_eq!(settings.color.as_ref().map(Color::as_str), Some("gray"));
}

#[test]
fn reading_v1_files_does_not_rewrite_them_or_recolour_stored_tags() {
    let dir = tempfile::tempdir().unwrap();
    let layout = Layout::new(dir.path());
    fs::create_dir_all(layout.folio_dir()).unwrap();
    let library = text(&LibraryConfig::new(DisplayName::parse("Library").unwrap()).unwrap())
        .replacen("\"format_version\": 2", "\"format_version\": 1", 1);
    let tags = r#"{"format_version": 1, "tags": {
        "reference": {"color": "gray", "name": "Reference", "order": 5}}}"#;
    fs::write(layout.library_file(), &library).unwrap();
    fs::write(layout.tags_file(), tags).unwrap();

    assert!(layout.read_library().unwrap().is_some());
    let stored = layout.read_tags().unwrap().unwrap();
    assert_eq!(
        stored.tags[&PresetTag::Reference.id()].color.as_str(),
        "gray"
    );
    assert_eq!(fs::read_to_string(layout.library_file()).unwrap(), library);
    assert_eq!(fs::read_to_string(layout.tags_file()).unwrap(), tags);
    let rewritten: TagDefinitions = parse(&text(&stored)).unwrap();
    assert_eq!(rewritten, stored);
}

#[test]
fn invalid_optional_course_information_is_rejected_without_repair() {
    for (field, value) in [
        ("abbr", "ABCD"),
        ("abbr", " A"),
        ("code", " MAT232"),
        ("code", "MAT232 "),
        ("code", ""),
        ("code", "MAT\n232"),
        ("code", "123456789012345678901234567890123"),
        ("color", "Blue"),
    ] {
        let json = serde_json::json!({
            "format_version": FORMAT_VERSION,
            "course": {"archived": false, "order": 1, (field): value},
            "tags": {},
        });
        assert!(parse::<CourseMeta>(&json.to_string()).is_err(), "{json}");
    }
}

#[test]
fn sorts_keys_by_code_point_whatever_the_input_order() {
    let json = r#"{"format_version": 1, "tags": {
        "线代.md": ["notes"], "b.md": ["notes"], "B.pdf": ["notes"], "a.md": ["notes"]
    }}"#;
    let root: RootMeta = parse(json).unwrap();
    let keys: Vec<_> = root.tags.iter().map(|(key, _)| key.as_str()).collect();
    assert_eq!(keys, ["B.pdf", "a.md", "b.md", "线代.md"]);
}

#[test]
fn reports_a_newer_format_version() {
    let json = r#"{"format_version": 3, "tags": {}, "field_from_the_future": true}"#;
    assert_eq!(parse::<RootMeta>(json), Err(Problem::Newer(3)));
}

#[test]
fn format_version_must_be_a_supported_positive_integer() {
    assert!(invalid::<RootMeta>(r#"{"tags": {}}"#).contains("`format_version` is missing"));
    for version in ["0", "-1", "1.5", "\"1\"", "null"] {
        let json = format!(r#"{{"format_version": {version}, "tags": {{}}}}"#);
        assert!(
            invalid::<RootMeta>(&json).contains("is not a format version"),
            "{version}"
        );
    }
    assert!(invalid::<RootMeta>("[]").contains("not a JSON object"));
    assert!(!invalid::<RootMeta>("{").is_empty());
}

#[test]
fn rejects_unknown_and_missing_fields() {
    let reason = invalid::<RootMeta>(r#"{"format_version": 1, "tags": {}, "colour": "red"}"#);
    assert!(reason.contains("unknown field `colour`"), "{reason}");

    let reason = invalid::<GroupMeta>(
        r#"{"format_version": 1, "group": {"archived": false, "order": 1, "x": 0}, "tags": {}}"#,
    );
    assert!(reason.contains("unknown field `x`"), "{reason}");

    let reason =
        invalid::<GroupMeta>(r#"{"format_version": 1, "group": {"order": 1}, "tags": {}}"#);
    assert!(reason.contains("missing field `archived`"), "{reason}");
    let reason = invalid::<CourseMeta>(r#"{"format_version": 1}"#);
    assert!(reason.contains("missing field `tags`"), "{reason}");
}

#[test]
fn settings_are_optional_and_left_out_when_missing() {
    let mut tags_only = CourseMeta::default();
    tags_only.tags.set(path("作业/hw1.pdf"), tags(["homework"]));
    assert_eq!(
        text(&tags_only),
        "{\n  \"format_version\": 2,\n  \"tags\": {\n    \"作业/hw1.pdf\": [\"homework\"]\n  }\n}\n"
    );
    assert_eq!(parse::<CourseMeta>(&text(&tags_only)), Ok(tags_only));
    assert_eq!(
        parse::<GroupMeta>(r#"{"format_version": 1, "tags": {}}"#),
        Ok(GroupMeta::default())
    );
}

#[test]
fn rejects_keys_that_appear_twice() {
    let reason = invalid::<RootMeta>(
        r#"{"format_version": 1, "tags": {"a.md": ["notes"], "a.md": ["exam"]}}"#,
    );
    assert!(
        reason.contains(r#"the key "a.md" appears twice"#),
        "{reason}"
    );

    let reason = invalid::<RootMeta>(r#"{"format_version": 1, "tags": {}, "tags": {}}"#);
    assert!(reason.contains("appears twice"), "{reason}");
}

#[test]
fn rejects_keys_that_differ_only_in_case() {
    let reason = invalid::<CourseMeta>(
        r#"{"format_version": 1,
            "course": {"abbr": "LA", "archived": false, "color": "blue", "order": 1},
            "tags": {"HW/a.pdf": ["homework"], "hw/A.pdf": ["exam"]}}"#,
    );
    assert!(reason.contains("differ only in case"), "{reason}");
}

#[test]
fn setting_tags_replaces_a_path_that_differs_only_in_case() {
    let mut assignments = Assignments::default();
    assignments.set(path("HW/a.pdf"), tags(["homework"]));
    assignments.set(path("hw/A.pdf"), tags(["exam"]));
    let all: Vec<_> = assignments.iter().collect();
    assert_eq!(all, [(&path("hw/A.pdf"), &tags(["exam"]))]);

    assignments.set(path("Hw/a.PDF"), BTreeSet::new());
    assert!(assignments.is_empty());
}

#[test]
fn rejects_invalid_values() {
    for (json, problem) in [
        (
            r#"{"format_version": 1, "tags": {"a/../b": ["notes"]}}"#,
            "not names",
        ),
        (
            r#"{"format_version": 1, "tags": {"café.md": ["notes"]}}"#,
            "normalization form C",
        ),
        (
            r#"{"format_version": 1, "tags": {"a.md": ["Notes"]}}"#,
            "a tag id must be",
        ),
        (
            r#"{"format_version": 1, "tags": {"a.md": "notes"}}"#,
            "invalid type",
        ),
    ] {
        let reason = invalid::<RootMeta>(json);
        assert!(reason.contains(problem), "{json}: {reason}");
    }

    let reason = invalid::<TagDefinitions>(
        r#"{"format_version": 1, "tags": {"x": {"color": "blue", "name": " x", "order": 1}}}"#,
    );
    assert!(reason.contains("a name must be"), "{reason}");

    let reason = invalid::<LibraryConfig>(
        r#"{"format_version": 1, "id": "0123456789abcdef0123456789abcdef", "name": "资料",
            "versioning": {"text_extensions": ["docx"], "text_max_size": 1,
                           "word_extensions": ["docx"]}}"#,
    );
    assert!(
        reason.contains("both a text and a Word extension"),
        "{reason}"
    );
}

#[test]
fn semester_and_root_keys_are_names_directly_in_the_folder() {
    let reason = invalid::<RootMeta>(r#"{"format_version": 1, "tags": {"a/b.md": ["notes"]}}"#);
    assert!(
        reason.contains("not a name directly in the folder"),
        "{reason}"
    );
    let reason = invalid::<GroupMeta>(
        r#"{"format_version": 1, "group": {"archived": false, "order": 0},
            "tags": {"course/b.md": ["notes"]}}"#,
    );
    assert!(
        reason.contains("not a name directly in the folder"),
        "{reason}"
    );
}

#[test]
fn tolerates_a_bom_and_drops_empty_tag_lists() {
    let json = "\u{feff}{\"format_version\": 1, \"tags\": {\"a.md\": [], \"b.md\": [\"notes\", \"notes\"]}}";
    let root: RootMeta = parse(json).unwrap();
    assert_eq!(root.tags.len(), 1);
    assert_eq!(root.tags.get(&path("b.md")), Some(&tags(["notes"])));
}

#[test]
fn setting_no_tags_removes_the_path() {
    let mut assignments = Assignments::default();
    assignments.set(path("a.md"), tags(["notes"]));
    assignments.set(path("a.md"), BTreeSet::new());
    assert!(assignments.is_empty());
}

#[test]
fn escapes_names_that_start_with_an_underscore() {
    let layout = Layout::new("lib");
    let meta = layout.meta_dir();
    assert_eq!(
        layout
            .tag_file_path(&TagFile::Course(course_at("2026 秋/线性代数")))
            .unwrap(),
        meta.join("2026 秋").join("线性代数.json")
    );
    assert_eq!(
        layout
            .tag_file_path(&TagFile::Course(course_at("_misc/_group")))
            .unwrap(),
        meta.join("__misc").join("__group.json")
    );
    assert_eq!(
        layout
            .tag_file_path(&TagFile::Group(semester("_root.json")))
            .unwrap(),
        meta.join("__root.json").join("_group.json")
    );
    assert_eq!(
        layout.tag_file_path(&TagFile::Root).unwrap(),
        meta.join("_root.json")
    );
    assert_eq!(unescape_name("__group"), Some("_group"));
    assert_eq!(unescape_name("线性代数"), Some("线性代数"));
    assert_eq!(unescape_name("_group"), None);
    assert_eq!(unescape_name("_root.json"), None);
}

#[test]
fn metadata_file_paths_read_back_and_nothing_else_does() {
    for file in [
        TagFile::Root,
        TagFile::Group(semester("2026 秋")),
        TagFile::Group(semester("_misc")),
        TagFile::Course(course_at("2026 秋/线性代数")),
        TagFile::Course(course_at("_s/_group")),
    ] {
        let text = file.meta_path().unwrap();
        assert_eq!(TagFile::at(&text), Some(file), "{text}");
    }
    for text in [
        "",
        "_root.json/",
        "s/c.json/x.json",
        "_s/c.json",
        "s/_c.json",
        "s/c.JSON",
        "../c.json",
        "s/..\\c.json",
        "C:\\c.json",
    ] {
        assert_eq!(TagFile::at(text), None, "{text}");
    }
}

#[test]
fn rejects_names_too_long_to_escape() {
    let layout = Layout::new("lib");
    let long = "x".repeat(251);
    let error = layout
        .tag_file_path(&TagFile::Course(course_at(&format!("s/{long}"))))
        .unwrap_err();
    assert!(matches!(error, MetaError::NameTooLong { .. }), "{error}");
    assert!(
        layout
            .tag_file_path(&TagFile::Course(course_at(&format!("s/{}", &long[1..]))))
            .is_ok()
    );
    let underscored = format!("_{}", "x".repeat(254));
    assert!(matches!(
        layout.tag_file_path(&TagFile::Group(semester(&underscored))),
        Err(MetaError::NameTooLong { .. })
    ));
}

#[test]
fn locates_the_tags_of_files_and_subfolders() {
    use EntryKind::{File, Folder};
    assert_eq!(
        tag_location(&path("readme.md"), File),
        Some((TagFile::Root, path("readme.md")))
    );
    assert_eq!(
        tag_location(&path("2026 秋/日程.pdf"), File),
        Some((TagFile::Group(semester("2026 秋")), path("日程.pdf")))
    );
    for kind in [File, Folder] {
        assert_eq!(
            tag_location(&path("2026 秋/线性代数/作业"), kind),
            Some((TagFile::Course(course_at("2026 秋/线性代数")), path("作业")))
        );
    }
    // Semester and course folders carry no tags.
    assert_eq!(tag_location(&path("2026 秋"), Folder), None);
    assert_eq!(tag_location(&path("2026 秋/线性代数"), Folder), None);
}

#[test]
fn recognizes_folios_own_folder_in_any_case() {
    for text in [".folio", ".FOLIO/meta/x.json", ".Folio/local"] {
        assert!(is_folio_owned(&path(text)), "{text}");
    }
    for text in ["folio", ".folio2", "2026 秋/.folio"] {
        assert!(!is_folio_owned(&path(text)), "{text}");
    }
}

#[test]
fn reads_and_writes_through_the_layout() {
    let dir = tempfile::tempdir().unwrap();
    let layout = Layout::new(dir.path());
    let course_path = course_at("2026 秋/线性代数");

    assert_eq!(layout.read_course_meta(&course_path).unwrap(), None);
    layout.write_course_meta(&course_path, &course()).unwrap();
    assert_eq!(
        layout.read_course_meta(&course_path).unwrap(),
        Some(course())
    );
    assert_eq!(
        fs::read_to_string(dir.path().join(".folio/meta/2026 秋/线性代数.json")).unwrap(),
        text(&course())
    );
    assert_eq!(fs::read_dir(layout.staging_dir()).unwrap().count(), 0);

    layout.write_tags(&presets("课件")).unwrap();
    assert_eq!(layout.read_tags().unwrap(), Some(presets("课件")));
}

#[test]
fn read_errors_name_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let layout = Layout::new(dir.path());
    fs::create_dir_all(layout.folio_dir()).unwrap();

    fs::write(layout.tags_file(), r#"{"format_version": 1, "tags": 3}"#).unwrap();
    let error = layout.read_tags().unwrap_err();
    assert!(matches!(&error, MetaError::Invalid { path, .. } if *path == layout.tags_file()));
    assert!(error.to_string().contains("tag definitions:"), "{error}");

    fs::write(layout.tags_file(), r#"{"format_version": 7, "tags": {}}"#).unwrap();
    assert!(matches!(
        layout.read_tags().unwrap_err(),
        MetaError::NewerFormat { found: 7, .. }
    ));

    let file = fs::File::create(layout.library_file()).unwrap();
    file.set_len(MAX_FILE_BYTES + 1).unwrap();
    assert!(matches!(
        layout.read_library().unwrap_err(),
        MetaError::TooLarge { .. }
    ));
}

fn name() -> impl Strategy<Value = String> {
    "[a-z0-9_\u{4e00}-\u{4e0f}][a-z0-9_ .\u{4e00}-\u{4e0f}]{0,8}[a-z0-9_\u{4e00}-\u{4e0f}]?"
        .prop_filter("a valid name", |name| {
            crate::paths::check_name(name).is_ok()
        })
}

proptest! {
    #[test]
    fn badge_limits_count_whole_graphemes(count in 1usize..8) {
        let badge = "👩‍💻".repeat(count);
        prop_assert_eq!(Abbr::parse(&badge).is_ok(), count <= MAX_ABBR_GRAPHEMES);
    }

    #[test]
    fn course_code_limits_count_scalars(count in 0usize..40) {
        let code = "字".repeat(count);
        prop_assert_eq!(CourseCode::parse(&code).is_ok(), (1..=MAX_COURSE_CODE_CHARS).contains(&count));
    }

    #[test]
    fn escaped_names_unescape_and_never_meet_folio_names(name in name()) {
        let escaped = escape(&name, "").unwrap();
        prop_assert_eq!(unescape_name(&escaped), Some(name.as_str()));
        prop_assert!(escaped != "_group" && escaped != "_root.json");
    }

    #[test]
    fn course_files_round_trip(
        entries in prop::collection::btree_map(
            prop::collection::vec(name(), 1..4).prop_map(|names| names.join("/")),
            prop::collection::btree_set("[a-z]{1,6}", 0..3),
            0..8,
        ),
        order in any::<u32>(),
        abbr in prop::option::of("[A-Z]{1,3}"),
        code in prop::option::of("[A-Z0-9字]{1,32}"),
        color in prop::option::of("[a-z]{1,10}"),
    ) {
        let mut meta = course();
        meta.course = Some(CourseSettings {
            abbr: abbr.as_deref().map(Abbr::parse).transpose().unwrap(),
            archived: false,
            code: code.as_deref().map(CourseCode::parse).transpose().unwrap(),
            color: color.as_deref().map(Color::parse).transpose().unwrap(),
            order,
        });
        meta.tags = Assignments::default();
        for (key, ids) in entries {
            let ids = ids.iter().map(|id| TagId::parse(id).unwrap()).collect();
            meta.tags.set(path(&key), ids);
        }
        let bytes = to_bytes(&meta).unwrap();
        prop_assert_eq!(from_bytes::<CourseMeta>(&bytes), Ok(meta.clone()));
        prop_assert_eq!(to_bytes(&meta).unwrap(), bytes);
    }
}
