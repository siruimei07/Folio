use std::sync::{Arc, mpsc};
use std::time::Duration;

use super::*;
use crate::catalog::{Catalog, EntryRecord, count_entries, upsert_entry};
use crate::meta::{FileClass, LibraryId};

fn catalog() -> (tempfile::TempDir, Arc<Catalog>) {
    let dir = tempfile::tempdir().unwrap();
    let id = LibraryId::parse("0123456789abcdef0123456789abcdef").unwrap();
    let catalog = Catalog::open(&dir.path().join("catalog.sqlite"), &id)
        .unwrap()
        .catalog;
    (dir, Arc::new(catalog))
}

fn add(conn: &Connection, name: &str) -> Result<(), CatalogError> {
    upsert_entry(
        conn,
        &EntryRecord {
            path: RelPath::parse(name).unwrap(),
            kind: EntryKind::File,
            class: FileClass::Text,
            size: 1,
            mtime_ns: Some(0),
            file_id: None,
            hash: None,
        },
        0,
    )?;
    Ok(())
}

#[test]
fn pinned_snapshot_keeps_its_rows_and_stamp_while_writer_commits() {
    let (_dir, catalog) = catalog();
    catalog.write(|tx| add(tx, "one.md")).unwrap();
    let original = catalog.stamp();
    let (pinned_tx, pinned_rx) = mpsc::channel();
    let (resume_tx, resume_rx) = mpsc::channel();
    let reader_catalog = catalog.clone();
    let reader = std::thread::spawn(move || {
        reader_catalog
            .read_stamped(|tx, stamp| {
                assert_eq!(count_entries(tx)?, 1);
                pinned_tx.send(stamp).unwrap();
                resume_rx.recv_timeout(Duration::from_secs(5)).unwrap();
                Ok::<_, CatalogError>((count_entries(tx)?, stamp))
            })
            .unwrap()
    });
    assert_eq!(
        pinned_rx.recv_timeout(Duration::from_secs(5)).unwrap(),
        original
    );
    catalog.write(|tx| add(tx, "two.md")).unwrap();
    let newer = catalog.stamp();
    assert_eq!(newer.revision, original.revision + 1);
    resume_tx.send(()).unwrap();
    assert_eq!(reader.join().unwrap(), (1, original));
    let after = catalog
        .read_stamped(|tx, stamp| Ok::<_, CatalogError>((count_entries(tx)?, stamp)))
        .unwrap();
    assert_eq!(after, (2, newer));
}

#[test]
fn stamped_reads_do_not_wait_for_an_uncommitted_writer_transaction() {
    let (_dir, catalog) = catalog();
    let (writing_tx, writing_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel();
    let writer_catalog = catalog.clone();
    let writer = std::thread::spawn(move || {
        writer_catalog.write(|tx| {
            add(tx, "pending.md")?;
            writing_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(())
        })
    });
    writing_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let (read_tx, read_rx) = mpsc::channel();
    let reader_catalog = catalog.clone();
    let reader = std::thread::spawn(move || {
        let result = reader_catalog
            .read_stamped(|tx, stamp| Ok::<_, CatalogError>((count_entries(tx)?, stamp.revision)));
        read_tx.send(result).unwrap();
    });
    let observed = read_rx.recv_timeout(Duration::from_secs(2));
    release_tx.send(()).unwrap();
    writer.join().unwrap().unwrap();
    reader.join().unwrap();
    assert_eq!(observed.unwrap().unwrap(), (0, 0));
}

#[test]
fn rollback_failed_commit_and_read_only_transactions_preserve_stamp() {
    let (_dir, catalog) = catalog();
    let original = catalog.stamp();
    let result = catalog.write(|tx| {
        add(tx, "rollback.md")?;
        Err::<(), _>(CatalogError::Invalid("rollback".into()))
    });
    assert!(result.is_err());
    assert_eq!(catalog.stamp(), original);
    catalog
        .write(|tx| {
            assert_eq!(count_entries(tx)?, 0);
            Ok(())
        })
        .unwrap();
    assert_eq!(catalog.stamp(), original);
    let result = catalog.write(|tx| {
        tx.execute_batch("PRAGMA defer_foreign_keys = ON;")?;
        tx.execute(
            "INSERT INTO entries (path, path_key, parent_id, name, kind, class, size, added_ns)
             VALUES ('dangling.md', 'DANGLING.MD', 999, 'dangling.md', 'file', 'text', 1, 0)",
            [],
        )?;
        Ok(())
    });
    assert!(result.is_err(), "deferred foreign key must reject commit");
    assert_eq!(catalog.stamp(), original);
    catalog.write(|tx| add(tx, "committed.md")).unwrap();
    assert_eq!(catalog.stamp().revision, 1);
    assert_eq!(catalog.read(|tx| count_entries(tx)).unwrap(), 1);
}

#[test]
fn concurrent_read_stamp_matches_the_number_of_successful_commits() {
    let (_dir, catalog) = catalog();
    let writer_catalog = catalog.clone();
    let writer = std::thread::spawn(move || {
        for index in 0..40 {
            writer_catalog
                .write(|tx| add(tx, &format!("file{index}.md")))
                .unwrap();
            std::thread::yield_now();
        }
    });
    for _ in 0..60 {
        let (count, stamp) = catalog
            .read_stamped(|tx, stamp| Ok::<_, CatalogError>((count_entries(tx)?, stamp)))
            .unwrap();
        assert_eq!(count, u64::from(stamp.revision));
        std::thread::yield_now();
    }
    writer.join().unwrap();
    assert_eq!(catalog.stamp().revision, 40);
}

#[test]
fn ranking_time_is_fixed_for_a_revision_and_revision_wraps() {
    let (_dir, catalog) = catalog();
    let stamp = catalog
        .read_stamped(|_, stamp| Ok::<_, CatalogError>(stamp))
        .unwrap();
    assert_eq!(
        catalog
            .read_stamped(|_, stamp| Ok::<_, CatalogError>(stamp))
            .unwrap(),
        stamp
    );
    catalog.committed.write().unwrap().revision = u32::MAX;
    catalog.write(|tx| add(tx, "wrapped.md")).unwrap();
    assert_eq!(catalog.stamp().revision, 0);
}
