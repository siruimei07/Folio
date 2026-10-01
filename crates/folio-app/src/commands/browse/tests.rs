//! IPC browsing contracts against disposable, scanned libraries.

use std::collections::BTreeSet;
use std::fs::{self, FileTimes};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, mpsc};
use std::thread;
use std::time::{Duration, Instant, UNIX_EPOCH};

use folio_core::catalog::{self, queries};
use folio_core::library::state::{self, Settings};
use folio_core::meta::{CourseMeta, DisplayName, GroupMeta, GroupSettings, Layout, TagId};
use folio_core::paths::{CoursePath, RelPath, SemesterPath};
use tempfile::TempDir;

use super::{children, files, find, get, paths};
use crate::error::AppError;
use crate::ipc::entries::{
    EntryFilter, GetEntry, ListChildren, ListFiles, ResolvePaths, TagFilter,
};
use crate::ipc::jobs::{JobKind, JobStatus};
use crate::ipc::library::OpenLibrary;
use crate::ipc::search::Search;
use crate::ipc::types::{EntryKind, EntryRef, EntryRow, EntrySort, LIMITS, PageRequest, SortKey};
use crate::library::{Event, LibraryState};

const FILES: [&str; 10] = [
    "root.md",
    "Fall/loose.md",
    "Fall/Course/hw10.md",
    "Fall/Course/hw2.md",
    "Fall/Course/Notes/topic.md",
    "Fall/Course/Notes/other.md",
    "Fall/Course/images/图1.png",
    "Fall/Course/note.md",
    "Fall/Course/Case.md",
    "Winter/Other/elsewhere.md",
];

struct Fixture {
    state: LibraryState,
    events: Arc<Mutex<Vec<Event>>>,
    root: PathBuf,
    data: PathBuf,
    _dir: TempDir,
}

