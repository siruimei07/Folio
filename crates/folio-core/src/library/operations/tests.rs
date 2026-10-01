use std::collections::BTreeSet;
use std::fs;
use std::sync::Arc;

use proptest::prelude::*;
use tempfile::TempDir;

use super::*;
use crate::catalog::Catalog;
use crate::fs::StdFileSystem;
use crate::library::ScanCoverage;
use crate::meta::{
    Assignments, CourseMeta, DisplayName, GroupMeta, GroupSettings, LibraryConfig, TagId,
};
use crate::test_support::{course_at, library_id, path, presets, semester, tags};

struct Fixture {
    root: TempDir,
    _data: TempDir,
    library: Library,
    catalog: Catalog,
}

impl Fixture {
    fn new() -> Self {
        let root = TempDir::new().unwrap();
        let data = TempDir::new().unwrap();
        let library = Library::new(root.path(), Arc::new(StdFileSystem));
        let config = LibraryConfig {
            id: library_id(),
            name: DisplayName::parse("Library").unwrap(),
            versioning: Default::default(),
        };
        library.layout.write_library(&config).unwrap();
        library.layout.write_tags(&presets("Slides")).unwrap();
        let catalog = Catalog::open(&data.path().join("catalog.sqlite"), &config.id)
            .unwrap()
            .catalog;
        for folder in [
            "Fall/Beta",
            "Fall/Alpha",
            "Spring/Other",
            "Fall/Beta/Folder",
        ] {
            fs::create_dir_all(root.path().join(folder)).unwrap();
        }
        fs::write(root.path().join("Fall/Beta/Folder/a.md"), "body").unwrap();
        fs::write(root.path().join("Fall/Beta/b.txt"), "body").unwrap();
        library.scan(&catalog, None, 1).unwrap();
        Self {
            root,
            _data: data,
            library,
            catalog,
        }
    }

    fn reference(&self, text: &str) -> EntryRef {
        self.catalog
            .read(|tx| Ok(EntryRef::from(&catalog::entry(tx, &path(text))?.unwrap())))
            .unwrap()
    }

    fn readonly(&self) {
        fs::write(
            self.library.layout.tags_file(),
            "{\"format_version\":3,\"tags\":{}}",
        )
        .unwrap();
    }
}

#[test]
fn list_semesters_includes_discovered_folders_without_writing_metadata() {
    let f = Fixture::new();
    let before = fs::read(f.library.layout.tags_file()).unwrap();
    assert_eq!(
        f.library
            .list_semesters(&f.catalog)
            .unwrap()
            .iter()
            .map(|s| s.folder.record.path.as_str())
            .collect::<Vec<_>>(),
        ["Fall", "Spring"]
    );
    assert!(!f.library.layout.meta_dir().exists());
    assert_eq!(fs::read(f.library.layout.tags_file()).unwrap(), before);
}

#[test]
fn list_courses_counts_files_recursively_and_groups_by_visible_semester_order() {
    let f = Fixture::new();
    let result = f.library.list_courses(&f.catalog, None).unwrap();
    assert_eq!(
        result
            .iter()
            .map(|c| (c.folder.record.path.as_str(), c.files))
            .collect::<Vec<_>>(),
        [("Fall/Alpha", 0), ("Fall/Beta", 2), ("Spring/Other", 0)]
    );
    assert!(result.iter().all(|c| c.settings.abbr.is_none()
        && c.settings.code.is_none()
        && c.settings.color.is_none()));
    let mut stale = f.reference("Fall");
    stale.path = path("fall");
    assert!(matches!(
        f.library.list_courses(&f.catalog, Some(&stale)),
        Err(OperationError::NotFound)
    ));
}

