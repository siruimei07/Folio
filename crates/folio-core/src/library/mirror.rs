//! The catalog's copy of `.folio/` (docs/specs/library-scan.md §7.2–§7.3).

use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::path::Path;

use rusqlite::Connection;

use super::Problem;
use crate::catalog::{
    self, CatalogError, Entry, EntryId, all_courses, all_entry_tags, entries_with_key, entry_by_id,
    put_course, put_semester, remove_course, remove_semester, replace_tag_definitions, semesters,
    set_entry_tags, tag_definitions,
};
use crate::meta::{
    CourseSettings, EntryKind, GroupSettings, MetaTree, Settings, TagDefinitions, TagFile, TagId,
    tag_location,
};
use crate::paths::{CoursePath, RelPath, SemesterPath};

/// Brings tag definitions, semester and course settings and entry tags in line with `tree`.
/// Every scan reads all of `.folio/meta/` (small files); only differences are written. What a
/// file that cannot be read gave the catalog before stays.
pub(super) fn mirror(
    conn: &Connection,
    tree: &MetaTree,
    root: &Path,
    problems: &mut Vec<Problem>,
) -> Result<(), CatalogError> {
    for error in tree.broken().values() {
        problems.push(Problem::metadata(root, error));
    }
    let definitions = match tree.tag_definitions() {
        None => Some(TagDefinitions::default()),
        Some(Ok(definitions)) => Some(definitions.clone()),
        Some(Err(error)) => {
            problems.push(Problem::metadata(root, error));
            None
        }
    };
    if let Some(definitions) = definitions
        && tag_definitions(conn)? != definitions
    {
        replace_tag_definitions(conn, &definitions)?;
    }

    let mut groups = BTreeMap::<SemesterPath, GroupSettings>::new();
    let mut courses = BTreeMap::<CoursePath, CourseSettings>::new();
    let mut tags = BTreeMap::<EntryId, BTreeSet<TagId>>::new();
    let owners = tree.owners();
    for (file, content) in tree.loaded() {
        // The file as the catalog spells its folder, which may differ in case from its name.
        let resolved = match file.folder() {
            None => file.clone(),
            Some(folder) => match find(conn, folder)? {
                Some(entry) if entry.record.kind == EntryKind::Folder => file
                    .with_folder(entry.record.path)
                    .expect("a path that differs only in case"),
                _ => {
                    problems.push(Problem::OrphanedMetadata {
                        folder: folder.clone(),
                    });
                    continue;
                }
            },
        };
        if owners.of(&resolved) != Some(file) {
            problems.push(Problem::OrphanedMetadata {
                folder: file.folder().expect("only folders have twins").clone(),
            });
            continue;
        }
        let file_key = file.key();
        match (&resolved, &content.settings) {
            (TagFile::Group(semester), Some(Settings::Group(settings))) => {
                groups.insert(semester.clone(), settings.clone());
            }
            (TagFile::Course(course), Some(Settings::Course(settings))) => {
                courses.insert(course.clone(), settings.clone());
            }
            _ => {}
        }
        for (key, ids) in content.tags.iter() {
            // A key too long to name anything below its folder names no entry.
            let Ok(path) = key.below(resolved.folder()) else {
                continue;
            };
            let Some(entry) = find(conn, &path)? else {
                continue;
            };
            // Only if this file and key are where the entry's tags belong: a key in a course
            // file cannot tag the course folder itself, for example. Names usually match
            // exactly, which spares building keys.
            let holds = tag_location(&entry.record.path, entry.record.kind).is_some_and(
                |(holder, holder_key)| {
                    (holder == *file || holder.key() == file_key)
                        && (holder_key == *key || holder_key.key() == key.key())
                },
            );
            if holds {
                tags.insert(entry.id, ids.clone());
            }
        }
    }

    // What the files that cannot be read provided stays.
    let unreadable: HashSet<_> = tree.broken().keys().map(TagFile::key).collect();
    let kept = |file: TagFile| unreadable.contains(&file.key());
    let stored = semesters(conn)?;
    for (semester, settings) in &groups {
        if !stored.contains(&(semester.clone(), settings.clone())) {
            put_semester(conn, semester, settings)?;
        }
    }
    for (semester, _) in stored {
        if !groups.contains_key(&semester) && !kept(TagFile::Group(semester.clone())) {
            remove_semester(conn, &semester)?;
        }
    }
    let stored = all_courses(conn)?;
    for (course, settings) in &courses {
        if !stored.contains(&(course.clone(), settings.clone())) {
            put_course(conn, course, settings)?;
        }
    }
    for (course, _) in stored {
        if !courses.contains_key(&course) && !kept(TagFile::Course(course.clone())) {
            remove_course(conn, &course)?;
        }
    }
    let stored = all_entry_tags(conn)?;
    for (entry, ids) in &tags {
        if stored.get(entry) != Some(ids) {
            set_entry_tags(conn, *entry, ids)?;
        }
    }
    for entry in stored.keys() {
        if tags.contains_key(entry) {
            continue;
        }
        let from_unreadable_file = match entry_by_id(conn, *entry)? {
            Some(entry) => tag_location(&entry.record.path, entry.record.kind)
                .is_some_and(|(holder, _)| kept(holder)),
            None => false,
        };
        if !from_unreadable_file {
            set_entry_tags(conn, *entry, &BTreeSet::new())?;
        }
    }
    Ok(())
}

/// The entry at `path`, or else the only one whose path differs from it only in case.
fn find(conn: &Connection, path: &RelPath) -> Result<Option<Entry>, CatalogError> {
    if let Some(entry) = catalog::entry(conn, path)? {
        return Ok(Some(entry));
    }
    let mut same = entries_with_key(conn, &path.key())?;
    Ok(if same.len() == 1 { same.pop() } else { None })
}
