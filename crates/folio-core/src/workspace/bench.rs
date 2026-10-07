//! The workspace refresh on a library of 49,920 files (versioning.md §2: the summary and the first
//! page within 100 ms with a few changes, 500 ms when everything changed), in the scan benchmark's
//! shape (`tests/scan_benchmark.rs`: 6 semesters × 8 courses × 5 folders × 208 files), with
//! course settings and a tag on every eighth file. The files live on a [`MemFs`](crate::fs): the
//! workspace reads no user file, only the catalog (a real SQLite file) and `.folio/` (real files).
//!
//! Each scenario changes the library, scans and hashes it as the hash job would, then times what
//! the shell's tracker does on a notification (`Workspace::load`: the stamped read, pairing by
//! path when it finds something to pair, and the derivation) and what the commands do with the
//! cached snapshot (pages, a selection's summary), and the comparison with the last snapshot sent
//! that decides on `WorkspaceChanged`. It fails past the two targets. Ignored by default; build it
//! in release mode and run the test binary itself in a quiet window (testing-strategy.md,
//! Performance):
//!
//! ```text
//! cargo test -p folio-core --release --lib --locked --no-run
//! <the folio_core test binary> workspace::bench --ignored --nocapture --test-threads 1
//! ```

use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use super::testing::{Fixture, write_head};
use super::{HeadState, Selection, Snapshot, Workspace, sync};
use crate::catalog::head_files;
use crate::catalog::queries::PageRequest;
use crate::meta::{
    Assignments, CourseCode, CourseMeta, CourseSettings, EntryKind, TagFile, tag_location,
};
use crate::test_support::{course_at, path, tags};

const SEMESTERS: usize = 6;
const COURSES: usize = 8;
const FOLDERS: [&str; 5] = ["作业", "课件", "笔记", "考试", "参考资料"];
/// Files per course folder: 6 × 8 × 5 × 208 = 49,920 files.
const FILES: usize = 208;
const EXTENSIONS: [&str; 7] = ["pdf", "docx", "pptx", "md", "txt", "xlsx", "png"];
/// Every this many files carries a tag.
const TAGGED: usize = 8;
/// How a renamed file's name changes: `第1讲 资料.pdf` becomes `第1讲 笔记.pdf`.
const RENAMED: (&str, &str) = (" 资料.", " 笔记.");
/// Timed runs after one warm-up run.
const RUNS: usize = 7;
/// versioning.md §2.
const FEW_TARGET: Duration = Duration::from_millis(100);
const ALL_TARGET: Duration = Duration::from_millis(500);

fn semester_name(semester: usize) -> String {
    format!("{} {}", 2024 + semester / 2, ["春", "秋"][semester % 2])
}

fn course_path(semester: usize, course: usize) -> String {
    format!("{}/课程 {course}", semester_name(semester))
}

/// The library's files, in the order they were written.
fn files() -> Vec<String> {
    let mut files = Vec::with_capacity(SEMESTERS * COURSES * FOLDERS.len() * FILES);
    for semester in 0..SEMESTERS {
        for course in 0..COURSES {
            for folder in FOLDERS {
                for file in 0..FILES {
                    let extension = EXTENSIONS[file % EXTENSIONS.len()];
                    files.push(format!(
                        "{}/{folder}/第{file}讲 资料.{extension}",
                        course_path(semester, course)
                    ));
                }
            }
        }
    }
    files
}

/// The content of file `index` in its `version`.
fn content(index: usize, version: &str) -> Vec<u8> {
    format!("file {index} {version}\n").into_bytes()
}

/// A course's settings and the tags of every [`TAGGED`]th file in it.
fn course_meta(semester: usize, course: usize, files: &[String]) -> CourseMeta {
    let at = course_path(semester, course);
    let mut assignments = Assignments::default();
    let prefix = format!("{at}/");
    for (index, file) in files.iter().enumerate() {
        if index % TAGGED == 0 && file.starts_with(&prefix) {
            let (TagFile::Course(_), key) = tag_location(&path(file), EntryKind::File).unwrap()
            else {
                unreachable!("a course file");
            };
            assignments.set(key, tags(["homework"]));
        }
    }
    CourseMeta {
        course: Some(CourseSettings {
            abbr: None,
            archived: false,
            code: Some(CourseCode::parse(&format!("MAT {}{course:02}", semester + 1)).unwrap()),
            color: None,
            order: u32::try_from(course).unwrap(),
        }),
        tags: assignments,
    }
}