#[cfg(windows)]
#[test]
fn create_semester_normalizes_its_name_and_appends_after_discovered_folders() {
    let f = Fixture::new();
    let outcome = f
        .library
        .create_semester(&f.catalog, "  Cafe\u{301}  ", 3)
        .unwrap();
    assert_eq!(outcome.value.folder.record.path, path("Café"));
    assert!(outcome.committed.groups && outcome.committed.changed());
    assert_eq!(
        f.library
            .list_semesters(&f.catalog)
            .unwrap()
            .last()
            .unwrap()
            .folder
            .id,
        outcome.value.folder.id
    );
    assert!(matches!(
        f.library.create_semester(&f.catalog, "café", 4),
        Err(OperationError::AlreadyExists)
    ));
    assert!(matches!(
        f.library.create_semester(&f.catalog, "CON", 4),
        Err(OperationError::Path(PathError::ReservedName))
    ));
    f.readonly();
    assert!(matches!(
        f.library.create_semester(&f.catalog, "Summer", 4),
        Err(OperationError::ReadOnly)
    ));
    assert!(!f.root.path().join("Summer").exists());
}

#[test]
fn update_semester_archives_in_place_and_rejects_stale_references() {
    let f = Fixture::new();
    let reference = f.reference("Fall");
    let result = f
        .library
        .update_semester(&f.catalog, &reference, true)
        .unwrap();
    assert!(result.value.archived && result.committed.groups);
    assert!(f.root.path().join("Fall/Beta/b.txt").exists());
    let mut stale = reference.clone();
    stale.id = EntryId(9999);
    assert!(matches!(
        f.library.update_semester(&f.catalog, &stale, false),
        Err(OperationError::NotFound)
    ));
    assert!(
        !f.library
            .update_semester(&f.catalog, &reference, true)
            .unwrap()
            .committed
            .changed()
    );
    f.readonly();
    assert!(matches!(
        f.library.update_semester(&f.catalog, &reference, false),
        Err(OperationError::ReadOnly)
    ));
}

#[test]
fn reorder_semesters_is_an_exact_permutation_and_rejection_changes_nothing() {
    let f = Fixture::new();
    let references = [f.reference("Spring"), f.reference("Fall")];
    let result = f
        .library
        .reorder_semesters(&f.catalog, &references)
        .unwrap();
    assert!(result.committed.groups);
    assert_eq!(
        result.value.iter().map(|s| s.folder.id).collect::<Vec<_>>(),
        references.iter().map(|r| r.id).collect::<Vec<_>>()
    );
    let bytes = fs::read(
        f.library
            .layout
            .tag_file_path(&TagFile::Group(semester("Fall")))
            .unwrap(),
    )
    .unwrap();
    for invalid in [
        vec![references[0].clone()],
        vec![references[0].clone(), references[0].clone()],
    ] {
        assert!(matches!(
            f.library.reorder_semesters(&f.catalog, &invalid),
            Err(OperationError::InvalidArgument(_))
        ));
    }
    assert_eq!(
        fs::read(
            f.library
                .layout
                .tag_file_path(&TagFile::Group(semester("Fall")))
                .unwrap()
        )
        .unwrap(),
        bytes
    );
    assert!(
        !f.library
            .reorder_semesters(&f.catalog, &references)
            .unwrap()
            .committed
            .changed()
    );
}

#[cfg(windows)]
#[test]
fn create_course_stores_normalized_optional_fields_and_goes_last() {
    let f = Fixture::new();
    let fields = CourseFields {
        abbr: Some(" e\u{301}AB ".into()),
        code: Some(" MAT232 ".into()),
        color: Some("stone".into()),
    };
    let outcome = f
        .library
        .create_course(&f.catalog, &f.reference("Fall"), " Gamma ", &fields, 3)
        .unwrap();
    assert_eq!(
        outcome.value.settings.abbr.as_ref().unwrap().as_str(),
        "éAB"
    );
    assert_eq!(
        outcome.value.settings.code.as_ref().unwrap().as_str(),
        "MAT232"
    );
    assert!(outcome.committed.groups);
    assert_eq!(
        f.library
            .list_courses(&f.catalog, Some(&f.reference("Fall")))
            .unwrap()
            .last()
            .unwrap()
            .folder
            .id,
        outcome.value.folder.id
    );
    assert!(matches!(
        f.library.create_course(
            &f.catalog,
            &f.reference("Fall"),
            "gamma",
            &CourseFields::default(),
            4
        ),
        Err(OperationError::AlreadyExists)
    ));
    let invalid = CourseFields {
        code: Some(" ".into()),
        ..Default::default()
    };
    assert!(matches!(
        f.library
            .create_course(&f.catalog, &f.reference("Fall"), "Invalid", &invalid, 4),
        Err(OperationError::Value(_))
    ));
    assert!(!f.root.path().join("Fall/Invalid").exists());
}

