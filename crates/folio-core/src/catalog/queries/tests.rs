use std::collections::{BTreeMap, BTreeSet};

use proptest::prelude::*;
use rusqlite::Connection;

use super::*;
use crate::catalog::{
    Catalog, EntryChanges, EntryRecord, Span, apply_changes, delete_entry, replace_tag_definitions,
    set_body, set_entry_tags,
};
use crate::meta::{Color, DisplayName, FileClass, TagDefinition, VersioningRules};
use crate::test_support::{open_catalog, path, tags};

const ALL: PageRequest = PageRequest {
    offset: 0,
    limit: MAX_PAGE_SIZE,
};
const NAME: EntrySort = EntrySort {
    key: SortKey::Name,
    descending: false,
};
const PATH: EntrySort = EntrySort {
    key: SortKey::Path,
    descending: false,
};
const NOW: i64 = 1_700_000_000;

fn folder(text: &str) -> EntryRecord {
    EntryRecord {
        path: path(text),
        kind: EntryKind::Folder,
        class: FileClass::Other,
        size: 0,
        mtime_ns: None,
        file_id: None,
        hash: None,
    }
}

fn file(text: &str, size: u64, mtime_ns: Option<i64>) -> EntryRecord {
    let mut record = folder(text);
    record.kind = EntryKind::File;
    record.class = VersioningRules::default().class_of(&record.path);
    record.size = size;
    record.mtime_ns = mtime_ns;
    record
}

fn add(catalog: &Catalog, added: Vec<(EntryRecord, i64)>) -> Vec<EntryId> {
    catalog
        .write(|tx| {
            apply_changes(
                tx,
                &EntryChanges {
                    added,
                    ..EntryChanges::default()
                },
            )
        })
        .unwrap()
}

fn read<T>(
    catalog: &Catalog,
    query: impl FnOnce(&Connection) -> Result<T, QueryError>,
) -> Result<T, QueryError> {
    catalog.read(|tx| Ok(query(tx))).unwrap()
}

fn paths(page: &Page) -> Vec<String> {
    page.items
        .iter()
        .map(|row| row.entry.record.path.to_string())
        .collect()
}

fn hit_paths(page: &SearchPage) -> Vec<String> {
    page.items
        .iter()
        .map(|hit| hit.entry.entry.record.path.to_string())
        .collect()
}

fn definitions(values: &[(&str, &str, u32)]) -> TagDefinitions {
    TagDefinitions {
        tags: values
            .iter()
            .map(|&(id, name, order)| {
                (
                    TagId::parse(id).unwrap(),
                    TagDefinition {
                        color: Color::parse("blue").unwrap(),
                        name: DisplayName::parse(name).unwrap(),
                        order,
                    },
                )
            })
            .collect(),
    }
}

#[test]
fn natural_names_compare_digit_runs_case_and_unicode_without_integer_overflow() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let huge = format!("hw{}.md", "9".repeat(80));
    let larger = format!("hw1{}.md", "0".repeat(80));
    let expected = [
        "hw0.md",
        "hw00.md",
        "hw1.md",
        "hw1b2.md",
        "hw1b10.md",
        "HW2.md",
        "hw0002.md",
        "hw02.md",
        "hw10.md",
        &huge,
        &larger,
        "É2.md",
        "é10.md",
        "οσ2.md",
        "ος10.md",
        "作业2.md",
        "作业10.md",
    ];
    add(
        &catalog,
        expected
            .iter()
            .rev()
            .map(|name| (file(name, 1, None), 1))
            .collect(),
    );
    assert_eq!(
        paths(&read(&catalog, |tx| list_children(tx, None, NAME, ALL)).unwrap()),
        expected
    );
}