impl Fixture {
    fn base() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("library");
        let data = dir.path().join("data");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&data).unwrap();
        let events = Arc::new(Mutex::new(Vec::new()));
        let capture = events.clone();
        let state = LibraryState::new(
            Ok(data.clone()),
            Arc::new(move |event| capture.lock().unwrap().push(event)),
        );
        Self {
            state,
            events,
            root,
            data,
            _dir: dir,
        }
    }

    fn empty() -> Self {
        let fixture = Self::base();
        fixture.state.initialize();
        fixture
    }

    fn populated() -> Self {
        let fixture = Self::base();
        create_library(&fixture.root);
        for path in FILES {
            write_file(&fixture.root, path, b"temporary test content\n");
        }
        let layout = Layout::new(&fixture.root);
        let mut course = CourseMeta::default();
        course.tags.set(rel("Notes"), tags(["notes", "homework"]));
        course
            .tags
            .set(rel("Notes/topic.md"), tags(["notes", "unknown"]));
        course.tags.set(rel("hw2.md"), tags(["homework"]));
        layout
            .write_course_meta(&CoursePath::new(rel("Fall/Course")).unwrap(), &course)
            .unwrap();
        layout
            .write_group_meta(
                &SemesterPath::new(rel("Winter")).unwrap(),
                &GroupMeta {
                    group: Some(GroupSettings {
                        archived: true,
                        order: 0,
                    }),
                    tags: Default::default(),
                },
            )
            .unwrap();
        Settings {
            library_root: Some(fixture.root.clone()),
            ..Settings::default()
        }
        .save(&fixture.data)
        .unwrap();
        fixture.state.initialize();
        wait_for_jobs(&fixture.state);
        fixture
    }

    fn reference(&self, path: &str) -> EntryRef {
        self.state
            .read_catalog(|catalog| {
                let entry = catalog
                    .read(|tx| catalog::entry(tx, &rel(path)))
                    .map_err(|error| AppError::Internal(error.to_string()))?
                    .expect("fixture entry must have been scanned");
                Ok(EntryRef {
                    id: entry.id.to_string(),
                    path: entry.record.path.to_string(),
                })
            })
            .unwrap()
    }

    fn revision(&self) -> u32 {
        self.state
            .read_catalog(|catalog| Ok(catalog.stamp().revision))
            .unwrap()
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

fn rel(path: &str) -> RelPath {
    RelPath::parse(path).unwrap()
}

fn tags<const N: usize>(values: [&str; N]) -> BTreeSet<TagId> {
    values
        .into_iter()
        .map(|tag| TagId::parse(tag).unwrap())
        .collect()
}

fn create_library(root: &Path) {
    state::create(
        root,
        DisplayName::parse("Browse test library").unwrap(),
        ["Notes", "Slides", "Homework", "Exam", "Reference"]
            .map(|name| DisplayName::parse(name).unwrap()),
    )
    .unwrap();
}

fn write_file(root: &Path, path: &str, bytes: &[u8]) {
    let native = rel(path).to_native(root);
    fs::create_dir_all(native.parent().unwrap()).unwrap();
    fs::write(&native, bytes).unwrap();
    // Old mtimes keep the normal hash job out of its fresh-file retry path.
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(native)
        .unwrap()
        .set_times(FileTimes::new().set_modified(UNIX_EPOCH + Duration::from_secs(1_700_000_000)))
        .unwrap();
}

fn wait(mut done: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !done() {
        assert!(Instant::now() < deadline, "browse contract timed out");
        thread::sleep(Duration::from_millis(20));
    }
}

fn wait_for_jobs(state: &LibraryState) {
    wait(|| {
        let jobs = state.list_jobs().unwrap();
        assert!(
            jobs.iter()
                .all(|job| !matches!(job.status, JobStatus::Failed { .. })),
            "fixture jobs failed: {jobs:?}"
        );
        // A scan can finish just before it queues hashing; require that job as well.
        jobs.iter()
            .any(|job| job.kind == JobKind::Hash && matches!(job.status, JobStatus::Done { .. }))
            && jobs
                .iter()
                .all(|job| !matches!(job.status, JobStatus::Queued | JobStatus::Running { .. }))
    });
}

fn page(offset: u32, limit: u32) -> PageRequest {
    PageRequest { offset, limit }
}

fn name_sort() -> EntrySort {
    EntrySort {
        key: SortKey::Name,
        descending: false,
    }
}

fn child_request(folder: Option<EntryRef>) -> ListChildren {
    ListChildren {
        folder,
        sort: name_sort(),
        page: page(0, 200),
    }
}

fn file_request(scope: Option<EntryRef>) -> ListFiles {
    ListFiles {
        scope,
        filter: EntryFilter {
            tags: None,
            added_after_ms: None,
        },
        sort: name_sort(),
        page: page(0, 200),
    }
}

fn search_request(text: &str, scope: Option<EntryRef>) -> Search {
    Search {
        text: text.into(),
        scope,
        page: page(0, 50),
    }
}

fn named_paths(rows: &[EntryRow]) -> Vec<&str> {
    rows.iter().map(|row| row.path.as_str()).collect()
}

fn stale(reference: &EntryRef) -> EntryRef {
    EntryRef {
        id: reference.id.clone(),
        path: "gone.md".into(),
    }
}

fn invalid_reference() -> EntryRef {
    EntryRef {
        id: "0".into(),
        path: "../outside".into(),
    }
}

fn valid_requests(state: &LibraryState, entry: &EntryRef) -> [Result<(), AppError>; 5] {
    [
        children(state, child_request(None)).map(|_| ()),
        files(state, file_request(None)).map(|_| ()),
        get(
            state,
            GetEntry {
                entry: entry.clone(),
            },
        )
        .map(|_| ()),
        find(state, search_request("hw", None)).map(|_| ()),
        paths(
            state,
            ResolvePaths {
                base: entry.clone(),
                paths: vec!["other.md".into()],
            },
        )
        .map(|_| ()),
    ]
}

#[test]
fn exported_limits_match_the_core_query_limits() {
    assert_eq!(LIMITS.page_size, queries::MAX_PAGE_SIZE);
    assert_eq!(LIMITS.search_results, queries::SEARCH_RESULTS);
    assert_eq!(
        LIMITS.query_chars as usize,
        folio_core::search::MAX_QUERY_CHARS
    );
    assert_eq!(LIMITS.filter_tags as usize, queries::MAX_FILTER_TAGS);
    assert_eq!(LIMITS.resolve_paths as usize, queries::MAX_RESOLVE_PATHS);
    assert_eq!(
        LIMITS.relative_path_chars as usize,
        queries::MAX_RELATIVE_PATH_CHARS
    );
}

#[test]
fn every_command_and_empty_requests_require_an_open_library() {
    let fixture = Fixture::empty();
    let entry = EntryRef {
        id: "1".into(),
        path: "Fall/Course/note.md".into(),
    };
    for result in valid_requests(&fixture.state, &entry) {
        assert!(matches!(result, Err(AppError::NoLibrary(_))));
    }
    assert!(matches!(
        find(&fixture.state, search_request("", None)),
        Err(AppError::NoLibrary(_))
    ));
    assert!(matches!(
        paths(
            &fixture.state,
            ResolvePaths {
                base: entry,
                paths: vec![]
            }
        ),
        Err(AppError::NoLibrary(_))
    ));
}

#[test]
fn value_validation_precedes_library_lookup_in_each_command() {
    let fixture = Fixture::empty();
    let invalid = invalid_reference();
    let results = [
        children(&fixture.state, child_request(Some(invalid.clone()))).map(|_| ()),
        files(&fixture.state, file_request(Some(invalid.clone()))).map(|_| ()),
        get(
            &fixture.state,
            GetEntry {
                entry: invalid.clone(),
            },
        )
        .map(|_| ()),
        find(&fixture.state, search_request("", Some(invalid.clone()))).map(|_| ()),
        paths(
            &fixture.state,
            ResolvePaths {
                base: invalid,
                paths: vec![],
            },
        )
        .map(|_| ()),
    ];
    for result in results {
        assert!(matches!(result, Err(AppError::InvalidArgument(_))));
    }
    for id in ["0", "-1", "+1", "1e3", "9223372036854775808"] {
        assert!(
            matches!(
                get(
                    &fixture.state,
                    GetEntry {
                        entry: EntryRef {
                            id: id.into(),
                            path: "note.md".into()
                        }
                    }
                ),
                Err(AppError::InvalidArgument(_))
            ),
            "accepted invalid id {id}"
        );
    }
    for path in [
        "".to_owned(),
        "../outside".into(),
        "Fall\\Course".into(),
        "e\u{301}.md".into(),
        "a/".repeat(16_384),
    ] {
        assert!(matches!(
            get(
                &fixture.state,
                GetEntry {
                    entry: EntryRef {
                        id: "1".into(),
                        path
                    }
                }
            ),
            Err(AppError::InvalidArgument(_))
        ));
    }
}

#[test]
fn page_filter_and_path_limits_win_before_invalid_references() {
    let fixture = Fixture::empty();
    let mut request = child_request(Some(invalid_reference()));
    request.page = page(0, LIMITS.page_size + 1);
    let error = children(&fixture.state, request).unwrap_err();
    assert!(matches!(error, AppError::InvalidArgument(ref detail) if detail.contains("page")));

    let mut request = file_request(Some(invalid_reference()));
    request.page = page(u32::MAX, LIMITS.page_size + 1);
    assert!(
        matches!(files(&fixture.state, request), Err(AppError::InvalidArgument(detail)) if detail.contains("page"))
    );
    for count in [0, LIMITS.filter_tags as usize + 1] {
        let mut request = file_request(Some(invalid_reference()));
        request.filter.tags = Some(TagFilter::WithAll {
            tags: vec!["notes".into(); count],
        });
        assert!(
            matches!(files(&fixture.state, request), Err(AppError::InvalidArgument(detail)) if detail.contains("withAll"))
        );
    }
    let mut request = file_request(None);
    request.filter.tags = Some(TagFilter::WithAll {
        tags: vec!["UPPER".into()],
    });
    assert!(matches!(
        files(&fixture.state, request),
        Err(AppError::InvalidArgument(_))
    ));
    for timestamp in [
        "not-a-time",
        "9223372036854775808",
        "-9223372036854775809",
        "000000000000000000000",
    ] {
        let mut request = file_request(Some(invalid_reference()));
        request.filter.added_after_ms = Some(timestamp.into());
        assert!(
            matches!(files(&fixture.state, request), Err(AppError::InvalidArgument(detail)) if detail.contains("addedAfterMs"))
        );
    }
    for relative in [
        vec![String::new(); LIMITS.resolve_paths as usize + 1],
        vec!["界".repeat(LIMITS.relative_path_chars as usize + 1)],
    ] {
        assert!(matches!(
            paths(&fixture.state, ResolvePaths { base: invalid_reference(), paths: relative }),
            Err(AppError::InvalidArgument(detail)) if detail.contains("relative paths")
        ));
    }
}

#[test]
fn search_length_uses_unicode_characters_and_wins_over_other_errors() {
    let fixture = Fixture::empty();
    let allowed = "界".repeat(LIMITS.query_chars as usize);
    assert!(matches!(
        find(&fixture.state, search_request(&allowed, None)),
        Err(AppError::NoLibrary(_))
    ));
    for text in [
        "界".repeat(LIMITS.query_chars as usize + 1),
        "🦀".repeat(LIMITS.query_chars as usize + 1),
    ] {
        let mut request = search_request(&text, Some(invalid_reference()));
        request.page = page(u32::MAX, LIMITS.page_size + 1);
        assert!(matches!(
            find(&fixture.state, request),
            Err(AppError::QueryTooLong(_))
        ));
    }
    for window in [
        page(0, 501),
        page(500, 1),
        page(u32::MAX, 1),
        page(u32::MAX, 0),
    ] {
        let mut request = search_request("", Some(invalid_reference()));
        request.page = window;
        assert!(
            matches!(find(&fixture.state, request), Err(AppError::InvalidArgument(detail)) if detail.contains("page"))
        );
    }
}

#[test]
fn children_page_folders_first_in_natural_name_order_and_include_loose_files() {
    let fixture = Fixture::populated();
    let root = children(&fixture.state, child_request(None)).unwrap();
    assert_eq!(named_paths(&root.items), ["Fall", "Winter", "root.md"]);
    assert_eq!(root.total, 3);
    assert_eq!(root.revision, fixture.revision());
    let semester = children(
        &fixture.state,
        child_request(Some(fixture.reference("Fall"))),
    )
    .unwrap();
    assert_eq!(
        named_paths(&semester.items),
        ["Fall/Course", "Fall/loose.md"]
    );

    let course = fixture.reference("Fall/Course");
    let whole = children(&fixture.state, child_request(Some(course.clone()))).unwrap();
    assert_eq!(
        whole
            .items
            .iter()
            .map(|row| row.name.as_str())
            .collect::<Vec<_>>(),
        ["images", "Notes", "Case.md", "hw2.md", "hw10.md", "note.md"]
    );
    let mut request = child_request(Some(course));
    request.page = page(3, 2);
    let slice = children(&fixture.state, request.clone()).unwrap();
    assert_eq!(slice.items, whole.items[3..5]);
    assert_eq!(slice.offset, 3);
    assert_eq!(slice.total, 6);
    assert_eq!(slice.revision, whole.revision);
    request.page = page(0, 0);
    let count = children(&fixture.state, request.clone()).unwrap();
    assert!(count.items.is_empty());
    assert_eq!(count.total, 6);
    request.page = page(u32::MAX, LIMITS.page_size);
    let beyond = children(&fixture.state, request).unwrap();
    assert!(beyond.items.is_empty());
    assert_eq!(beyond.offset, u32::MAX);
    assert_eq!(beyond.total, 6);
}

#[test]
fn files_scope_pages_effective_tags_and_recently_added_filters() {
    let fixture = Fixture::populated();
    let whole = files(&fixture.state, file_request(None)).unwrap();
    assert_eq!(whole.total, FILES.len() as u32);
    assert!(whole.items.iter().all(|row| row.kind == EntryKind::File));
    assert!(named_paths(&whole.items).contains(&"Winter/Other/elsewhere.md"));
    assert_eq!(whole.revision, fixture.revision());
    let course = fixture.reference("Fall/Course");
    let scoped = files(&fixture.state, file_request(Some(course.clone()))).unwrap();
    assert_eq!(scoped.total, 7);
    assert!(
        scoped
            .items
            .iter()
            .all(|row| row.path.starts_with("Fall/Course/"))
    );
    let semester = files(
        &fixture.state,
        file_request(Some(fixture.reference("Fall"))),
    )
    .unwrap();
    assert_eq!(semester.total, 8);
    assert!(named_paths(&semester.items).contains(&"Fall/loose.md"));

    let mut request = file_request(Some(course));
    request.filter.tags = Some(TagFilter::WithAll {
        tags: vec!["notes".into(), "homework".into()],
    });
    let tagged = files(&fixture.state, request.clone()).unwrap();
    assert_eq!(
        named_paths(&tagged.items),
        ["Fall/Course/Notes/other.md", "Fall/Course/Notes/topic.md"]
    );
    assert_eq!(tagged.total, 2);
    request.page = page(1, 1);
    let next = files(&fixture.state, request.clone()).unwrap();
    assert_eq!(next.items, tagged.items[1..]);
    assert_eq!(next.total, 2);
    assert_eq!(next.offset, 1);
    assert_eq!(next.revision, tagged.revision);
    request.page = page(0, LIMITS.page_size);
    request.filter.tags = Some(TagFilter::WithAll {
        tags: vec!["notes".into(); LIMITS.filter_tags as usize],
    });
    assert_eq!(
        files(&fixture.state, request.clone()).unwrap().items,
        tagged.items
    );
    request.filter.tags = Some(TagFilter::WithAll {
        tags: vec!["notes".into(), "exam".into()],
    });
    assert_eq!(files(&fixture.state, request).unwrap().total, 0);

    let mut request = file_request(None);
    request.filter.tags = Some(TagFilter::Untagged);
    let untagged = files(&fixture.state, request).unwrap();
    assert_eq!(untagged.total, 7);
    assert!(
        untagged
            .items
            .iter()
            .all(|row| row.tags.is_empty() && row.folder_tags.is_empty())
    );
    for (timestamp, total) in [(i64::MIN, FILES.len() as u32), (i64::MAX, 0)] {
        let mut request = file_request(None);
        request.filter.added_after_ms = Some(timestamp.to_string());
        assert_eq!(files(&fixture.state, request).unwrap().total, total);
    }
    let mut request = file_request(None);
    request.page = page(u32::MAX, 500);
    let beyond = files(&fixture.state, request).unwrap();
    assert!(beyond.items.is_empty());
    assert_eq!(beyond.total, FILES.len() as u32);
}

#[test]
fn get_returns_own_and_inherited_tags_without_duplicates() {
    let fixture = Fixture::populated();
    let entry = fixture.reference("Fall/Course/Notes/topic.md");
    let row = get(
        &fixture.state,
        GetEntry {
            entry: entry.clone(),
        },
    )
    .unwrap();
    assert_eq!(row.id, entry.id);
    assert_eq!(row.path, entry.path);
    assert_eq!(row.name, "topic.md");
    assert_eq!(row.tags, ["notes", "unknown"]);
    assert_eq!(row.folder_tags, ["homework"]);
    let folder = get(
        &fixture.state,
        GetEntry {
            entry: fixture.reference("Fall/Course/Notes"),
        },
    )
    .unwrap();
    assert_eq!(folder.kind, EntryKind::Folder);
    assert_eq!(folder.size, "0");
    assert_eq!(folder.tags, ["notes", "homework"]);
    assert!(folder.folder_tags.is_empty());
}

#[test]
fn references_require_both_live_id_and_exact_case_in_all_commands() {
    let fixture = Fixture::populated();
    let course = fixture.reference("Fall/Course");
    let note = fixture.reference("Fall/Course/note.md");
    let references = [
        stale(&course),
        EntryRef {
            id: course.id.clone(),
            path: "Fall/course".into(),
        },
        EntryRef {
            id: i64::MAX.to_string(),
            path: course.path.clone(),
        },
    ];
    for scope in references {
        for result in [
            children(&fixture.state, child_request(Some(scope.clone()))).map(|_| ()),
            files(&fixture.state, file_request(Some(scope.clone()))).map(|_| ()),
            get(
                &fixture.state,
                GetEntry {
                    entry: scope.clone(),
                },
            )
            .map(|_| ()),
            find(&fixture.state, search_request("hw", Some(scope))).map(|_| ()),
        ] {
            assert!(matches!(result, Err(AppError::NotFound(_))));
        }
    }
    for base in [
        stale(&note),
        EntryRef {
            id: note.id.clone(),
            path: "Fall/Course/NOTE.md".into(),
        },
        EntryRef {
            id: i64::MAX.to_string(),
            path: note.path.clone(),
        },
    ] {
        assert!(matches!(
            paths(
                &fixture.state,
                ResolvePaths {
                    base,
                    paths: vec![]
                }
            ),
            Err(AppError::NotFound(_))
        ));
    }
    assert!(matches!(
        get(
            &fixture.state,
            GetEntry {
                entry: EntryRef {
                    id: note.id,
                    path: ".folio/library.json".into()
                }
            }
        ),
        Err(AppError::NotFound(_))
    ));
}

#[test]
fn folders_are_required_for_scopes_and_files_for_relative_path_bases() {
    let fixture = Fixture::populated();
    let note = fixture.reference("Fall/Course/note.md");
    for result in [
        children(&fixture.state, child_request(Some(note.clone()))).map(|_| ()),
        files(&fixture.state, file_request(Some(note.clone()))).map(|_| ()),
        find(&fixture.state, search_request("hw", Some(note.clone()))).map(|_| ()),
        find(&fixture.state, search_request("", Some(note))).map(|_| ()),
        paths(
            &fixture.state,
            ResolvePaths {
                base: fixture.reference("Fall/Course"),
                paths: vec![],
            },
        )
        .map(|_| ()),
    ] {
        assert!(matches!(result, Err(AppError::InvalidArgument(_))));
    }
    for text in ["", " \t!() "] {
        assert!(matches!(
            find(
                &fixture.state,
                search_request(text, Some(stale(&fixture.reference("Fall/Course"))))
            ),
            Err(AppError::NotFound(_))
        ));
        let empty = find(
            &fixture.state,
            search_request(text, Some(fixture.reference("Fall/Course"))),
        )
        .unwrap();
        assert!(empty.items.is_empty());
        assert!(!empty.more);
        assert_eq!(empty.revision, fixture.revision());
    }
}

#[test]
fn search_pages_share_a_fixed_window_and_return_plain_text_highlights() {
    let fixture = Fixture::populated();
    let mut request = search_request("hw", Some(fixture.reference("Fall/Course")));
    let all = find(&fixture.state, request.clone()).unwrap();
    assert_eq!(all.items.len(), 2);
    assert!(!all.more);
    assert_eq!(all.revision, fixture.revision());
    for hit in &all.items {
        assert_eq!(
            hit.name
                .iter()
                .map(|span| span.text.as_str())
                .collect::<String>(),
            hit.entry.name
        );
        assert!(hit.name.iter().any(|span| span.matched));
        assert!(hit.snippet.is_none());
    }
    request.page = page(0, 1);
    let first = find(&fixture.state, request.clone()).unwrap();
    assert!(first.more);
    request.page = page(1, 1);
    let second = find(&fixture.state, request.clone()).unwrap();
    assert!(!second.more);
    assert_eq!(second.offset, 1);
    assert_eq!(first.revision, second.revision);
    assert_ne!(first.items[0].entry.id, second.items[0].entry.id);
    assert_eq!(
        [first.items[0].clone(), second.items[0].clone()],
        all.items.as_slice()
    );
    request.page = page(0, 0);
    let count = find(&fixture.state, request.clone()).unwrap();
    assert!(count.items.is_empty());
    assert!(count.more);
    request.page = page(500, 0);
    let boundary = find(&fixture.state, request).unwrap();
    assert!(boundary.items.is_empty());
    assert!(!boundary.more);
    assert!(
        find(
            &fixture.state,
            search_request("hw", Some(fixture.reference("Winter")))
        )
        .unwrap()
        .items
        .is_empty()
    );
}

#[test]
fn relative_paths_preserve_order_and_return_null_for_unsafe_or_missing_targets() {
    let fixture = Fixture::populated();
    let base = fixture.reference("Fall/Course/note.md");
    let result = paths(
        &fixture.state,
        ResolvePaths {
            base: base.clone(),
            paths: [
                "images/图1.png",
                "images\\图1.png",
                "./Notes/../images/图1.png",
                "case.md",
                "../../root.md",
                "../../Winter/Other/elsewhere.md",
                "images/图1.png",
                "Notes",
                "missing.md",
                "../../../outside.md",
                "../../.folio/library.json",
                "/root.md",
                "\\root.md",
                "C:\\private.md",
                "images/图1.png:secret",
                "",
            ]
            .map(str::to_owned)
            .into(),
        },
    )
    .unwrap();
    let found = result
        .iter()
        .map(|row| row.as_ref().map(|row| row.path.as_str()))
        .collect::<Vec<_>>();
    assert_eq!(
        found,
        [
            Some("Fall/Course/images/图1.png"),
            Some("Fall/Course/images/图1.png"),
            Some("Fall/Course/images/图1.png"),
            Some("Fall/Course/Case.md"),
            Some("root.md"),
            Some("Winter/Other/elsewhere.md"),
            Some("Fall/Course/images/图1.png"),
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
            None,
        ]
    );
    let boundary = paths(
        &fixture.state,
        ResolvePaths {
            base: base.clone(),
            paths: vec!["images/图1.png".into(); LIMITS.resolve_paths as usize],
        },
    )
    .unwrap();
    assert_eq!(boundary.len(), LIMITS.resolve_paths as usize);
    assert!(boundary.iter().all(Option::is_some));
    let longest = paths(
        &fixture.state,
        ResolvePaths {
            base: base.clone(),
            paths: vec!["🦀".repeat(LIMITS.relative_path_chars as usize)],
        },
    )
    .unwrap();
    assert_eq!(longest, [None]);
    assert!(
        paths(
            &fixture.state,
            ResolvePaths {
                base,
                paths: vec![]
            }
        )
        .unwrap()
        .is_empty()
    );
}

#[test]
fn serialized_rows_keep_decimal_strings_relative_paths_and_text_spans() {
    let fixture = Fixture::populated();
    let reference = fixture.reference("root.md");
    let row = get(
        &fixture.state,
        GetEntry {
            entry: reference.clone(),
        },
    )
    .unwrap();
    let value = serde_json::to_value(&row).unwrap();
    for key in ["id", "size", "modifiedMs", "addedMs"] {
        assert!(
            value[key].is_string(),
            "{key} must cross IPC as a decimal string"
        );
        assert!(value[key].as_str().unwrap().parse::<i64>().is_ok());
    }
    assert_eq!(value["modifiedMs"], "1700000000000");
    assert_eq!(value["kind"], "file");
    assert_eq!(value["class"], "text");
    assert_eq!(value["path"], "root.md");
    fixture
        .state
        .read_catalog(|catalog| {
            catalog
                .write(|tx| {
                    catalog::set_body(
                        tx,
                        catalog::EntryId(reference.id.parse().unwrap()),
                        Some("<img src=x onerror=alert(1)> orbital guide"),
                    )
                })
                .map_err(|error| AppError::Internal(error.to_string()))
        })
        .unwrap();
    let found = find(&fixture.state, search_request("orbital", None)).unwrap();
    assert_eq!(found.items.len(), 1);
    let snippet = found.items[0].snippet.as_ref().unwrap();
    assert!(
        snippet
            .iter()
            .any(|span| span.matched && span.text == "orbital")
    );
    assert!(
        snippet
            .iter()
            .map(|span| span.text.as_str())
            .collect::<String>()
            .contains("<img")
    );
    let serialized = serde_json::to_value(&found).unwrap();
    for span in serialized["items"][0]["snippet"].as_array().unwrap() {
        assert_eq!(span.as_object().unwrap().len(), 2);
        assert!(span["text"].is_string());
        assert!(span["matched"].is_boolean());
    }
    let rows = files(&fixture.state, file_request(None)).unwrap();
    let json = serde_json::to_string(&rows).unwrap();
    assert!(!json.contains(".folio"));
    assert!(!json.contains(&fixture.root.to_string_lossy().replace('\\', "\\\\")));
    assert!(
        rows.items
            .iter()
            .all(|row| !Path::new(&row.path).is_absolute() && !row.path.contains('\\'))
    );
    assert_eq!(rows.revision, found.revision);
}

#[test]
fn catalog_events_and_pages_use_the_core_commit_stamp() {
    let fixture = Fixture::populated();
    let revision = fixture.revision();
    assert!(revision > 0);
    // Internal metadata commits can make revision gaps; it is not an event count.
    wait(|| {
        fixture
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, Event::Catalog(change) if change.revision == revision))
    });
    assert_eq!(
        children(&fixture.state, child_request(None))
            .unwrap()
            .revision,
        revision
    );
    assert_eq!(
        files(&fixture.state, file_request(None)).unwrap().revision,
        revision
    );
    assert_eq!(
        find(&fixture.state, search_request("hw", None))
            .unwrap()
            .revision,
        revision
    );
}