#[test]
fn update_course_replaces_optional_values_and_archive_preserving_tags() {
    let f = Fixture::new();
    let reference = f.reference("Fall/Beta");
    let fields = CourseFields {
        abbr: Some(" ABC ".into()),
        code: Some(" e\u{301} ".into()),
        color: Some("future-key".into()),
    };
    let result = f
        .library
        .update_course(&f.catalog, &reference, &fields, true)
        .unwrap();
    assert!(result.committed.groups && result.value.settings.archived);
    assert_eq!(result.value.settings.code.as_ref().unwrap().as_str(), "é");
    let result = f
        .library
        .update_course(&f.catalog, &reference, &CourseFields::default(), false)
        .unwrap();
    assert_eq!(
        (
            result.value.settings.abbr,
            result.value.settings.code,
            result.value.settings.color
        ),
        (None, None, None)
    );
    assert!(!result.value.settings.archived);
    assert!(f.root.path().join("Fall/Beta/b.txt").exists());
    assert!(
        !f.library
            .update_course(&f.catalog, &reference, &CourseFields::default(), false)
            .unwrap()
            .committed
            .changed()
    );
    f.readonly();
    assert!(matches!(
        f.library
            .update_course(&f.catalog, &reference, &fields, true),
        Err(OperationError::ReadOnly)
    ));
}

#[test]
fn reorder_courses_preserves_settings_and_rejects_wrong_semester_or_stale_members() {
    let f = Fixture::new();
    let references = [f.reference("Fall/Beta"), f.reference("Fall/Alpha")];
    f.library
        .update_course(
            &f.catalog,
            &references[0],
            &CourseFields {
                code: Some("MAT232".into()),
                ..Default::default()
            },
            true,
        )
        .unwrap();
    let result = f
        .library
        .reorder_courses(&f.catalog, &f.reference("Fall"), &references)
        .unwrap();
    assert!(result.committed.groups && result.value[0].settings.archived);
    assert_eq!(
        result.value[0].settings.code.as_ref().unwrap().as_str(),
        "MAT232"
    );
    let wrong = [references[0].clone(), f.reference("Spring/Other")];
    assert!(matches!(
        f.library
            .reorder_courses(&f.catalog, &f.reference("Fall"), &wrong),
        Err(OperationError::InvalidArgument(_))
    ));
    let mut stale = references.to_vec();
    stale[0].path = path("Fall/Gone");
    assert!(matches!(
        f.library
            .reorder_courses(&f.catalog, &f.reference("Fall"), &stale),
        Err(OperationError::NotFound)
    ));
}

#[test]
fn list_tags_uses_own_assignment_usage_and_preset_order() {
    let f = Fixture::new();
    f.library
        .set_entry_tags(
            &f.catalog,
            &[f.reference("Fall/Beta/Folder")],
            &tags(["notes"]),
            &BTreeSet::new(),
        )
        .unwrap();
    let result = f.library.list_tags(&f.catalog).unwrap();
    assert_eq!(result[0].id.as_str(), "notes");
    assert_eq!(result[0].usage, 1); // its child inherits it but carries no own assignment
    assert_eq!(result.last().unwrap().definition.color.as_str(), "stone");
}