#[test]
fn every_sort_direction_keeps_folders_first_null_dates_last_and_path_ties_stable() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    add(
        &catalog,
        vec![
            (
                EntryRecord {
                    mtime_ns: Some(2),
                    ..folder("Folder2")
                },
                30,
            ),
            (
                EntryRecord {
                    mtime_ns: Some(1),
                    ..folder("Folder10")
                },
                10,
            ),
            (file("A2.txt", 20, Some(2)), 20),
            (file("a02.TXT", 20, Some(2)), 20),
            (file("b10.md", 4, Some(1)), 40),
            (file("b2.md", 10, Some(3)), 10),
            (file("noextension", 0, Some(0)), 0),
            (file("missing.bin", 3, None), 30),
        ],
    );
    for (key, descending, folders, files) in [
        (
            SortKey::Name,
            false,
            ["Folder2", "Folder10"],
            [
                "A2.txt",
                "a02.TXT",
                "b2.md",
                "b10.md",
                "missing.bin",
                "noextension",
            ],
        ),
        (
            SortKey::Name,
            true,
            ["Folder10", "Folder2"],
            [
                "noextension",
                "missing.bin",
                "b10.md",
                "b2.md",
                "A2.txt",
                "a02.TXT",
            ],
        ),
        (
            SortKey::Path,
            false,
            ["Folder10", "Folder2"],
            [
                "A2.txt",
                "a02.TXT",
                "b10.md",
                "b2.md",
                "missing.bin",
                "noextension",
            ],
        ),
        (
            SortKey::Path,
            true,
            ["Folder2", "Folder10"],
            [
                "noextension",
                "missing.bin",
                "b2.md",
                "b10.md",
                "a02.TXT",
                "A2.txt",
            ],
        ),
        (
            SortKey::Modified,
            false,
            ["Folder10", "Folder2"],
            [
                "noextension",
                "b10.md",
                "A2.txt",
                "a02.TXT",
                "b2.md",
                "missing.bin",
            ],
        ),
        (
            SortKey::Modified,
            true,
            ["Folder2", "Folder10"],
            [
                "b2.md",
                "A2.txt",
                "a02.TXT",
                "b10.md",
                "noextension",
                "missing.bin",
            ],
        ),
        (
            SortKey::Size,
            false,
            ["Folder10", "Folder2"],
            [
                "noextension",
                "missing.bin",
                "b10.md",
                "b2.md",
                "A2.txt",
                "a02.TXT",
            ],
        ),
        (
            SortKey::Size,
            true,
            ["Folder10", "Folder2"],
            [
                "A2.txt",
                "a02.TXT",
                "b2.md",
                "b10.md",
                "missing.bin",
                "noextension",
            ],
        ),
        (
            SortKey::FileType,
            false,
            ["Folder2", "Folder10"],
            [
                "noextension",
                "missing.bin",
                "b2.md",
                "b10.md",
                "A2.txt",
                "a02.TXT",
            ],
        ),
        (
            SortKey::FileType,
            true,
            ["Folder10", "Folder2"],
            [
                "A2.txt",
                "a02.TXT",
                "b10.md",
                "b2.md",
                "missing.bin",
                "noextension",
            ],
        ),
        (
            SortKey::Added,
            false,
            ["Folder10", "Folder2"],
            [
                "noextension",
                "b2.md",
                "A2.txt",
                "a02.TXT",
                "missing.bin",
                "b10.md",
            ],
        ),
        (
            SortKey::Added,
            true,
            ["Folder2", "Folder10"],
            [
                "b10.md",
                "missing.bin",
                "A2.txt",
                "a02.TXT",
                "b2.md",
                "noextension",
            ],
        ),
    ] {
        let sort = EntrySort { key, descending };
        let children = read(&catalog, |tx| list_children(tx, None, sort, ALL)).unwrap();
        assert_eq!(children.total, 8);
        assert_eq!(
            paths(&children),
            [folders.as_slice(), files.as_slice()].concat(),
            "{sort:?}"
        );
        let page = read(&catalog, |tx| {
            list_files(tx, None, &FileFilter::default(), sort, ALL)
        })
        .unwrap();
        assert_eq!(page.total, 6);
        assert_eq!(paths(&page), files, "{sort:?}");
    }
}

#[test]
fn scopes_include_loose_semester_files_and_exclude_prefix_siblings() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let ids = add(
        &catalog,
        vec![
            (folder("s"), 0),
            (folder("s/c"), 0),
            (folder("s/c/sub"), 0),
            (file("s/c/sub/deep.md", 1, None), 0),
            (file("s/c/direct.md", 1, None), 0),
            (file("s/loose.md", 1, None), 0),
            (folder("s/c2"), 0),
            (file("s/c2/sibling.md", 1, None), 0),
            (folder("s2"), 0),
            (file("s2/other.md", 1, None), 0),
            (file("root.md", 1, None), 0),
        ],
    );
    let semester = read(&catalog, |tx| {
        list_files(
            tx,
            Some((ids[0], &path("s"))),
            &FileFilter::default(),
            PATH,
            ALL,
        )
    })
    .unwrap();
    assert_eq!(
        paths(&semester),
        [
            "s/c/direct.md",
            "s/c/sub/deep.md",
            "s/c2/sibling.md",
            "s/loose.md"
        ]
    );
    let course = read(&catalog, |tx| {
        list_files(
            tx,
            Some((ids[1], &path("s/c"))),
            &FileFilter::default(),
            PATH,
            ALL,
        )
    })
    .unwrap();
    assert_eq!(paths(&course), ["s/c/direct.md", "s/c/sub/deep.md"]);
    let children = read(&catalog, |tx| {
        list_children(tx, Some((ids[1], &path("s/c"))), PATH, ALL)
    })
    .unwrap();
    assert_eq!(paths(&children), ["s/c/sub", "s/c/direct.md"]);
    assert_eq!(
        read(&catalog, |tx| list_files(
            tx,
            None,
            &FileFilter::default(),
            PATH,
            ALL
        ))
        .unwrap()
        .total,
        6
    );
}

#[test]
fn pages_keep_total_when_empty_out_of_range_or_total_only_and_validate_the_limit() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    assert_eq!(
        read(&catalog, |tx| list_children(tx, None, NAME, ALL)).unwrap(),
        Page {
            items: Vec::new(),
            total: 0
        }
    );
    add(
        &catalog,
        vec![(file("a.md", 1, None), 0), (file("b.md", 1, None), 0)],
    );
    for page in [
        PageRequest {
            offset: 0,
            limit: 0,
        },
        PageRequest {
            offset: 2,
            limit: 1,
        },
        PageRequest {
            offset: u32::MAX,
            limit: MAX_PAGE_SIZE,
        },
    ] {
        assert_eq!(
            read(&catalog, |tx| list_files(
                tx,
                None,
                &FileFilter::default(),
                NAME,
                page
            ))
            .unwrap(),
            Page {
                items: Vec::new(),
                total: 2
            }
        );
    }
    let second = read(&catalog, |tx| {
        list_children(
            tx,
            None,
            NAME,
            PageRequest {
                offset: 1,
                limit: 2,
            },
        )
    })
    .unwrap();
    assert_eq!((paths(&second), second.total), (vec!["b.md".to_owned()], 2));
    assert!(matches!(
        read(&catalog, |tx| list_children(
            tx,
            None,
            NAME,
            PageRequest {
                offset: 0,
                limit: MAX_PAGE_SIZE + 1
            }
        )),
        Err(QueryError::InvalidArgument(_))
    ));
}