#[test]
fn switching_libraries_waits_for_the_in_flight_catalog_read() {
    let fixture = Fixture::populated();
    let second_root = fixture.root.parent().unwrap().join("second-library");
    fs::create_dir(&second_root).unwrap();
    create_library(&second_root);
    write_file(&second_root, "second.md", b"second library\n");
    let choice = fixture.state.choose(second_root).unwrap();
    let (entered_send, entered_receive) = mpsc::channel();
    let (release_send, release_receive) = mpsc::channel();
    let reader_state = fixture.state.clone();
    let reader = thread::spawn(move || {
        reader_state.read_catalog(|catalog| {
            entered_send.send(()).unwrap();
            release_receive
                .recv_timeout(Duration::from_secs(5))
                .map_err(|error| AppError::Internal(error.to_string()))?;
            catalog
                .read(|tx| catalog::entry(tx, &rel("root.md")))
                .map_err(|error| AppError::Internal(error.to_string()))
        })
    });
    entered_receive
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    let (started_send, started_receive) = mpsc::channel();
    let (finished_send, finished_receive) = mpsc::channel();
    let switch_state = fixture.state.clone();
    let switch = thread::spawn(move || {
        started_send.send(()).unwrap();
        finished_send
            .send(switch_state.open(OpenLibrary {
                folder: choice.token,
            }))
            .unwrap();
    });
    started_receive
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    let while_reading = finished_receive.recv_timeout(Duration::from_millis(100));
    release_send.send(()).unwrap();
    let old_entry = reader.join().unwrap().unwrap().unwrap();
    let was_blocked = matches!(&while_reading, Err(mpsc::RecvTimeoutError::Timeout));
    let opened = match while_reading {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => finished_receive
            .recv_timeout(Duration::from_secs(5))
            .unwrap(),
        Err(error) => panic!("switch exited without its result: {error}"),
    };
    switch.join().unwrap();
    opened.unwrap();
    assert!(
        was_blocked,
        "switch must drain the read before replacing its session"
    );
    assert_eq!(old_entry.record.path.as_str(), "root.md");
    wait_for_jobs(&fixture.state);
    let root = children(&fixture.state, child_request(None)).unwrap();
    assert_eq!(named_paths(&root.items), ["second.md"]);
    assert!(matches!(
        get(
            &fixture.state,
            GetEntry {
                entry: EntryRef {
                    id: old_entry.id.to_string(),
                    path: old_entry.record.path.to_string(),
                }
            }
        ),
        Err(AppError::NotFound(_))
    ));
}