#[test]
fn create_tag_normalizes_names_checks_collisions_and_reports_tag_delta() {
    let f = Fixture::new();
    let result = f
        .library
        .create_tag(&f.catalog, " Cafe\u{301} ", "violet")
        .unwrap();
    assert_eq!(result.value.definition.name.as_str(), "Café");
    assert_eq!(result.value.id.as_str().len(), 16);
    assert!(result.committed.tags && result.committed.entries.is_empty());
    assert_eq!(
        f.library.list_tags(&f.catalog).unwrap().last().unwrap().id,
        result.value.id
    );
    assert!(matches!(
        f.library.create_tag(&f.catalog, "CAFÉ", "blue"),
        Err(OperationError::AlreadyExists)
    ));
    assert!(matches!(
        f.library.create_tag(&f.catalog, "\n", "blue"),
        Err(OperationError::Value(_))
    ));
    f.readonly();
    assert!(matches!(
        f.library.create_tag(&f.catalog, "Another", "blue"),
        Err(OperationError::ReadOnly)
    ));
}

#[test]
fn update_tag_keeps_identity_and_updates_search_names() {
    let f = Fixture::new();
    let id = TagId::parse("notes").unwrap();
    f.library
        .set_entry_tags(
            &f.catalog,
            &[f.reference("Fall/Beta/b.txt")],
            &tags(["notes"]),
            &BTreeSet::new(),
        )
        .unwrap();
    let result = f
        .library
        .update_tag(&f.catalog, &id, "Lecture", "teal")
        .unwrap();
    assert_eq!(result.value.id, id);
    assert_eq!(result.value.usage, 1);
    assert!(result.committed.tags);
    let search: String = f
        .catalog
        .read(|tx| {
            Ok(tx.query_row(
                "SELECT tags FROM search WHERE rowid=?1",
                [f.reference("Fall/Beta/b.txt").id.0],
                |row| row.get(0),
            )?)
        })
        .unwrap();
    assert_eq!(search, "Lecture");
    assert!(
        !f.library
            .update_tag(&f.catalog, &id, "Lecture", "teal")
            .unwrap()
            .committed
            .changed()
    );
    assert!(matches!(
        f.library.update_tag(&f.catalog, &id, "Slides", "blue"),
        Err(OperationError::AlreadyExists)
    ));
    assert!(matches!(
        f.library
            .update_tag(&f.catalog, &TagId::parse("gone").unwrap(), "Other", "blue"),
        Err(OperationError::NotFound)
    ));
}

#[test]
fn reorder_tags_rejects_missing_or_duplicate_ids_without_writing() {
    let f = Fixture::new();
    let mut ids: Vec<_> = f
        .library
        .list_tags(&f.catalog)
        .unwrap()
        .into_iter()
        .map(|t| t.id)
        .collect();
    ids.reverse();
    let result = f.library.reorder_tags(&f.catalog, &ids).unwrap();
    assert!(result.committed.tags);
    assert_eq!(
        result.value.iter().map(|t| &t.id).collect::<Vec<_>>(),
        ids.iter().collect::<Vec<_>>()
    );
    let before = fs::read(f.library.layout.tags_file()).unwrap();
    assert!(matches!(
        f.library.reorder_tags(&f.catalog, &ids[..4]),
        Err(OperationError::InvalidArgument(_))
    ));
    let mut duplicate = ids.clone();
    duplicate[1] = duplicate[0].clone();
    assert!(matches!(
        f.library.reorder_tags(&f.catalog, &duplicate),
        Err(OperationError::InvalidArgument(_))
    ));
    assert_eq!(fs::read(f.library.layout.tags_file()).unwrap(), before);
}

#[test]
fn delete_tag_removes_every_authored_assignment_including_orphans_and_keeps_settings() {
    let f = Fixture::new();
    f.library
        .set_entry_tags(
            &f.catalog,
            &[f.reference("Fall/Beta/b.txt")],
            &tags(["notes", "exam"]),
            &BTreeSet::new(),
        )
        .unwrap();
    let course = course_at("Gone/Orphan");
    let mut assignments = Assignments::default();
    assignments.set(path("restored.md"), tags(["notes"]));
    f.library
        .layout
        .write_course_meta(
            &course,
            &CourseMeta {
                course: None,
                tags: assignments,
            },
        )
        .unwrap();
    let result = f
        .library
        .delete_tag(&f.catalog, &TagId::parse("notes").unwrap())
        .unwrap();
    assert_eq!(result.value, 2);
    assert!(result.committed.tags);
    assert!(
        result
            .committed
            .entries
            .iter()
            .any(|e| e.kind == super::super::EntryChangeKind::Tagged)
    );
    assert!(
        f.library
            .layout
            .read_course_meta(&course)
            .unwrap()
            .unwrap()
            .tags
            .is_empty()
    );
    assert_eq!(
        f.catalog
            .read(|tx| catalog::entry_tags(tx, f.reference("Fall/Beta/b.txt").id))
            .unwrap(),
        tags(["exam"])
    );
    assert!(matches!(
        f.library
            .delete_tag(&f.catalog, &TagId::parse("notes").unwrap()),
        Err(OperationError::NotFound)
    ));
}