#[test]
fn rows_and_filters_use_effective_tags_inside_the_course_keep_unknowns_and_do_not_repeat_own_tags()
{
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let ids = add(
        &catalog,
        vec![
            (folder("s"), 0),
            (folder("s/c"), 0),
            (folder("s/c/f"), 0),
            (folder("s/c/f/n"), 0),
            (file("s/c/f/n/own.md", 1, None), 0),
            (file("s/c/f/inherit.md", 1, None), 0),
            (file("s/c/untagged.md", 1, None), 0),
            (file("s/loose.md", 1, None), 0),
            (file("root.md", 1, None), 0),
        ],
    );
    catalog
        .write(|tx| {
            replace_tag_definitions(
                tx,
                &definitions(&[
                    ("early", "Early", 1),
                    ("middle", "Middle", 2),
                    ("own", "Own", 3),
                    ("late", "Late", 4),
                ]),
            )?;
            set_entry_tags(tx, ids[0], &tags(["semester"]))?;
            set_entry_tags(tx, ids[1], &tags(["course"]))?;
            set_entry_tags(tx, ids[2], &tags(["late", "early", "unknown-b", "own"]))?;
            set_entry_tags(tx, ids[3], &tags(["middle", "unknown-a", "early"]))?;
            set_entry_tags(tx, ids[4], &tags(["own", "early", "unknown-a"]))
        })
        .unwrap();
    let row = read(&catalog, |tx| {
        get_entry(tx, ids[4], &path("s/c/f/n/own.md"))
    })
    .unwrap();
    assert_eq!(
        row.tags,
        ["early", "own", "unknown-a"].map(|id| TagId::parse(id).unwrap())
    );
    assert_eq!(
        row.folder_tags,
        ["middle", "late", "unknown-b"].map(|id| TagId::parse(id).unwrap())
    );
    let inherited = read(&catalog, |tx| {
        get_entry(tx, ids[5], &path("s/c/f/inherit.md"))
    })
    .unwrap();
    assert!(inherited.tags.is_empty());
    assert_eq!(
        inherited.folder_tags,
        ["early", "own", "late", "unknown-b"].map(|id| TagId::parse(id).unwrap())
    );
    let nested = read(&catalog, |tx| get_entry(tx, ids[3], &path("s/c/f/n"))).unwrap();
    assert_eq!(
        nested.folder_tags,
        ["own", "late", "unknown-b"].map(|id| TagId::parse(id).unwrap())
    );
    for filter in [
        FileFilter {
            tags: Some(TagFilter::WithAll(vec![
                TagId::parse("early").unwrap(),
                TagId::parse("unknown-b").unwrap(),
            ])),
            added_after_ms: None,
        },
        FileFilter {
            tags: Some(TagFilter::WithAll(vec![
                TagId::parse("unknown-b").unwrap(),
                TagId::parse("early").unwrap(),
                TagId::parse("early").unwrap(),
            ])),
            added_after_ms: None,
        },
    ] {
        assert_eq!(
            paths(&read(&catalog, |tx| list_files(tx, None, &filter, PATH, ALL)).unwrap()),
            ["s/c/f/inherit.md", "s/c/f/n/own.md"]
        );
    }
    let untagged = FileFilter {
        tags: Some(TagFilter::Untagged),
        added_after_ms: None,
    };
    assert_eq!(
        paths(&read(&catalog, |tx| list_files(tx, None, &untagged, PATH, ALL)).unwrap()),
        ["root.md", "s/c/untagged.md", "s/loose.md"]
    );
    for id in ["semester", "course", "absent"] {
        let filter = FileFilter {
            tags: Some(TagFilter::WithAll(vec![TagId::parse(id).unwrap()])),
            added_after_ms: None,
        };
        assert_eq!(
            read(&catalog, |tx| list_files(tx, None, &filter, PATH, ALL))
                .unwrap()
                .total,
            0,
            "{id}"
        );
    }
}

#[test]
fn recently_added_is_strict_compares_nanoseconds_and_handles_the_entire_signed_millisecond_range() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    add(
        &catalog,
        vec![
            (file("a-min.md", 1, None), i64::MIN),
            (file("b-before.md", 1, None), 1_999_999),
            (file("c-equal.md", 1, None), 2_000_000),
            (file("d-after.md", 1, None), 2_000_001),
            (file("e-max.md", 1, None), i64::MAX),
        ],
    );
    for (ms, expected) in [
        (
            i64::MIN,
            vec![
                "a-min.md",
                "b-before.md",
                "c-equal.md",
                "d-after.md",
                "e-max.md",
            ],
        ),
        (2, vec!["d-after.md", "e-max.md"]),
        (
            -9_223_372_036_855,
            vec![
                "a-min.md",
                "b-before.md",
                "c-equal.md",
                "d-after.md",
                "e-max.md",
            ],
        ),
        (
            -9_223_372_036_854,
            vec!["b-before.md", "c-equal.md", "d-after.md", "e-max.md"],
        ),
        (9_223_372_036_854, vec!["e-max.md"]),
        (9_223_372_036_855, vec![]),
        (i64::MAX, vec![]),
    ] {
        let filter = FileFilter {
            added_after_ms: Some(ms),
            ..FileFilter::default()
        };
        let page = read(&catalog, |tx| list_files(tx, None, &filter, PATH, ALL)).unwrap();
        assert_eq!(paths(&page), expected, "{ms}");
        assert_eq!(page.total as usize, expected.len());
    }
}