/// The median and the slowest of [`RUNS`] runs, after one warm-up run; the last run's result.
fn time<T>(mut run: impl FnMut() -> T) -> (Duration, Duration, T) {
    let mut last = run();
    let mut times = Vec::with_capacity(RUNS);
    for _ in 0..RUNS {
        let started = Instant::now();
        last = run();
        times.push(started.elapsed());
    }
    times.sort();
    (times[RUNS / 2], times[RUNS - 1], last)
}

fn ms(duration: Duration) -> f64 {
    duration.as_secs_f64() * 1e3
}

/// One timed scenario.
struct Measured {
    name: &'static str,
    target: Duration,
    load: Duration,
}

struct Bench {
    f: Fixture,
    files: Vec<String>,
    state: HeadState,
    results: Vec<Measured>,
}

impl Bench {
    /// Scans and hashes, as the hash job would: what the tracker refreshes after.
    fn settle(&self, hash: bool) {
        self.f.scan();
        if hash {
            self.f.hash_all();
        }
    }

    fn load(&self) -> Snapshot {
        Workspace::load(
            &self.f.catalog,
            self.f.layout(),
            &self.state,
            &AtomicBool::new(false),
        )
        .unwrap()
    }

    /// Times the refresh and the commands on the library as it is now, and checks `expect` on
    /// the workspace.
    fn measure(
        &mut self,
        name: &'static str,
        target: Duration,
        expect: impl FnOnce(&Workspace),
    ) -> Snapshot {
        let meta = self.state.meta().unwrap();
        let (read, read_slowest, _) = time(|| {
            self.f
                .catalog
                .read(|tx| head_files::comparison_and_tags(tx, meta.tagged()))
                .unwrap()
        });
        let (load, load_slowest, snapshot) = time(|| self.load());
        let workspace = &snapshot.workspace;
        expect(workspace);
        let totals = workspace.totals();
        println!(
            "{name}: {} items, {} metadata rows; refresh {:.1} / {:.1} ms (the comparison's read \
             {:.1} / {:.1} ms)",
            totals.items,
            totals.metadata,
            ms(load),
            ms(load_slowest),
            ms(read),
            ms(read_slowest),
        );
        self.commands(&snapshot);
        self.results.push(Measured { name, target, load });
        snapshot
    }

    /// What the commands do with a cached snapshot, and the comparison that decides on an event.
    fn commands(&self, snapshot: &Snapshot) {
        let workspace = &snapshot.workspace;
        let total = workspace.totals().items;
        let page = |offset| PageRequest { offset, limit: 200 };
        let (first, _, _) = time(|| workspace.item_page(page(0)).unwrap().rows.len());
        let (last, _, _) = time(|| {
            workspace
                .item_page(page(total.saturating_sub(200)))
                .unwrap()
                .rows
                .len()
        });
        let (metadata, _, _) = time(|| workspace.metadata_page(page(0)).unwrap().rows.len());
        let fingerprint = workspace.fingerprint().to_string();
        let (all, all_slowest, summary) = time(|| {
            let chosen = workspace
                .resolve(&Selection::AllExcept(Vec::new()), &fingerprint)
                .unwrap();
            workspace.summarize(&chosen)
        });
        let some: Vec<String> = workspace
            .items()
            .iter()
            .take(500)
            .map(|item| item.key().to_owned())
            .collect();
        let (only, _, _) = time(|| {
            let chosen = workspace
                .resolve(&Selection::Only(some.clone()), &fingerprint)
                .unwrap();
            workspace.summarize(&chosen).items
        });
        let excluded: Vec<String> = workspace
            .items()
            .iter()
            .rev()
            .take(10_000)
            .map(|item| item.key().to_owned())
            .collect();
        let (except, _, _) = time(|| {
            let chosen = workspace
                .resolve(&Selection::AllExcept(excluded.clone()), &fingerprint)
                .unwrap();
            workspace.summarize(&chosen).items
        });
        let copy = workspace.clone();
        let (equal, _, same) = time(|| copy == *workspace);
        assert!(same);
        println!(
            "  from the cache: page 1 {:.2} ms, last page {:.2} ms, metadata page {:.2} ms; \
             summary of everything {:.1} / {:.1} ms ({} items, {} groups), of 500 keys {:.1} ms, \
             of all but 10,000 keys {:.1} ms; compared with the last snapshot sent {:.1} ms",
            ms(first),
            ms(last),
            ms(metadata),
            ms(all),
            ms(all_slowest),
            summary.items,
            summary.groups.len(),
            ms(only),
            ms(except),
            ms(equal),
        );
    }

    /// Writes `version` into every file at `indices`.
    fn write(&self, indices: impl IntoIterator<Item = usize>, version: &str) {
        for index in indices {
            self.f.fs.file(&self.files[index], &content(index, version));
        }
    }