#[test]
fn delete_tag_refuses_unreadable_assignment_files_before_any_write() {
    let f = Fixture::new();
    let file = f
        .library
        .layout
        .tag_file_path(&TagFile::Group(semester("Fall")))
        .unwrap();
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(file, "broken").unwrap();
    let before = fs::read(f.library.layout.tags_file()).unwrap();
    assert!(matches!(
        f.library
            .delete_tag(&f.catalog, &TagId::parse("notes").unwrap()),
        Err(OperationError::UnreadableMetadata(_))
    ));
    assert_eq!(fs::read(f.library.layout.tags_file()).unwrap(), before);
}

#[test]
fn set_entry_tags_reports_every_failure_and_never_removes_inherited_tags() {
    let f = Fixture::new();
    let folder = f.reference("Fall/Beta/Folder");
    let child = f.reference("Fall/Beta/Folder/a.md");
    f.library
        .set_entry_tags(&f.catalog, &[folder], &tags(["notes"]), &BTreeSet::new())
        .unwrap();
    let result = f
        .library
        .set_entry_tags(
            &f.catalog,
            std::slice::from_ref(&child),
            &BTreeSet::new(),
            &tags(["notes"]),
        )
        .unwrap();
    assert_eq!(result.value.done, 1);
    assert!(!result.committed.changed());
    let mut stale = child.clone();
    stale.path = path("Gone");
    let result = f
        .library
        .set_entry_tags(
            &f.catalog,
            &[
                child.clone(),
                stale,
                f.reference("Fall"),
                f.reference("Fall/Beta"),
            ],
            &tags(["exam"]),
            &BTreeSet::new(),
        )
        .unwrap();
    assert_eq!((result.value.done, result.value.failures.len()), (1, 3));
    assert!(matches!(
        result.value.failures[0].1,
        OperationError::NotFound
    ));
    assert!(matches!(
        result.value.failures[1].1,
        OperationError::InvalidArgument(_)
    ));
    assert_eq!(result.committed.entries[0].id, child.id);
    assert!(matches!(
        f.library
            .set_entry_tags(&f.catalog, &[], &tags(["unknown"]), &BTreeSet::new()),
        Err(OperationError::InvalidArgument(_))
    ));
    assert!(matches!(
        f.library
            .set_entry_tags(&f.catalog, &[], &tags(["notes"]), &tags(["notes"])),
        Err(OperationError::InvalidArgument(_))
    ));
    assert!(matches!(
        f.library.set_entry_tags(
            &f.catalog,
            &vec![child.clone(); MAX_BATCH + 1],
            &BTreeSet::new(),
            &BTreeSet::new()
        ),
        Err(OperationError::InvalidArgument(_))
    ));
    f.readonly();
    let result = f
        .library
        .set_entry_tags(&f.catalog, &[child], &BTreeSet::new(), &BTreeSet::new())
        .unwrap();
    assert!(matches!(
        result.value.failures[0].1,
        OperationError::ReadOnly
    ));
}