#[test]
fn references_require_identity_and_exact_case_and_scope_rejects_a_file() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let ids = add(
        &catalog,
        vec![(folder("s"), 0), (file("s/Note.md", 7, Some(8)), 9)],
    );
    let note = path("s/Note.md");
    let row = read(&catalog, |tx| get_entry(tx, ids[1], &note)).unwrap();
    assert_eq!(
        (
            row.entry.id,
            row.entry.record.size,
            row.entry.record.class,
            row.entry.added_ns
        ),
        (ids[1], 7, FileClass::Text, 9)
    );
    for stale in [path("s/note.md"), path("s/Other.md")] {
        assert!(matches!(
            read(&catalog, |tx| get_entry(tx, ids[1], &stale)),
            Err(QueryError::NotFound)
        ));
    }
    assert!(matches!(
        read(&catalog, |tx| get_entry(tx, EntryId(9999), &note)),
        Err(QueryError::NotFound)
    ));
    let query = SearchQuery::parse("Note").unwrap().unwrap();
    assert!(matches!(
        read(&catalog, |tx| list_children(
            tx,
            Some((ids[1], &note)),
            NAME,
            ALL
        )),
        Err(QueryError::InvalidArgument(_))
    ));
    assert!(matches!(
        read(&catalog, |tx| list_files(
            tx,
            Some((ids[1], &note)),
            &FileFilter::default(),
            NAME,
            ALL
        )),
        Err(QueryError::InvalidArgument(_))
    ));
    assert!(matches!(
        read(&catalog, |tx| search_page(
            tx,
            &query,
            Some((ids[1], &note)),
            ALL,
            NOW
        )),
        Err(QueryError::InvalidArgument(_))
    ));
    assert!(matches!(
        read(&catalog, |tx| list_children(
            tx,
            Some((ids[0], &path("S"))),
            NAME,
            ALL
        )),
        Err(QueryError::NotFound)
    ));
    catalog.write(|tx| delete_entry(tx, &note)).unwrap();
    let replacement = add(&catalog, vec![(file(note.as_str(), 99, None), 10)])[0];
    assert_ne!(replacement, ids[1]);
    assert!(matches!(
        read(&catalog, |tx| get_entry(tx, ids[1], &note)),
        Err(QueryError::NotFound)
    ));
    assert_eq!(
        read(&catalog, |tx| get_entry(tx, replacement, &note))
            .unwrap()
            .entry
            .record
            .size,
        99
    );
}

#[test]
fn filter_limits_count_the_request_including_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    for ids in [
        Vec::new(),
        vec![TagId::parse("notes").unwrap(); MAX_FILTER_TAGS + 1],
    ] {
        let filter = FileFilter {
            tags: Some(TagFilter::WithAll(ids)),
            added_after_ms: None,
        };
        assert!(matches!(
            read(&catalog, |tx| list_files(tx, None, &filter, NAME, ALL)),
            Err(QueryError::InvalidArgument(_))
        ));
    }
    let filter = FileFilter {
        tags: Some(TagFilter::WithAll(vec![
            TagId::parse("notes").unwrap();
            MAX_FILTER_TAGS
        ])),
        added_after_ms: None,
    };
    assert_eq!(
        read(&catalog, |tx| list_files(tx, None, &filter, NAME, ALL))
            .unwrap()
            .total,
        0
    );
}

#[test]
fn search_scopes_before_the_candidate_cutoff_and_pages_one_fixed_ranked_window() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let mut records = vec![(folder("s"), 0), (folder("s/c"), 0)];
    // More strong global matches than the candidate budget must not crowd out scoped hits.
    records.extend((0..2_100).map(|i| (file(&format!("needle {i:04}.md"), 1, None), 0)));
    records.extend((0..520).map(|i| {
        let modified = if i % 2 == 0 { NOW } else { NOW - 365 * 86_400 };
        (
            file(
                &format!("s/c/paper {i:04}.md"),
                1,
                Some(modified * 1_000_000_000),
            ),
            0,
        )
    }));
    let ids = add(&catalog, records);
    catalog
        .write(|tx| {
            for id in &ids[2_102..] {
                set_body(tx, *id, Some("needle"))?;
            }
            Ok(())
        })
        .unwrap();
    let query = SearchQuery::parse("needle").unwrap().unwrap();
    let scope = path("s/c");
    let whole = read(&catalog, |tx| {
        search_page(tx, &query, Some((ids[1], &scope)), ALL, NOW)
    })
    .unwrap();
    let expected: Vec<_> = (0..520)
        .step_by(2)
        .chain((1..520).step_by(2))
        .take(500)
        .map(|i| format!("s/c/paper {i:04}.md"))
        .collect();
    assert_eq!(hit_paths(&whole), expected);
    assert!(!whole.more);
    for page_size in [50, 73, 137] {
        let mut partition = Vec::new();
        for offset in (0..SEARCH_RESULTS).step_by(page_size as usize) {
            let limit = page_size.min(SEARCH_RESULTS - offset);
            let page = read(&catalog, |tx| {
                search_page(
                    tx,
                    &query,
                    Some((ids[1], &scope)),
                    PageRequest { offset, limit },
                    NOW,
                )
            })
            .unwrap();
            assert_eq!(page.more, offset + limit < SEARCH_RESULTS);
            partition.extend(hit_paths(&page));
        }
        assert_eq!(partition, expected, "page size {page_size}");
    }
    for (offset, more) in [(0, true), (SEARCH_RESULTS, false)] {
        let page = read(&catalog, |tx| {
            search_page(
                tx,
                &query,
                Some((ids[1], &scope)),
                PageRequest { offset, limit: 0 },
                NOW,
            )
        })
        .unwrap();
        assert!(page.items.is_empty());
        assert_eq!(page.more, more);
    }
}

