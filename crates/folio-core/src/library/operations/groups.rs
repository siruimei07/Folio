use std::collections::{BTreeMap, BTreeSet};

use rusqlite::Connection;

use super::*;
use crate::catalog::Catalog;
use crate::meta::{Abbr, Color, CourseCode, CourseSettings, GroupSettings};
use crate::paths::{CoursePath, SemesterPath};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Semester {
    pub folder: Entry,
    pub archived: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Course {
    pub folder: Entry,
    pub settings: CourseSettings,
    pub files: u32,
}

#[derive(Debug, Clone, Default)]
pub struct CourseFields {
    pub abbr: Option<String>,
    pub code: Option<String>,
    pub color: Option<String>,
}

/// A course nobody has configured yet.
const UNCONFIGURED: CourseSettings = CourseSettings {
    abbr: None,
    archived: false,
    code: None,
    color: None,
    order: 0,
};

impl CourseFields {
    fn settings(&self, order: u32, archived: bool) -> Result<CourseSettings, OperationError> {
        Ok(CourseSettings {
            abbr: self
                .abbr
                .as_deref()
                .map(|text| Abbr::parse(&normalize_text(text)))
                .transpose()?,
            code: self
                .code
                .as_deref()
                .map(|text| CourseCode::parse(&normalize_text(text)))
                .transpose()?,
            color: self.color.as_deref().map(Color::parse).transpose()?,
            order,
            archived,
        })
    }
}

fn semester_entry(tx: &Connection, reference: &EntryRef) -> Result<Entry, OperationError> {
    let entry = resolve(tx, reference)?;
    if entry.record.kind != EntryKind::Folder || entry.record.path.depth() != 1 {
        return Err(OperationError::NotFound);
    }
    Ok(entry)
}

fn course_entry(tx: &Connection, reference: &EntryRef) -> Result<Entry, OperationError> {
    let entry = resolve(tx, reference)?;
    if entry.record.kind != EntryKind::Folder || entry.record.path.depth() != 2 {
        return Err(OperationError::NotFound);
    }
    Ok(entry)
}

fn semester_path(folder: &Entry) -> SemesterPath {
    SemesterPath::new(folder.record.path.clone()).expect("a semester folder")
}

fn course_path(folder: &Entry) -> CoursePath {
    CoursePath::new(folder.record.path.clone()).expect("a course folder")
}

/// Where a group goes: configured groups first, in the user's order, then the others; names
/// break ties.
fn position(order: Option<u32>, folder: &Entry) -> (bool, Option<u32>, &str) {
    (order.is_none(), order, folder.record.path.name())
}

fn semesters(tx: &Connection) -> Result<Vec<Semester>, CatalogError> {
    let settings: BTreeMap<_, _> = catalog::semesters(tx)?.into_iter().collect();
    let of = |folder: &Entry| settings.get(&semester_path(folder));
    let mut folders: Vec<_> = catalog::children(tx, None)?
        .into_iter()
        .filter(|entry| entry.record.kind == EntryKind::Folder)
        .collect();
    folders.sort_by(|a, b| {
        position(of(a).map(|s| s.order), a).cmp(&position(of(b).map(|s| s.order), b))
    });
    Ok(folders
        .into_iter()
        .map(|folder| Semester {
            archived: of(&folder).is_some_and(|settings| settings.archived),
            folder,
        })
        .collect())
}

fn courses(tx: &Connection, semester: &RelPath) -> Result<Vec<Course>, CatalogError> {
    let semester_path = SemesterPath::new(semester.clone()).expect("semester scope");
    let settings: BTreeMap<_, _> = catalog::courses(tx, &semester_path)?.into_iter().collect();
    let of = |folder: &Entry| settings.get(&course_path(folder));
    let mut folders: Vec<_> = catalog::children(tx, Some(semester))?
        .into_iter()
        .filter(|entry| entry.record.kind == EntryKind::Folder)
        .collect();
    folders.sort_by(|a, b| {
        position(of(a).map(|s| s.order), a).cmp(&position(of(b).map(|s| s.order), b))
    });
    folders
        .into_iter()
        .map(|folder| {
            let path = course_path(&folder);
            Ok(Course {
                settings: of(&folder).cloned().unwrap_or(UNCONFIGURED),
                files: catalog::course_files(tx, &path)?,
                folder,
            })
        })
        .collect()
}

fn permutation(
    tx: &Connection,
    references: &[EntryRef],
    current: &[Entry],
) -> Result<(), OperationError> {
    batch_limit(references)?;
    for reference in references {
        resolve(tx, reference)?;
    }
    let ids: BTreeSet<_> = references.iter().map(|reference| reference.id).collect();
    if ids.len() != references.len() || ids != current.iter().map(|entry| entry.id).collect() {
        return Err(OperationError::InvalidArgument(
            "expected every group exactly once",
        ));
    }
    Ok(())
}

impl Library {
    /// The semesters in their visible order, with their authored settings. One whose file cannot
    /// be read keeps what the catalog last had for it.
    fn authored_semesters(
        &self,
        tx: &Connection,
        tree: &MetaTree,
    ) -> Result<Vec<Semester>, OperationError> {
        let mirrored: BTreeMap<_, _> = catalog::semesters(tx)?.into_iter().collect();
        let mut current = semesters(tx)?;
        let mut orders = BTreeMap::new();
        for semester in &mut current {
            let file = TagFile::Group(semester_path(&semester.folder));
            let settings = if unreadable(tree, &file) {
                mirrored.get(&semester_path(&semester.folder)).cloned()
            } else {
                match content(tree, &file)?.1.settings {
                    Some(Settings::Group(settings)) => Some(settings),
                    _ => None,
                }
            };
            semester.archived = settings.as_ref().is_some_and(|settings| settings.archived);
            orders.insert(semester.folder.id, settings.map(|settings| settings.order));
        }
        current.sort_by(|a, b| {
            position(orders[&a.folder.id], &a.folder)
                .cmp(&position(orders[&b.folder.id], &b.folder))
        });
        Ok(current)
    }

    /// The courses of `semester` in their visible order, with their authored settings. One whose
    /// file cannot be read keeps what the catalog last had for it.
    fn authored_courses(
        &self,
        tx: &Connection,
        tree: &MetaTree,
        semester: &RelPath,
    ) -> Result<Vec<Course>, OperationError> {
        let semester_path = SemesterPath::new(semester.clone()).expect("semester scope");
        let mirrored: BTreeMap<_, _> = catalog::courses(tx, &semester_path)?.into_iter().collect();
        let mut current = courses(tx, semester)?;
        let mut orders = BTreeMap::new();
        for course in &mut current {
            let file = TagFile::Course(course_path(&course.folder));
            let settings = if unreadable(tree, &file) {
                mirrored.get(&course_path(&course.folder)).cloned()
            } else {
                match content(tree, &file)?.1.settings {
                    Some(Settings::Course(settings)) => Some(settings),
                    _ => None,
                }
            };
            orders.insert(
                course.folder.id,
                settings.as_ref().map(|settings| settings.order),
            );
            course.settings = settings.unwrap_or(UNCONFIGURED);
        }
        current.sort_by(|a, b| {
            position(orders[&a.folder.id], &a.folder)
                .cmp(&position(orders[&b.folder.id], &b.folder))
        });
        Ok(current)
    }

    pub fn list_semesters(&self, catalog: &Catalog) -> Result<Vec<Semester>, OperationError> {
        Ok(catalog.read(|tx| semesters(tx))?)
    }

    pub fn list_courses(
        &self,
        catalog: &Catalog,
        semester: Option<&EntryRef>,
    ) -> Result<Vec<Course>, OperationError> {
        // A read snapshot; a stale semester reference comes out of it as its own error.
        catalog.read(|tx| {
            Ok((|| -> Result<Vec<Course>, OperationError> {
                if let Some(reference) = semester {
                    return Ok(courses(tx, &semester_entry(tx, reference)?.record.path)?);
                }
                let mut result = Vec::new();
                for semester in semesters(tx)? {
                    result.extend(courses(tx, &semester.folder.record.path)?);
                }
                Ok(result)
            })())
        })?
    }

    fn save_semester(
        &self,
        tree: &MetaTree,
        entry: &Entry,
        settings: GroupSettings,
    ) -> Result<bool, OperationError> {
        let (file, mut value) = content(tree, &TagFile::Group(semester_path(entry)))?;
        if value.settings != Some(Settings::Group(settings.clone())) {
            value.settings = Some(Settings::Group(settings));
            self.write_content(&file, &value)?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Renumbers the semesters in `current` order, `changed` included, and gives `changed` its
    /// `archived` value. Semesters whose files cannot be read keep what they hold. Sets
    /// `written` with each file it changes, so a later failure still reports the earlier ones.
    fn renumber_semesters(
        &self,
        tree: &MetaTree,
        current: &[Semester],
        changed: Option<(&Entry, bool)>,
        written: &mut bool,
    ) -> Result<(), OperationError> {
        for (order, semester) in current.iter().enumerate() {
            let archived = match changed {
                Some((entry, archived)) if entry.id == semester.folder.id => archived,
                _ if unreadable(tree, &TagFile::Group(semester_path(&semester.folder))) => {
                    continue;
                }
                _ => semester.archived,
            };
            *written |= self.save_semester(
                tree,
                &semester.folder,
                GroupSettings {
                    order: order as u32,
                    archived,
                },
            )?;
        }
        Ok(())
    }

    fn check_semesters(&self, current: &[Semester]) -> Result<(), OperationError> {
        for semester in current {
            self.entry_disk(&semester.folder)?;
            self.layout
                .tag_file_path(&TagFile::Group(semester_path(&semester.folder)))?;
        }
        Ok(())
    }

    fn check_courses(&self, current: &[Course]) -> Result<(), OperationError> {
        for course in current {
            self.entry_disk(&course.folder)?;
            self.layout
                .tag_file_path(&TagFile::Course(course_path(&course.folder)))?;
        }
        Ok(())
    }

    fn save_course(
        &self,
        tree: &MetaTree,
        entry: &Entry,
        settings: CourseSettings,
    ) -> Result<bool, OperationError> {
        let (file, mut value) = content(tree, &TagFile::Course(course_path(entry)))?;
        if value.settings != Some(Settings::Course(settings.clone())) {
            value.settings = Some(Settings::Course(settings));
            self.write_content(&file, &value)?;
            return Ok(true);
        }
        Ok(false)
    }

    /// Renumbers the courses in `current` order and gives `changed` its settings. Courses whose
    /// files cannot be read keep what they hold. Sets `written` like `renumber_semesters`.
    fn renumber_courses(
        &self,
        tree: &MetaTree,
        current: &[Course],
        changed: Option<(&Entry, &CourseSettings)>,
        written: &mut bool,
    ) -> Result<(), OperationError> {
        for (order, course) in current.iter().enumerate() {
            let mut settings = match changed {
                Some((entry, settings)) if entry.id == course.folder.id => settings.clone(),
                _ if unreadable(tree, &TagFile::Course(course_path(&course.folder))) => continue,
                _ => course.settings.clone(),
            };
            settings.order = order as u32;
            *written |= self.save_course(tree, &course.folder, settings)?;
        }
        Ok(())
    }

    pub fn create_semester(
        &self,
        catalog: &Catalog,
        text: &str,
        now_ns: i64,
    ) -> Result<Outcome<Semester>, OperationError> {
        let path = name(text)?;
        if is_folio_owned(&path) {
            return Err(OperationError::InvalidArgument("Folio-owned name"));
        }
        let mut changed = None;
        let result = catalog.write_with(|tx| {
            let tree = self.read_meta(tx)?;
            writable(&tree)?;
            let current = self.authored_semesters(tx, &tree)?;
            self.check_semesters(&current)?;
            let file = TagFile::Group(SemesterPath::new(path.clone()).expect("semester"));
            self.layout.tag_file_path(&file)?;
            content(&tree, &file)?;
            let entry = self.create_at(tx, &path, now_ns)?;
            changed = Some(path.clone());
            // Give discovered folders their visible positions so the new folder really goes last.
            // The new folder already makes any failure here `DiskChanged`.
            self.renumber_semesters(&tree, &current, None, &mut false)?;
            self.save_semester(
                &tree,
                &entry,
                GroupSettings {
                    order: current.len() as u32,
                    archived: false,
                },
            )?;
            let mut committed = self.mirror_operation(tx)?;
            committed.entries.push(super::super::EntryChange {
                id: entry.id,
                path,
                kind: super::super::EntryChangeKind::Added,
            });
            committed.groups = true;
            Ok(Outcome {
                value: Semester {
                    folder: entry,
                    archived: false,
                },
                committed,
            })
        });
        self.after_disk_write(catalog, changed, result)
    }

    pub fn update_semester(
        &self,
        catalog: &Catalog,
        reference: &EntryRef,
        archived: bool,
    ) -> Result<Outcome<Semester>, OperationError> {
        let mut written = false;
        let result = catalog.write_with(|tx| {
            let entry = semester_entry(tx, reference)?;
            self.entry_disk(&entry)?;
            let tree = self.read_meta(tx)?;
            writable(&tree)?;
            content(&tree, &TagFile::Group(semester_path(&entry)))?;
            let current = self.authored_semesters(tx, &tree)?;
            self.check_semesters(&current)?;
            self.renumber_semesters(&tree, &current, Some((&entry, archived)), &mut written)?;
            Ok(Outcome {
                value: Semester {
                    folder: entry,
                    archived,
                },
                committed: self.mirror_operation(tx)?,
            })
        });
        self.after_metadata_write(written, result)
    }

    pub fn reorder_semesters(
        &self,
        catalog: &Catalog,
        references: &[EntryRef],
    ) -> Result<Outcome<Vec<Semester>>, OperationError> {
        let mut written = false;
        let result = catalog.write_with(|tx| {
            let current = semesters(tx)?;
            permutation(
                tx,
                references,
                &current
                    .iter()
                    .map(|semester| semester.folder.clone())
                    .collect::<Vec<_>>(),
            )?;
            let tree = self.read_meta(tx)?;
            writable(&tree)?;
            let current = self.authored_semesters(tx, &tree)?;
            self.check_semesters(&current)?;
            // Every semester gets a new position, so every file must be readable.
            for semester in &current {
                content(&tree, &TagFile::Group(semester_path(&semester.folder)))?;
            }
            let by_id: BTreeMap<_, _> = current
                .iter()
                .map(|semester| (semester.folder.id, semester))
                .collect();
            for (order, reference) in references.iter().enumerate() {
                let semester = by_id[&reference.id];
                written |= self.save_semester(
                    &tree,
                    &semester.folder,
                    GroupSettings {
                        order: order as u32,
                        archived: semester.archived,
                    },
                )?;
            }
            let committed = self.mirror_operation(tx)?;
            Ok(Outcome {
                value: semesters(tx)?,
                committed,
            })
        });
        self.after_metadata_write(written, result)
    }

    pub fn create_course(
        &self,
        catalog: &Catalog,
        semester: &EntryRef,
        text: &str,
        fields: &CourseFields,
        now_ns: i64,
    ) -> Result<Outcome<Course>, OperationError> {
        let name = name(text)?;
        let mut settings = fields.settings(0, false)?;
        let mut changed = None;
        let result = catalog.write_with(|tx| {
            let semester = semester_entry(tx, semester)?;
            self.entry_disk(&semester)?;
            let tree = self.read_meta(tx)?;
            writable(&tree)?;
            let current = self.authored_courses(tx, &tree, &semester.record.path)?;
            let path = semester.record.path.join(&name)?;
            self.check_courses(&current)?;
            let file = TagFile::Course(CoursePath::new(path.clone()).expect("course"));
            self.layout.tag_file_path(&file)?;
            content(&tree, &file)?;
            let entry = self.create_at(tx, &path, now_ns)?;
            changed = Some(path.clone());
            // The new folder already makes any failure here `DiskChanged`.
            self.renumber_courses(&tree, &current, None, &mut false)?;
            settings.order = current.len() as u32;
            self.save_course(&tree, &entry, settings.clone())?;
            let mut committed = self.mirror_operation(tx)?;
            committed.entries.push(super::super::EntryChange {
                id: entry.id,
                path,
                kind: super::super::EntryChangeKind::Added,
            });
            committed.groups = true;
            Ok(Outcome {
                value: Course {
                    folder: entry,
                    settings,
                    files: 0,
                },
                committed,
            })
        });
        self.after_disk_write(catalog, changed, result)
    }

    pub fn update_course(
        &self,
        catalog: &Catalog,
        reference: &EntryRef,
        fields: &CourseFields,
        archived: bool,
    ) -> Result<Outcome<Course>, OperationError> {
        let settings = fields.settings(0, archived)?;
        let mut written = false;
        let result = catalog.write_with(|tx| {
            let entry = course_entry(tx, reference)?;
            self.entry_disk(&entry)?;
            let tree = self.read_meta(tx)?;
            writable(&tree)?;
            content(&tree, &TagFile::Course(course_path(&entry)))?;
            let semester = entry.record.path.parent().expect("course parent");
            let current = self.authored_courses(tx, &tree, &semester)?;
            self.check_courses(&current)?;
            self.renumber_courses(&tree, &current, Some((&entry, &settings)), &mut written)?;
            let committed = self.mirror_operation(tx)?;
            let value = courses(tx, &semester)?
                .into_iter()
                .find(|course| course.folder.id == entry.id)
                .ok_or(OperationError::NotFound)?;
            Ok(Outcome { value, committed })
        });
        self.after_metadata_write(written, result)
    }

    pub fn reorder_courses(
        &self,
        catalog: &Catalog,
        semester: &EntryRef,
        references: &[EntryRef],
    ) -> Result<Outcome<Vec<Course>>, OperationError> {
        let mut written = false;
        let result = catalog.write_with(|tx| {
            let semester = semester_entry(tx, semester)?;
            self.entry_disk(&semester)?;
            let current = courses(tx, &semester.record.path)?;
            permutation(
                tx,
                references,
                &current
                    .iter()
                    .map(|course| course.folder.clone())
                    .collect::<Vec<_>>(),
            )?;
            let tree = self.read_meta(tx)?;
            writable(&tree)?;
            let current = self.authored_courses(tx, &tree, &semester.record.path)?;
            self.check_courses(&current)?;
            // Every course gets a new position, so every file must be readable.
            for course in &current {
                content(&tree, &TagFile::Course(course_path(&course.folder)))?;
            }
            let by_id: BTreeMap<_, _> = current
                .iter()
                .map(|course| (course.folder.id, course))
                .collect();
            for (order, reference) in references.iter().enumerate() {
                let course = by_id[&reference.id];
                let mut settings = course.settings.clone();
                settings.order = order as u32;
                written |= self.save_course(&tree, &course.folder, settings)?;
            }
            let committed = self.mirror_operation(tx)?;
            Ok(Outcome {
                value: courses(tx, &semester.record.path)?,
                committed,
            })
        });
        self.after_metadata_write(written, result)
    }
}
