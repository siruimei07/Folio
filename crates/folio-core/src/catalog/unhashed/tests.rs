use std::sync::atomic::AtomicBool;

use super::*;
use crate::fs::Presence;
use crate::workspace::testing::Fixture;

fn reason_of(f: &Fixture, at: &str) -> Option<Blocked> {
    let id = f.entry(at).id;
    f.catalog.read(|tx| unhashed_reason(tx, id)).unwrap()
}

fn rows(f: &Fixture) -> u32 {
    f.catalog
        .read(|tx| Ok(tx.query_row("SELECT count(*) FROM unhashed", [], |row| row.get(0))?))
        .unwrap()
}

/// Runs the hashing pass, however recently files changed, and counts its notifications.
fn hash_counting(f: &Fixture) -> usize {
    let mut commits = 0;
    f.library
        .hash_pending_with_commits(
            &f.catalog,
            f.fs.now_ns() + 10_000_000_000,
            &AtomicBool::new(false),
            &mut |_, _| {},
            &mut || commits += 1,
        )
        .unwrap();
    commits
}

#[test]
fn the_hashing_pass_records_placeholders_and_files_it_cannot_read() {
    let f = Fixture::new();
    f.fs.file("a.md", b"local");
    f.fs.file("cloud.md", b"in the cloud");
    f.fs.file("offline.pdf", b"offline");
    f.fs.file("locked.docx", b"in use");
    f.fs.set_presence("cloud.md", Presence::Placeholder);
    f.fs.set_presence("offline.pdf", Presence::Offline);
    f.fs.fail_reading("locked.docx");
    f.scan();
    // Before the pass reaches them, nothing says why they are unhashed.
    assert_eq!(reason_of(&f, "cloud.md"), None);
    let report = f.hash_all();
    assert_eq!((report.hashed, report.not_local), (1, 2));
    assert_eq!(report.problems.len(), 1);
    assert_eq!(reason_of(&f, "a.md"), None);
    assert_eq!(reason_of(&f, "cloud.md"), Some(Blocked::NotLocal));
    assert_eq!(reason_of(&f, "offline.pdf"), Some(Blocked::NotLocal));
    assert_eq!(reason_of(&f, "locked.docx"), Some(Blocked::Unreadable));
    assert_eq!(rows(&f), 3);
}

#[test]
fn records_go_when_the_file_is_hashed() {
    let f = Fixture::new();
    f.fs.file("cloud.md", b"in the cloud");
    f.fs.file("locked.docx", b"in use");
    f.fs.set_presence("cloud.md", Presence::Placeholder);
    f.fs.fail_reading("locked.docx");
    f.scan();
    f.hash_all();
    assert_eq!(rows(&f), 2);
    // Downloaded, and moved away from the name the fake refuses to read: same entries, same
    // sizes, times and ids, so the records still hold until the pass hashes them.
    f.fs.set_presence("cloud.md", Presence::Local);
    f.fs.rename("locked.docx", "free.docx");
    f.scan();
    assert_eq!(reason_of(&f, "free.docx"), Some(Blocked::Unreadable));
    assert_eq!(f.hash_all().hashed, 2);
    assert_eq!(reason_of(&f, "cloud.md"), None);
    assert_eq!(reason_of(&f, "free.docx"), None);
    assert_eq!(rows(&f), 0);
}

#[test]
fn a_record_of_an_older_version_is_ignored_and_recorded_again() {
    let f = Fixture::new();
    f.fs.file("cloud.md", b"in the cloud");
    f.fs.set_presence("cloud.md", Presence::Placeholder);
    f.scan();
    f.hash_all();
    assert_eq!(reason_of(&f, "cloud.md"), Some(Blocked::NotLocal));
    // Changed in the cloud: another size and time, still not here.
    f.fs.file("cloud.md", b"edited in the cloud");
    f.scan();
    assert_eq!(rows(&f), 1, "the stale record stays");
    assert_eq!(reason_of(&f, "cloud.md"), None, "but no longer holds");
    f.hash_all();
    assert_eq!(reason_of(&f, "cloud.md"), Some(Blocked::NotLocal));
    // The reason changes with what the pass finds.
    f.fs.set_presence("cloud.md", Presence::Local);
    f.fs.fail_reading("cloud.md");
    f.hash_all();
    assert_eq!(reason_of(&f, "cloud.md"), Some(Blocked::Unreadable));
}

#[test]
fn recording_what_the_catalog_says_already_changes_nothing() {
    let f = Fixture::new();
    f.fs.file("cloud.md", b"in the cloud");
    f.fs.set_presence("cloud.md", Presence::Placeholder);
    f.scan();
    // The first record changes the catalog, which a notification follows.
    assert_eq!(hash_counting(&f), 1);
    let revision = f.catalog.stamp().revision;
    assert_eq!(hash_counting(&f), 0);
    assert_eq!(f.catalog.stamp().revision, revision);
}

#[test]
fn a_record_is_written_only_for_the_version_the_pass_read() {
    let f = Fixture::new();
    f.fs.file("cloud.md", b"in the cloud");
    f.scan();
    let read = f.entry("cloud.md");
    f.fs.file("cloud.md", b"changed since");
    f.scan();
    let recorded = f
        .catalog
        .write(|tx| record_unhashed(tx, &read, Blocked::NotLocal))
        .unwrap();
    assert!(!recorded);
    assert_eq!(rows(&f), 0);
    // Nor for a file with a hash.
    f.hash_all();
    let hashed = f.entry("cloud.md");
    let recorded = f
        .catalog
        .write(|tx| record_unhashed(tx, &hashed, Blocked::NotLocal))
        .unwrap();
    assert!(!recorded);
    assert_eq!(rows(&f), 0);
}

#[test]
fn a_record_goes_with_its_entry() {
    let f = Fixture::new();
    f.fs.file("s/cloud.md", b"in the cloud");
    f.fs.set_presence("s/cloud.md", Presence::Placeholder);
    f.scan();
    f.hash_all();
    assert_eq!(rows(&f), 1);
    f.fs.remove("s");
    f.scan();
    assert_eq!(rows(&f), 0);
    assert!(
        !f.catalog
            .write(|tx| clear_unhashed(tx, EntryId(1)))
            .unwrap()
    );
}