#[test]
fn candidate_ties_use_the_same_path_length_as_the_final_search_order() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let mut records = Vec::new();
    // One CJK character and one Latin word contribute the same number of FTS path tokens.
    // The CJK paths are shorter in characters but longer in UTF-8 bytes.
    for ch in (0..2_001).map(|i| char::from_u32(0x4E00 + i).unwrap()) {
        records.push((folder(&ch.to_string()), 0));
        records.push((file(&format!("{ch}/needle.md"), 1, None), 0));
    }
    records.push((folder("zz"), 0));
    records.push((file("zz/needle.md", 1, None), 0));
    add(&catalog, records);
    let query = SearchQuery::parse("needle").unwrap().unwrap();
    let hits = read(&catalog, |tx| {
        search_page(
            tx,
            &query,
            None,
            PageRequest {
                offset: 0,
                limit: 1,
            },
            NOW,
        )
    })
    .unwrap();
    assert_eq!(hit_paths(&hits), ["zz/needle.md"]);
}

#[test]
fn search_limits_reject_windows_past_500_and_integer_overflow() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let query = SearchQuery::parse("needle").unwrap().unwrap();
    for page in [
        PageRequest {
            offset: 0,
            limit: MAX_PAGE_SIZE + 1,
        },
        PageRequest {
            offset: 499,
            limit: 2,
        },
        PageRequest {
            offset: 501,
            limit: 0,
        },
        PageRequest {
            offset: u32::MAX,
            limit: 1,
        },
    ] {
        assert!(matches!(
            read(&catalog, |tx| search_page(tx, &query, None, page, NOW)),
            Err(QueryError::InvalidArgument(_))
        ));
    }
    let page = read(&catalog, |tx| {
        search_page(
            tx,
            &query,
            None,
            PageRequest {
                offset: 500,
                limit: 0,
            },
            NOW,
        )
    })
    .unwrap();
    assert_eq!(
        page,
        SearchPage {
            items: Vec::new(),
            more: false
        }
    );
}

#[test]
fn search_highlights_cover_the_name_preserve_plain_text_and_omit_a_body_without_matches() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let ids = add(
        &catalog,
        vec![
            (file("线性代数.md", 1, None), 0),
            (file("other.md", 1, None), 0),
            (file("tagged.pdf", 1, None), 0),
        ],
    );
    catalog
        .write(|tx| {
            replace_tag_definitions(tx, &definitions(&[("algebra", "代数", 1)]))?;
            set_entry_tags(tx, ids[2], &tags(["algebra"]))?;
            set_body(tx, ids[0], Some("unrelated body"))?;
            set_body(tx, ids[1], Some("before \u{1}代数\u{2}\0 <script> after"))
        })
        .unwrap();
    let query = SearchQuery::parse("代数").unwrap().unwrap();
    let page = read(&catalog, |tx| search_page(tx, &query, None, ALL, NOW)).unwrap();
    assert_eq!(page.items.len(), 3);
    let hits: BTreeMap<_, _> = page
        .items
        .iter()
        .map(|hit| (hit.entry.entry.id, &hit.text))
        .collect();
    let span = |text: &str, matched| Span {
        text: text.to_owned(),
        matched,
    };
    assert_eq!(
        hits[&ids[0]].name,
        vec![span("线性", false), span("代数", true), span(".md", false)]
    );
    assert_eq!(hits[&ids[0]].snippet, None);
    assert_eq!(hits[&ids[2]].snippet, None);
    assert!(hits[&ids[2]].name.iter().all(|span| !span.matched));
    let snippet = hits[&ids[1]].snippet.as_ref().unwrap();
    assert!(
        snippet
            .iter()
            .any(|span| span.matched && span.text.contains("代数"))
    );
    assert_eq!(
        snippet
            .iter()
            .map(|span| span.text.as_str())
            .collect::<String>(),
        "before 代数 <script> after"
    );
    for hit in &page.items {
        assert_eq!(
            hit.text
                .name
                .iter()
                .map(|span| span.text.as_str())
                .collect::<String>(),
            hit.entry.entry.record.path.name()
        );
        for span in hit
            .text
            .name
            .iter()
            .chain(hit.text.snippet.iter().flatten())
        {
            assert!(
                !span
                    .text
                    .chars()
                    .any(|ch| matches!(ch, '\0' | '\u{1}' | '\u{2}'))
            );
        }
    }
}

#[test]
fn body_snippets_use_native_phrase_prefix_and_unicode_source_positions() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let id = add(&catalog, vec![(file("document.md", 1, None), 0)])[0];
    for (body, query, expected) in [
        (
            "before 线\r\n性代数 after",
            "线性代数",
            vec!["线\r\n性代数"],
        ),
        ("before algebra after", "alg", vec!["algebra"]),
        ("alpha beta gamma", "alpha bet", vec!["alpha", "beta"]),
        ("alpha-beta gamma", "alpha-beta", vec!["alpha-beta"]),
        ("before Ａ_B after", "a_b", vec!["Ａ_B"]),
        (
            "before カ\u{200b}\u{3099} after",
            "ガ",
            vec!["カ\u{200b}\u{3099}"],
        ),
        ("before ㄱㅏ after", "가", vec!["ㄱㅏ"]),
        ("before ゟ after", "より", vec!["ゟ"]),
    ] {
        catalog.write(|tx| set_body(tx, id, Some(body))).unwrap();
        let query = SearchQuery::parse(query).unwrap().unwrap();
        let page = read(&catalog, |tx| search_page(tx, &query, None, ALL, NOW)).unwrap();
        assert_eq!(page.items.len(), 1);
        let snippet = page.items[0].text.snippet.as_ref().unwrap();
        assert_eq!(
            snippet
                .iter()
                .map(|span| span.text.as_str())
                .collect::<String>(),
            body
        );
        assert_eq!(
            snippet
                .iter()
                .filter(|span| span.matched)
                .map(|span| span.text.as_str())
                .collect::<Vec<_>>(),
            expected,
            "{body:?}"
        );
    }
}