#[cfg(windows)]
#[test]
fn moved_then_already_at_target_keeps_the_committed_coverage_for_events() {
    let f = Fixture::new();
    fs::write(f.root.path().join("Fall/Alpha/already.txt"), "same place").unwrap();
    f.library.scan(&f.catalog, None, 2).unwrap();
    let outcome = f
        .library
        .move_entries(
            &f.catalog,
            &[
                f.reference("Fall/Beta/b.txt"),
                f.reference("Fall/Alpha/already.txt"),
            ],
            Some(&f.reference("Fall/Alpha")),
            3,
        )
        .unwrap();
    assert_eq!(outcome.value.done, 2);
    assert_eq!(outcome.committed.coverage, ScanCoverage::Metadata);
    assert_eq!(outcome.committed.entries.len(), 1);
    assert!(outcome.committed.changed());
}

#[cfg(windows)]
#[test]
fn group_mutations_preserve_fresh_authored_fields_when_catalog_has_not_synced() {
    for action in 0..3 {
        let f = Fixture::new();
        let mut own = Assignments::default();
        own.set(path("orphan.md"), tags(["exam"]));
        f.library
            .layout
            .write_course_meta(
                &course_at("Fall/Alpha"),
                &CourseMeta {
                    course: Some(crate::meta::CourseSettings {
                        abbr: Some(crate::meta::Abbr::parse("ABC").unwrap()),
                        code: Some(crate::meta::CourseCode::parse("AUTHORED").unwrap()),
                        color: Some(crate::meta::Color::parse("violet").unwrap()),
                        archived: true,
                        order: 31,
                    }),
                    tags: own.clone(),
                },
            )
            .unwrap();
        f.library
            .layout
            .write_group_meta(
                &semester("Spring"),
                &GroupMeta {
                    group: Some(GroupSettings {
                        archived: true,
                        order: 17,
                    }),
                    tags: own.clone(),
                },
            )
            .unwrap();
        match action {
            0 => {
                f.library
                    .update_course(
                        &f.catalog,
                        &f.reference("Fall/Beta"),
                        &CourseFields::default(),
                        false,
                    )
                    .unwrap();
                f.library
                    .update_semester(&f.catalog, &f.reference("Fall"), false)
                    .unwrap();
            }
            1 => {
                f.library
                    .reorder_courses(
                        &f.catalog,
                        &f.reference("Fall"),
                        &[f.reference("Fall/Beta"), f.reference("Fall/Alpha")],
                    )
                    .unwrap();
                f.library
                    .reorder_semesters(&f.catalog, &[f.reference("Fall"), f.reference("Spring")])
                    .unwrap();
            }
            _ => {
                f.library
                    .create_course(
                        &f.catalog,
                        &f.reference("Fall"),
                        "Gamma",
                        &CourseFields::default(),
                        2,
                    )
                    .unwrap();
                f.library.create_semester(&f.catalog, "Summer", 2).unwrap();
            }
        }
        let course = f
            .library
            .layout
            .read_course_meta(&course_at("Fall/Alpha"))
            .unwrap()
            .unwrap();
        let settings = course.course.unwrap();
        assert_eq!(settings.abbr.unwrap().as_str(), "ABC");
        assert_eq!(settings.code.unwrap().as_str(), "AUTHORED");
        assert_eq!(settings.color.unwrap().as_str(), "violet");
        assert!(settings.archived);
        assert_eq!(course.tags, own);
        let spring = f
            .library
            .layout
            .read_group_meta(&semester("Spring"))
            .unwrap()
            .unwrap();
        assert!(spring.group.unwrap().archived);
        assert_eq!(spring.tags, own);
    }
}

#[test]
fn failed_catalog_mirror_after_tag_write_requires_recovery_and_keeps_authored_data() {
    let f = Fixture::new();
    f.catalog.write(|tx| {
        tx.execute_batch("CREATE TRIGGER reject_tags BEFORE INSERT ON tags BEGIN SELECT RAISE(ABORT, 'injected mirror failure'); END;")?;
        Ok(())
    }).unwrap();
    assert!(matches!(
        f.library.create_tag(&f.catalog, "Authored", "stone"),
        Err(OperationError::RecoveryRequired { .. })
    ));
    assert_eq!(f.library.list_tags(&f.catalog).unwrap().len(), 5);
    assert!(
        f.library
            .layout
            .read_tags()
            .unwrap()
            .unwrap()
            .tags
            .values()
            .any(|tag| tag.name.as_str() == "Authored")
    );
    f.catalog
        .write(|tx| {
            tx.execute_batch("DROP TRIGGER reject_tags")?;
            Ok(())
        })
        .unwrap();
    f.library.sync_metadata(&f.catalog).unwrap();
    assert_eq!(f.library.list_tags(&f.catalog).unwrap().len(), 6);
}