#[test]
fn shutdown_drains_catalog_reads_and_refuses_new_requests() {
    let fixture = Fixture::populated();
    let note = fixture.reference("Fall/Course/note.md");
    let (entered_send, entered_receive) = mpsc::channel();
    let (release_send, release_receive) = mpsc::channel();
    let reader_state = fixture.state.clone();
    let reader = thread::spawn(move || {
        reader_state.read_catalog(|catalog| {
            entered_send.send(()).unwrap();
            release_receive
                .recv_timeout(Duration::from_secs(5))
                .map_err(|error| AppError::Internal(error.to_string()))?;
            Ok(catalog.stamp().revision)
        })
    });
    entered_receive
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    let first_close = fixture.state.begin_close();
    let (started_send, started_receive) = mpsc::channel();
    let (finished_send, finished_receive) = mpsc::channel();
    let closing_state = fixture.state.clone();
    let shutdown = thread::spawn(move || {
        started_send.send(()).unwrap();
        finished_send.send(closing_state.shutdown()).unwrap();
    });
    started_receive
        .recv_timeout(Duration::from_secs(5))
        .unwrap();
    let while_reading = finished_receive.recv_timeout(Duration::from_millis(100));
    let closed_while_reading = fixture.state.is_closed();
    release_send.send(()).unwrap();
    reader.join().unwrap().unwrap();
    let was_blocked = matches!(&while_reading, Err(mpsc::RecvTimeoutError::Timeout));
    let result = match while_reading {
        Ok(result) => result,
        Err(mpsc::RecvTimeoutError::Timeout) => finished_receive
            .recv_timeout(Duration::from_secs(5))
            .unwrap(),
        Err(error) => panic!("shutdown exited without its result: {error}"),
    };
    shutdown.join().unwrap();
    result.unwrap();
    assert!(first_close);
    assert!(
        was_blocked,
        "shutdown must drain the in-flight catalog read"
    );
    assert!(!closed_while_reading);
    assert!(fixture.state.is_closed());
    assert!(matches!(
        fixture
            .state
            .read_catalog::<()>(|_| panic!("closed library accepted a read")),
        Err(AppError::Busy(_))
    ));
    for result in valid_requests(&fixture.state, &note) {
        assert!(matches!(result, Err(AppError::Busy(_))));
    }
}