#[test]
fn body_snippets_bound_early_late_dense_and_long_phrase_excerpts_to_sixteen_tokens() {
    use crate::search::{Mode, tokenize};
    use std::ops::ControlFlow;

    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let id = add(&catalog, vec![(file("document.md", 1, None), 0)])[0];
    for (body, query) in [
        (format!("needle {}", "padding ".repeat(10_000)), "needle"),
        (
            format!("{}needle {}", "padding ".repeat(10_000), "tail ".repeat(30)),
            "needle",
        ),
        ("字".repeat(10_000), "字"),
        (
            "字".repeat(10_000),
            "字字字字字字字字字字字字字字字字字字字字",
        ),
    ] {
        catalog.write(|tx| set_body(tx, id, Some(&body))).unwrap();
        let query = SearchQuery::parse(query).unwrap().unwrap();
        let page = read(&catalog, |tx| search_page(tx, &query, None, ALL, NOW)).unwrap();
        assert_eq!(page.items.len(), 1);
        let snippet = page.items[0].text.snippet.as_ref().unwrap();
        let text = snippet
            .iter()
            .map(|span| span.text.as_str())
            .collect::<String>();
        let mut tokens = 0;
        let _ = tokenize(&text, Mode::Highlight, &mut |_| {
            tokens += 1;
            ControlFlow::Continue(())
        });
        assert_eq!(tokens, 16, "{text:?}");
        assert!(snippet.iter().any(|span| span.matched));
        assert!(text.ends_with('…'));
        if body.starts_with("padding") {
            assert!(text.starts_with('…'));
        }
    }
}

#[test]
fn body_snippets_report_corrupt_or_oversized_stored_text_without_truncating_silently() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let id = add(&catalog, vec![(file("document.md", 1, None), 0)])[0];
    let query = SearchQuery::parse("needle").unwrap().unwrap();
    for body in [
        b"needle \xff".to_vec(),
        b"needle \x01".to_vec(),
        b"needle \0 hidden".to_vec(),
        format!("needle {}", "x".repeat(crate::catalog::MAX_BODY_BYTES)).into_bytes(),
    ] {
        catalog
            .write(|tx| {
                tx.execute(
                    "UPDATE search SET body = CAST(?2 AS TEXT) WHERE rowid = ?1",
                    params![id.0, body],
                )?;
                Ok(())
            })
            .unwrap();
        // SQLITE_CORRUPT can also abort the enclosing SQLite read transaction.
        let result = catalog.read(|tx| Ok(search_page(tx, &query, None, ALL, NOW)));
        assert!(matches!(result, Err(_) | Ok(Err(QueryError::Catalog(_)))));
    }
}

#[test]
fn repeated_search_pages_reuse_the_registered_connection_and_cached_highlight_query() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let id = add(&catalog, vec![(file("needle.md", 1, None), 0)])[0];
    catalog
        .write(|tx| set_body(tx, id, Some("body needle tail")))
        .unwrap();
    let query = SearchQuery::parse("needle").unwrap().unwrap();
    let first = read(&catalog, |tx| search_page(tx, &query, None, ALL, NOW)).unwrap();
    for _ in 0..128 {
        assert_eq!(
            read(&catalog, |tx| search_page(tx, &query, None, ALL, NOW)).unwrap(),
            first
        );
    }
    catalog
        .read(|tx| {
            tx.prepare("SELECT folio_snippet16(search) FROM search LIMIT 0")?;
            // A broken table is reported rather than hidden by another function registration.
            Ok(())
        })
        .unwrap();
    catalog
        .write(|tx| {
            tx.execute_batch("DROP TABLE search")?;
            Ok(())
        })
        .unwrap();
    assert!(read(&catalog, |tx| search_page(tx, &query, None, ALL, NOW)).is_err());
}

#[test]
fn search_recency_handles_extreme_clocks_and_modification_times() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    add(
        &catalog,
        vec![
            (file("needle-old.md", 1, Some(i64::MIN)), 0),
            (file("needle-new.md", 1, Some(i64::MAX)), 0),
        ],
    );
    let query = SearchQuery::parse("needle").unwrap().unwrap();
    for now in [i64::MIN, i64::MAX] {
        assert_eq!(
            read(&catalog, |tx| search_page(tx, &query, None, ALL, now))
                .unwrap()
                .items
                .len(),
            2
        );
    }
}