#[test]
fn failed_catalog_mirror_after_group_write_requires_recovery_and_keeps_archive() {
    let f = Fixture::new();
    f.catalog.write(|tx| {
        tx.execute_batch("CREATE TRIGGER reject_groups BEFORE INSERT ON semesters BEGIN SELECT RAISE(ABORT, 'injected mirror failure'); END;")?;
        Ok(())
    }).unwrap();
    assert!(matches!(
        f.library
            .update_semester(&f.catalog, &f.reference("Fall"), true),
        Err(OperationError::RecoveryRequired { .. })
    ));
    assert!(
        f.library
            .layout
            .read_group_meta(&semester("Fall"))
            .unwrap()
            .unwrap()
            .group
            .unwrap()
            .archived
    );
    f.catalog
        .write(|tx| {
            tx.execute_batch("DROP TRIGGER reject_groups")?;
            Ok(())
        })
        .unwrap();
    f.library.sync_metadata(&f.catalog).unwrap();
    assert!(
        f.library
            .list_semesters(&f.catalog)
            .unwrap()
            .iter()
            .find(|s| s.folder.record.path == path("Fall"))
            .unwrap()
            .archived
    );
}

#[test]
fn a_renumber_that_fails_after_an_earlier_write_requires_recovery() {
    let f = Fixture::new();
    // A folder where the second file of each renumbering belongs: the first is written, then
    // writing the second fails.
    for file in [
        TagFile::Group(semester("Spring")),
        TagFile::Course(course_at("Fall/Beta")),
    ] {
        fs::create_dir_all(f.library.layout.tag_file_path(&file).unwrap()).unwrap();
    }
    assert!(matches!(
        f.library
            .update_semester(&f.catalog, &f.reference("Fall"), true),
        Err(OperationError::RecoveryRequired { .. })
    ));
    assert!(
        f.library
            .layout
            .read_group_meta(&semester("Fall"))
            .unwrap()
            .unwrap()
            .group
            .unwrap()
            .archived
    );
    assert!(matches!(
        f.library.update_course(
            &f.catalog,
            &f.reference("Fall/Alpha"),
            &CourseFields::default(),
            true,
        ),
        Err(OperationError::RecoveryRequired { .. })
    ));
    assert!(
        f.library
            .layout
            .read_course_meta(&course_at("Fall/Alpha"))
            .unwrap()
            .unwrap()
            .course
            .unwrap()
            .archived
    );
}

#[cfg(windows)]
#[test]
fn an_unreadable_semester_file_blocks_only_what_must_rewrite_it() {
    let f = Fixture::new();
    let spring = f
        .library
        .layout
        .tag_file_path(&TagFile::Group(semester("Spring")))
        .unwrap();
    fs::create_dir_all(spring.parent().unwrap()).unwrap();
    fs::write(&spring, "{ unreadable").unwrap();

    f.library.create_semester(&f.catalog, "Winter", 5).unwrap();
    f.library
        .update_semester(&f.catalog, &f.reference("Fall"), true)
        .unwrap();
    assert_eq!(fs::read(&spring).unwrap(), b"{ unreadable");

    assert!(matches!(
        f.library
            .update_semester(&f.catalog, &f.reference("Spring"), true),
        Err(OperationError::UnreadableMetadata(_))
    ));
    let order: Vec<_> = f
        .library
        .list_semesters(&f.catalog)
        .unwrap()
        .iter()
        .map(|s| EntryRef::from(&s.folder))
        .collect();
    assert!(matches!(
        f.library.reorder_semesters(&f.catalog, &order),
        Err(OperationError::UnreadableMetadata(_))
    ));
    assert_eq!(fs::read(&spring).unwrap(), b"{ unreadable");
}