    fn rename(&self, from: &str, to: &str) {
        self.f.fs.rename(from, to);
    }
}

#[test]
#[ignore = "benchmark; run it in release mode with --ignored --nocapture"]
fn refreshes_the_workspace_of_fifty_thousand_files() {
    let f = Fixture::new();
    let files = files();
    let started = Instant::now();
    for (index, file) in files.iter().enumerate() {
        f.fs.file(file, &content(index, "v1"));
    }
    for semester in 0..SEMESTERS {
        for course in 0..COURSES {
            let meta = course_meta(semester, course, &files);
            f.layout()
                .write_course_meta(&course_at(&course_path(semester, course)), &meta)
                .unwrap();
        }
    }
    println!("{} files written in {:.1?}", files.len(), started.elapsed());
    let step = |label: &str, run: &mut dyn FnMut()| {
        let started = Instant::now();
        run();
        println!("{label}: {:.1?}", started.elapsed());
    };
    step("first scan", &mut || f.scan());
    step("hashing", &mut || {
        f.hash_all();
    });
    let mut head = None;
    step("a commit of everything written as HEAD", &mut || {
        head = Some(write_head(&f.store(), &f.disk_tree(), None, &|_| false).commit);
    });
    let mut state = HeadState::none();
    step(
        "first head sync (packs indexed, HEAD flattened into head_files)",
        &mut || {
            state = f.sync();
        },
    );
    assert_eq!(state.head(), head);
    let (forced, forced_slowest, _) = time(|| f.sync_forced());
    let (skipped, skipped_slowest, _) = time(|| {
        sync(
            &f.catalog,
            f.layout(),
            &f.id(),
            false,
            &AtomicBool::new(false),
        )
        .unwrap()
    });
    println!(
        "head sync, forced (after a rebuild): {:.1} / {:.1} ms; at activation, HEAD already in \
         the catalog: {:.1} / {:.1} ms",
        ms(forced),
        ms(forced_slowest),
        ms(skipped),
        ms(skipped_slowest)
    );

    let mut bench = Bench {
        f,
        files,
        state,
        results: Vec::new(),
    };

    bench.measure("nothing changed", FEW_TARGET, |workspace| {
        assert_eq!(workspace.totals().items, 0);
    });

    // A few changes of every kind: edits, renames, deletions, additions, an empty folder, a tag
    // and a course code.
    let course = course_path(1, 3);
    let original = bench
        .f
        .layout()
        .read_course_meta(&course_at(&course))
        .unwrap()
        .unwrap();
    let edited: Vec<usize> = (0..10).map(|n| n * 4_999).collect();
    bench.write(edited.iter().copied(), "v2, edited");
    let renamed = [101, 20_202, 40_404];
    for index in renamed {
        let from = bench.files[index].clone();
        bench.rename(&from, &from.replace(RENAMED.0, RENAMED.1));
    }
    let deleted = [7, 30_003];
    for index in deleted {
        bench.f.fs.remove(&bench.files[index]);
    }
    let added = [
        format!("{course}/作业/新作业.md"),
        format!("{}/参考资料/new.pdf", course_path(4, 0)),
        "readme.txt".to_owned(),
    ];
    for at in &added {
        bench.f.fs.file(at, b"new");
    }
    bench.f.fs.folder("Personal");
    let mut meta = original.clone();
    let settings = meta.course.as_mut().unwrap();
    settings.code = Some(CourseCode::parse("MAT 999").unwrap());
    // A file of that course that had no tag (its index is not a multiple of TAGGED).
    let first = (COURSES + 3) * FOLDERS.len() * FILES;
    let tagged_at = tag_location(&path(&bench.files[first + 1]), EntryKind::File)
        .unwrap()
        .1;
    meta.tags.set(tagged_at, tags(["exam"]));
    bench
        .f
        .layout()
        .write_course_meta(&course_at(&course), &meta)
        .unwrap();
    bench.settle(true);
    bench.measure("a few changes", FEW_TARGET, |workspace| {
        assert_eq!(workspace.totals().items, 19);
        assert_eq!(workspace.totals().metadata, 2);
    });
    // Back to HEAD's state.
    for index in edited {
        bench.write([index], "v1");
    }
    for index in renamed {
        let to = bench.files[index].clone();
        bench.rename(&to.replace(RENAMED.0, RENAMED.1), &to);
    }
    for index in deleted {
        bench.write([index], "v1");
    }
    for at in &added {
        bench.f.fs.remove(at);
    }
    bench.f.fs.remove("Personal");
    bench
        .f
        .layout()
        .write_course_meta(&course_at(&course), &original)
        .unwrap();
    bench.settle(true);
    assert_eq!(bench.load().workspace.totals().items, 0);

    // A course renamed: one item, with the 1,040 files and 5 folders that moved with it.
    let renamed_course = course_path(1, 3).replace("课程 3", "课程 三");
    bench.rename(&course, &renamed_course);
    bench.settle(true);
    bench.measure("a course renamed", FEW_TARGET, |workspace| {
        assert_eq!(workspace.totals().items, 1);
    });
    bench.rename(&renamed_course, &course);
    bench.settle(true);

    // Every file edited, while the hash job has not reached them yet, then once it has.
    let every: Vec<usize> = (0..bench.files.len()).collect();
    bench.write(every.iter().copied(), "v2, edited everywhere");
    bench.settle(false);
    let count = u32::try_from(bench.files.len()).unwrap();
    bench.measure(
        "every file edited, not hashed yet",
        ALL_TARGET,
        |workspace| {
            assert_eq!(workspace.totals().items, count);
            assert_eq!(workspace.totals().hashing, count);
        },
    );
    bench.f.hash_all();
    let snapshot = bench.measure("every file edited", ALL_TARGET, |workspace| {
        assert_eq!(workspace.totals().items, count);
        assert_eq!(workspace.totals().hashing, 0);
    });
    // For feat/core-commit-history: the commit's tree when everything is chosen.
    let rows = bench
        .f
        .catalog
        .read(|tx| head_files::head_rows(tx))
        .unwrap();
    let chosen = snapshot
        .workspace
        .resolve(
            &Selection::AllExcept(Vec::new()),
            &snapshot.workspace.fingerprint().to_string(),
        )
        .unwrap();
    let (apply, _, applied) = time(|| snapshot.workspace.apply(rows.clone(), &chosen).unwrap());
    println!(
        "  the commit's tree of everything (apply, {} rows): {:.1} ms",
        applied.nodes().len(),
        ms(apply)
    );
    drop(snapshot);
    bench.write(every.iter().copied(), "v1");
    bench.settle(true);

    // Every file renamed in its folder: 49,920 moves.
    for file in &bench.files {
        bench.f.fs.rename(file, &file.replace(RENAMED.0, RENAMED.1));
    }
    bench.settle(true);
    bench.measure("every file renamed", ALL_TARGET, |workspace| {
        assert_eq!(workspace.totals().items, count);
    });
    for file in &bench.files {
        bench.f.fs.rename(&file.replace(RENAMED.0, RENAMED.1), file);
    }
    bench.settle(true);

    // Every semester renamed: 6 items, with every row below them.
    for semester in 0..SEMESTERS {
        let name = semester_name(semester);
        bench.rename(&name, &format!("{name} 学期"));
    }
    bench.settle(true);
    bench.measure("every semester renamed", ALL_TARGET, |workspace| {
        assert_eq!(workspace.totals().items, 6);
    });
    for semester in 0..SEMESTERS {
        let name = semester_name(semester);
        bench.rename(&format!("{name} 学期"), &name);
    }
    bench.settle(true);
    assert_eq!(bench.load().workspace.totals().items, 0);

    // Everything deleted: 6 items covering every row, and the 48 courses' settings.
    for semester in 0..SEMESTERS {
        bench.f.fs.remove(&semester_name(semester));
    }
    bench.settle(true);
    bench.measure("everything deleted", ALL_TARGET, |workspace| {
        assert_eq!(workspace.totals().items, 6);
    });

    // Everything written again, as new entries: the first refresh pairs every row again by path
    // and reads again (one run: the next has nothing to pair).
    bench.write(every.iter().copied(), "v1");
    bench.settle(true);
    let started = Instant::now();
    let snapshot = bench.load();
    let paired = started.elapsed();
    assert_eq!(snapshot.workspace.totals().items, 0);
    assert_eq!(snapshot.workspace.totals().metadata, 0);
    println!(
        "everything written again: refresh {:.1} ms with every row paired again by path (one run)",
        ms(paired)
    );
    bench.results.push(Measured {
        name: "everything written again",
        target: ALL_TARGET,
        load: paired,
    });

    let over: Vec<String> = bench
        .results
        .iter()
        .filter(|measured| measured.load > measured.target)
        .map(|measured| {
            format!(
                "{}: {:.1} ms over {} ms",
                measured.name,
                ms(measured.load),
                measured.target.as_millis()
            )
        })
        .collect();
    assert!(over.is_empty(), "past the targets: {over:?}");
}