#[test]
fn relative_paths_resolve_nfc_and_each_segment_exactly_before_case_fallback() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let ids = add(
        &catalog,
        vec![
            (folder("S"), 0),
            (folder("S/C"), 0),
            (file("S/C/note.md", 1, None), 0),
            (file("S/C/Image.PNG", 1, None), 0),
            (file("S/C/image.png", 1, None), 0),
            (file("S/C/café.png", 1, None), 0),
            (folder("S/C/Exact"), 0),
            (file("S/C/Exact/Photo.png", 1, None), 0),
            (folder("S/C/exact"), 0),
            (file("S/C/exact/photo.png", 1, None), 0),
            (folder("s"), 0),
            (folder("s/D"), 0),
            (file("s/D/shared.png", 1, None), 0),
            (folder("attachments"), 0),
            (file("attachments/shared.png", 1, None), 0),
        ],
    );
    let requested = [
        "Image.PNG",
        "image.png",
        "IMAGE.PNG",
        "cafe\u{301}.png",
        "Exact/photo.png",
        "exact/Photo.png",
        "EXACT/photo.png",
        ".\\Exact\\\\Photo.png",
        "Exact//./Photo.png",
        "../C/Image.PNG",
        "../../s/d/shared.png",
        "../../ATTACHMENTS/SHARED.PNG",
        "Image.PNG",
    ]
    .map(str::to_owned);
    let resolved = read(&catalog, |tx| {
        resolve_paths(tx, (ids[2], &path("S/C/note.md")), &requested)
    })
    .unwrap();
    let actual: Vec<_> = resolved
        .iter()
        .map(|row| row.as_ref().map(|row| row.entry.record.path.as_str()))
        .collect();
    assert_eq!(
        actual,
        vec![
            Some("S/C/Image.PNG"),
            Some("S/C/image.png"),
            None,
            Some("S/C/café.png"),
            Some("S/C/Exact/Photo.png"),
            Some("S/C/exact/photo.png"),
            None,
            Some("S/C/Exact/Photo.png"),
            Some("S/C/Exact/Photo.png"),
            Some("S/C/Image.PNG"),
            Some("s/D/shared.png"),
            Some("attachments/shared.png"),
            Some("S/C/Image.PNG"),
        ]
    );
    assert_eq!(resolved[0], resolved[12]);
}

#[test]
fn relative_paths_refuse_absolute_schemed_private_missing_folder_and_escaping_targets() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let ids = add(
        &catalog,
        vec![
            (folder("s"), 0),
            (folder("s/c"), 0),
            (file("s/c/note.md", 1, None), 0),
            (folder(".folio"), 0),
            (folder(".folio/local"), 0),
            (file(".folio/local/private.png", 1, None), 0),
        ],
    );
    let requested = [
        "/image.png",
        "\\image.png",
        "C:image.png",
        "C:/image.png",
        "\\\\server\\image.png",
        "https:image.png",
        "file:image.png",
        "data:image.png",
        "image.png:stream",
        "../../../image.png",
        "../../.folio/local/private.png",
        "../../.FOLIO/local/private.png",
        "missing.png",
        "ignored.png",
        "linked.png",
        ".",
        "",
        "..",
        "../../s",
        "CON.png",
    ]
    .map(str::to_owned);
    let resolved = read(&catalog, |tx| {
        resolve_paths(tx, (ids[2], &path("s/c/note.md")), &requested)
    })
    .unwrap();
    assert_eq!(resolved, vec![None; requested.len()]);
    assert!(matches!(
        read(&catalog, |tx| get_entry(
            tx,
            ids[5],
            &path(".folio/local/private.png")
        )),
        Err(QueryError::NotFound)
    ));
}

#[test]
fn relative_path_limits_count_characters_keep_duplicates_and_validate_the_base() {
    let dir = tempfile::tempdir().unwrap();
    let catalog = open_catalog(dir.path());
    let ids = add(
        &catalog,
        vec![(folder("s"), 0), (file("s/note.md", 1, None), 0)],
    );
    let base = path("s/note.md");
    let duplicated = vec!["note.md".to_owned(); MAX_RESOLVE_PATHS];
    let resolved = read(&catalog, |tx| {
        resolve_paths(tx, (ids[1], &base), &duplicated)
    })
    .unwrap();
    assert_eq!(resolved.len(), MAX_RESOLVE_PATHS);
    assert!(
        resolved
            .iter()
            .all(|row| row.as_ref().unwrap().entry.id == ids[1])
    );
    assert!(
        read(&catalog, |tx| resolve_paths(tx, (ids[1], &base), &[]))
            .unwrap()
            .is_empty()
    );
    assert_eq!(
        read(&catalog, |tx| resolve_paths(
            tx,
            (ids[1], &base),
            &["字".repeat(MAX_RELATIVE_PATH_CHARS)]
        ))
        .unwrap(),
        vec![None]
    );
    for requested in [
        vec!["note.md".to_owned(); MAX_RESOLVE_PATHS + 1],
        vec!["字".repeat(MAX_RELATIVE_PATH_CHARS + 1)],
    ] {
        assert!(matches!(
            read(&catalog, |tx| resolve_paths(
                tx,
                (ids[1], &base),
                &requested
            )),
            Err(QueryError::InvalidArgument(_))
        ));
    }
    assert!(matches!(
        read(&catalog, |tx| resolve_paths(tx, (ids[0], &path("s")), &[])),
        Err(QueryError::InvalidArgument(_))
    ));
    assert!(matches!(
        read(&catalog, |tx| resolve_paths(
            tx,
            (ids[1], &path("s/NOTE.md")),
            &[]
        )),
        Err(QueryError::NotFound)
    ));
    assert!(matches!(
        read(&catalog, |tx| resolve_paths(
            tx,
            (EntryId(9999), &base),
            &duplicated
        )),
        Err(QueryError::NotFound)
    ));
}