#[test]
#[allow(
    clippy::permissions_set_readonly_false,
    reason = "Windows: clears the read-only attribute the test set"
)]
fn set_entry_tags_fails_every_entry_that_changed_a_file_it_could_not_write() {
    let f = Fixture::new();
    fs::write(f.root.path().join("Spring/Other/c.md"), "body").unwrap();
    f.library.scan(&f.catalog, None, 2).unwrap();
    let (a, b, c) = (
        f.reference("Fall/Beta/Folder/a.md"),
        f.reference("Fall/Beta/b.txt"),
        f.reference("Spring/Other/c.md"),
    );
    f.library
        .set_entry_tags(
            &f.catalog,
            std::slice::from_ref(&a),
            &tags(["notes"]),
            &BTreeSet::new(),
        )
        .unwrap();
    let beta = f
        .library
        .layout
        .tag_file_path(&TagFile::Course(course_at("Fall/Beta")))
        .unwrap();
    let before = fs::read(&beta).unwrap();
    let mut permissions = fs::metadata(&beta).unwrap().permissions();
    permissions.set_readonly(true);
    fs::set_permissions(&beta, permissions.clone()).unwrap();

    let result = f.library.set_entry_tags(
        &f.catalog,
        &[a.clone(), b.clone(), c.clone()],
        &tags(["exam"]),
        &BTreeSet::new(),
    );
    permissions.set_readonly(false);
    fs::set_permissions(&beta, permissions).unwrap();
    let result = result.unwrap();

    assert_eq!(result.value.done, 1);
    let failed: Vec<_> = result
        .value
        .failures
        .iter()
        .map(|(reference, error)| {
            let kind = match error {
                OperationError::Meta(MetaError::Io { source, .. })
                | OperationError::Io { source, .. } => Some(source.kind()),
                _ => None,
            };
            (reference.clone(), kind)
        })
        .collect();
    let denied = Some(std::io::ErrorKind::PermissionDenied);
    assert_eq!(failed, [(a, denied), (b, denied)]);
    assert_eq!(fs::read(&beta).unwrap(), before);
    assert_eq!(
        f.library
            .layout
            .read_course_meta(&course_at("Spring/Other"))
            .unwrap()
            .unwrap()
            .tags
            .get(&path("c.md")),
        Some(&tags(["exam"]))
    );
    assert_eq!(result.committed.entries.len(), 1);
    assert_eq!(result.committed.entries[0].id, c.id);
}

proptest! {
    #[test]
    fn normalization_is_idempotent_and_always_nfc(text in ".{0,100}") {
        let normalized = normalize_text(&text);
        prop_assert_eq!(normalize_text(&normalized), normalized.clone());
        prop_assert!(unicode_normalization::is_nfc(&normalized));
    }

    #[test]
    fn ordering_is_deterministic_for_random_configured_ties(fall in 0u32..100, spring in 0u32..100) {
        let f = Fixture::new();
        f.library.layout.write_group_meta(&semester("Fall"), &GroupMeta { group: Some(GroupSettings { archived: false, order: fall }), tags: Default::default() }).unwrap();
        f.library.layout.write_group_meta(&semester("Spring"), &GroupMeta { group: Some(GroupSettings { archived: true, order: spring }), tags: Default::default() }).unwrap();
        f.library.sync_metadata(&f.catalog).unwrap();
        let expected = if fall <= spring { ["Fall", "Spring"] } else { ["Spring", "Fall"] };
        let listed = f.library.list_semesters(&f.catalog).unwrap();
        prop_assert_eq!(listed.iter().map(|s| s.folder.record.path.as_str()).collect::<Vec<_>>(), expected);
        let refs: Vec<_> = listed.iter().rev().map(|s| EntryRef::from(&s.folder)).collect();
        let reordered = f.library.reorder_semesters(&f.catalog, &refs).unwrap();
        prop_assert_eq!(reordered.value.iter().map(|s| s.folder.id).collect::<Vec<_>>(), refs.iter().map(|r| r.id).collect::<Vec<_>>());
    }
}
