//! A watcher, the Windows file-system adapter and scans together, on real folders
//! (docs/specs/windows-adapter.md §5.5).

use std::sync::mpsc::Receiver;
use std::time::Instant;

use super::*;
use crate::test_support::{WATCH_TIMEOUT, next_rescan, watch};
use crate::win::{WatchEvent, Watcher, WindowsFileSystem};

/// A real library with `2026 秋/线代/笔记.md` and an empty `2026 秋/概率`, watched with quick
/// rescans, after the watcher's first full rescan.
fn watched() -> (TempDir, Library, Catalog, Watcher, Receiver<WatchEvent>) {
    let (dir, library, catalog) =
        real_library(|root| Arc::new(WindowsFileSystem::open(root).unwrap()));
    std_fs::create_dir_all(library.root().join("2026 秋/概率")).unwrap();
    let (watcher, events) = watch(library.root(), true);
    apply(&library, &catalog, &events);
    (dir, library, catalog, watcher, events)
}

/// Carries out the watcher's next rescan, as the shell will.
fn apply(library: &Library, catalog: &Catalog, events: &Receiver<WatchEvent>) {
    library
        .rescan(catalog, &next_rescan(events), 0, &mut |_, _| {})
        .unwrap();
}

/// Carries out rescans until `done` holds for the catalog.
fn follow(
    library: &Library,
    catalog: &Catalog,
    events: &Receiver<WatchEvent>,
    done: impl Fn(&Catalog) -> bool,
) {
    let deadline = Instant::now() + WATCH_TIMEOUT;
    while !done(catalog) {
        assert!(
            Instant::now() < deadline,
            "the catalog did not follow in time"
        );
        apply(library, catalog, events);
    }
}

/// What a scan decides for each entry. Folder times are left out: a folder's modification
/// record is not scoped, so the next scan that covers the folder catches its time up.
fn summary(catalog: &Catalog) -> Vec<(String, bool, u64, Option<String>)> {
    catalog
        .read(|tx| entries_in(tx, None))
        .unwrap()
        .into_iter()
        .map(|entry| {
            let record = entry.record;
            let folder = record.kind == EntryKind::Folder;
            (record.path.to_string(), folder, record.size, record.file_id)
        })
        .collect()
}

#[test]
fn a_file_moved_between_courses_keeps_its_entry_and_tags() {
    let (_dir, library, catalog, _watcher, events) = watched();
    set_tags(
        library.layout(),
        "2026 秋/线代/笔记.md",
        EntryKind::File,
        tags(["notes"]),
    );
    library.sync_metadata(&catalog).unwrap();
    let before = entry_at(&catalog, "2026 秋/线代/笔记.md").unwrap();

    let root = library.root();
    std_fs::rename(
        root.join("2026 秋/线代/笔记.md"),
        root.join("2026 秋/概率/笔记.md"),
    )
    .unwrap();
    follow(&library, &catalog, &events, |catalog| {
        entry_at(catalog, "2026 秋/概率/笔记.md").is_some()
    });
    // Two scans, one per course, would have removed the entry and added a new one without tags.
    let after = entry_at(&catalog, "2026 秋/概率/笔记.md").unwrap();
    assert_eq!(after.id, before.id);
    assert_eq!(
        catalog.read(|tx| entry_tags(tx, after.id)).unwrap(),
        tags(["notes"])
    );
    assert!(entry_at(&catalog, "2026 秋/线代/笔记.md").is_none());
}

#[test]
fn the_catalog_follows_changes_as_a_fresh_scan_sees_them() {
    let (_dir, library, catalog, _watcher, events) = watched();
    let root = library.root().to_owned();
    let course = root.join("2026 秋/线代");
    std_fs::create_dir_all(course.join("作业")).unwrap();
    std_fs::write(course.join("作业/hw1.md"), "hw1").unwrap();
    std_fs::write(course.join("笔记.md"), "# 特征值与特征向量").unwrap();
    std_fs::rename(course.join("笔记.md"), course.join("复习笔记.md")).unwrap();
    std_fs::create_dir_all(root.join("2026 秋/Math")).unwrap();
    std_fs::write(root.join("2026 秋/Math/a.md"), "a").unwrap();
    std_fs::rename(root.join("2026 秋/Math"), root.join("2026 秋/math")).unwrap();
    // Saved through a temporary file, as editors do.
    std_fs::write(course.join("作业/hw1.md.tmp"), "hw1, second try").unwrap();
    std_fs::rename(course.join("作业/hw1.md.tmp"), course.join("作业/hw1.md")).unwrap();
    std_fs::rename(course.join("作业"), root.join("2026 秋/概率/作业")).unwrap();
    std_fs::remove_file(root.join("2026 秋/math/a.md")).unwrap();

    let fresh_dir = tempfile::tempdir().unwrap();
    let fresh = open_catalog(fresh_dir.path());
    library.scan(&fresh, None, 0).unwrap();
    let expected = summary(&fresh);
    assert!(
        expected
            .iter()
            .any(|(path, ..)| path == "2026 秋/概率/作业/hw1.md")
    );
    follow(&library, &catalog, &events, |catalog| {
        summary(catalog) == expected
    });
}