fn mask_tags(mask: u8) -> BTreeSet<TagId> {
    (0..3)
        .filter(|bit| mask & (1 << bit) != 0)
        .map(|bit| TagId::parse(&format!("t{bit}")).unwrap())
        .collect()
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    #[test]
    fn natural_order_and_page_partitions_match_a_numeric_oracle(
        numbers in prop::collection::vec((any::<u64>(), 0usize..8, any::<bool>()), 0..36),
        descending in any::<bool>(),
        page_size in 1u32..10,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let catalog = open_catalog(dir.path());
        let mut model: Vec<_> = numbers.iter().enumerate().map(|(index, &(number, zeroes, uppercase))| {
            let prefix = if uppercase { "HW" } else { "hw" };
            let width = number.to_string().len() + zeroes;
            (number, index, format!("{prefix}{number:0width$}-{index:03}.md"))
        }).collect();
        add(&catalog, model.iter().rev().map(|(_, _, name)| (file(name, 1, None), 0)).collect());
        // The source numbers, not the production comparator or its digit scanner, are the oracle.
        model.sort_by_key(|(number, index, _)| (*number, *index));
        if descending { model.reverse(); }
        let expected: Vec<_> = model.into_iter().map(|(_, _, name)| name).collect();
        let sort = EntrySort { key: SortKey::Name, descending };
        let whole = read(&catalog, |tx| list_files(tx, None, &FileFilter::default(), sort, ALL)).unwrap();
        prop_assert_eq!(whole.total as usize, expected.len());
        prop_assert_eq!(&paths(&whole), &expected);
        let mut partition = Vec::new();
        for offset in (0..whole.total).step_by(page_size as usize) {
            let page = read(&catalog, |tx| list_files(tx, None, &FileFilter::default(), sort, PageRequest { offset, limit: page_size })).unwrap();
            prop_assert_eq!(page.total, whole.total);
            partition.extend(paths(&page));
        }
        prop_assert_eq!(partition, expected);
    }

    #[test]
    fn effective_filters_permutations_intersections_and_pages_match_an_independent_mask_model(
        folder_mask in 0u8..8,
        nested_mask in 0u8..8,
        records in prop::collection::vec((0u8..3, 0u8..8, -4i64..5), 0..25),
        requested in prop::collection::vec(0u8..3, 1..8),
        first in 0u8..3,
        second in 0u8..3,
        cutoff in -5i64..6,
        page_size in 1u32..8,
    ) {
        let dir = tempfile::tempdir().unwrap();
        let catalog = open_catalog(dir.path());
        let mut added = vec![(folder("s"), 0), (folder("s/c"), 0), (folder("s/c/f"), 0), (folder("s/c/f/n"), 0), (file("outside.md", 1, None), 0)];
        let model: Vec<_> = records.iter().enumerate().map(|(index, &(location, own, ms))| {
            let (parent, inherited) = match location {
                0 => ("s/c", 0),
                1 => ("s/c/f", folder_mask),
                _ => ("s/c/f/n", folder_mask | nested_mask),
            };
            (format!("{parent}/item{index:03}.md"), own | inherited, ms)
        }).collect();
        added.extend(model.iter().map(|(name, _, ms)| (file(name, 1, None), ms * 1_000_000)));
        let ids = add(&catalog, added);
        catalog.write(|tx| {
            // t2 deliberately has no definition; its assignments still affect filters.
            replace_tag_definitions(tx, &definitions(&[("t0", "Zero", 0), ("t1", "One", 1)]))?;
            set_entry_tags(tx, ids[2], &mask_tags(folder_mask))?;
            set_entry_tags(tx, ids[3], &mask_tags(nested_mask))?;
            for (id, (_, own, _)) in ids[5..].iter().zip(&records) {
                set_entry_tags(tx, *id, &mask_tags(*own))?;
            }
            Ok(())
        }).unwrap();
        let scope = path("s/c");
        let query = |tag_filter| {
            let filter = FileFilter { tags: Some(tag_filter), added_after_ms: Some(cutoff) };
            read(&catalog, |tx| list_files(tx, Some((ids[1], &scope)), &filter, PATH, ALL)).unwrap()
        };
        let request_ids: Vec<_> = requested.iter().map(|bit| TagId::parse(&format!("t{bit}")).unwrap()).collect();
        let request_mask = requested.iter().fold(0u8, |mask, bit| mask | (1 << bit));
        let mut expected: Vec<_> = model.iter().filter(|(_, effective, ms)| effective & request_mask == request_mask && *ms > cutoff).map(|(name, _, _)| name.clone()).collect();
        expected.sort();
        let whole = query(TagFilter::WithAll(request_ids.clone()));
        prop_assert_eq!(whole.total as usize, expected.len());
        prop_assert_eq!(&paths(&whole), &expected);
        let mut permuted = request_ids.clone();
        permuted.reverse();
        permuted.extend(request_ids.iter().cloned());
        prop_assert_eq!(&paths(&query(TagFilter::WithAll(permuted))), &expected);
        let single = |bit| TagFilter::WithAll(vec![TagId::parse(&format!("t{bit}")).unwrap()]);
        let a: BTreeSet<_> = paths(&query(single(first))).into_iter().collect();
        let b: BTreeSet<_> = paths(&query(single(second))).into_iter().collect();
        let intersection: Vec<_> = a.intersection(&b).cloned().collect();
        prop_assert_eq!(paths(&query(TagFilter::WithAll(vec![TagId::parse(&format!("t{first}")).unwrap(), TagId::parse(&format!("t{second}")).unwrap()]))), intersection);
        let mut untagged: Vec<_> = model.iter().filter(|(_, effective, ms)| *effective == 0 && *ms > cutoff).map(|(name, _, _)| name.clone()).collect();
        untagged.sort();
        prop_assert_eq!(paths(&query(TagFilter::Untagged)), untagged);
        let filter = FileFilter { tags: Some(TagFilter::WithAll(request_ids)), added_after_ms: Some(cutoff) };
        let mut partition = Vec::new();
        for offset in (0..whole.total).step_by(page_size as usize) {
            let page = read(&catalog, |tx| list_files(tx, Some((ids[1], &scope)), &filter, PATH, PageRequest { offset, limit: page_size })).unwrap();
            prop_assert_eq!(page.total, whole.total);
            partition.extend(paths(&page));
        }
        prop_assert_eq!(partition, expected);
    }
}
