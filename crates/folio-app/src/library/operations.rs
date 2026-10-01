//! M1 operation request validation and shell/core conversion.

use std::collections::BTreeSet;

use folio_core::catalog::{self, Catalog, Entry, EntryId};
use folio_core::library::operations::{self as core, OperationError};
use folio_core::meta::{Abbr, Color, CourseCode, TagId, ValueError, is_folio_owned};
use folio_core::paths::{PathError, RelPath};
use folio_core::recycle::{RecycleBin, RecycleFailure};

use super::worker::now_ns;
use super::{LibraryState, errors};
use crate::error::AppError;
use crate::ipc::entries::{CreateFolder, DeleteEntries, MoveEntries, RenameEntry};
use crate::ipc::groups::{
    Course, CreateCourse, CreateSemester, ListCourses, ReorderCourses, ReorderSemesters, Semester,
    UpdateCourse, UpdateSemester,
};
use crate::ipc::tags::{
    CreateTag, DeleteTag, ReorderTags, SetEntryTags, Tag, TagDeleted, UpdateTag,
};
use crate::ipc::types::{self, BatchResult, EntryRef, EntryRow, ItemFailure, LIMITS};

impl LibraryState {
    pub fn list_semesters(&self) -> Result<Vec<Semester>, AppError> {
        self.with_reads(|session| {
            session
                .read_operation(|library, catalog| library.list_semesters(catalog))
                .map(|items| items.into_iter().map(semester).collect())
        })
    }

    pub fn create_semester(&self, request: CreateSemester) -> Result<Semester, AppError> {
        let name = file_name(&request.name)?;
        if name.eq_ignore_ascii_case(".folio") {
            return Err(AppError::NameReserved("Folio metadata folder".to_owned()));
        }
        self.with_operations(|session| {
            session
                .mutate(|library, catalog| library.create_semester(catalog, &name, now_ns()))
                .map(semester)
        })
    }

    pub fn update_semester(&self, request: UpdateSemester) -> Result<Semester, AppError> {
        let reference = reference(&request.semester)?;
        self.with_operations(|session| {
            session
                .mutate(|library, catalog| {
                    library.update_semester(catalog, &reference, request.archived)
                })
                .map(semester)
        })
    }

    pub fn reorder_semesters(&self, request: ReorderSemesters) -> Result<Vec<Semester>, AppError> {
        let references = references(&request.semesters)?;
        self.with_operations(|session| {
            session
                .mutate(|library, catalog| library.reorder_semesters(catalog, &references))
                .map(|items| items.into_iter().map(semester).collect())
        })
    }

    pub fn list_courses(&self, request: ListCourses) -> Result<Vec<Course>, AppError> {
        let reference = request.semester.as_ref().map(reference).transpose()?;
        self.with_reads(|session| {
            session
                .read_operation(|library, catalog| {
                    library.list_courses(catalog, reference.as_ref())
                })
                .map(|items| items.into_iter().map(course).collect())
        })
    }

    pub fn create_course(&self, request: CreateCourse) -> Result<Course, AppError> {
        let name = file_name(&request.name)?;
        let fields = course_fields(request.abbr, request.code, request.color)?;
        let reference = reference(&request.semester)?;
        self.with_operations(|session| {
            session
                .mutate(|library, catalog| {
                    library.create_course(catalog, &reference, &name, &fields, now_ns())
                })
                .map(course)
        })
    }

    pub fn update_course(&self, request: UpdateCourse) -> Result<Course, AppError> {
        let fields = course_fields(request.abbr, request.code, request.color)?;
        let reference = reference(&request.course)?;
        self.with_operations(|session| {
            session
                .mutate(|library, catalog| {
                    library.update_course(catalog, &reference, &fields, request.archived)
                })
                .map(course)
        })
    }

    pub fn reorder_courses(&self, request: ReorderCourses) -> Result<Vec<Course>, AppError> {
        let references = references(&request.courses)?;
        let reference = reference(&request.semester)?;
        self.with_operations(|session| {
            session
                .mutate(|library, catalog| {
                    library.reorder_courses(catalog, &reference, &references)
                })
                .map(|items| items.into_iter().map(course).collect())
        })
    }

    pub fn list_tags(&self) -> Result<Vec<Tag>, AppError> {
        self.with_reads(|session| {
            session
                .read_operation(|library, catalog| library.list_tags(catalog))
                .map(|items| items.into_iter().map(tag).collect())
        })
    }

    pub fn create_tag(&self, request: CreateTag) -> Result<Tag, AppError> {
        let name = super::display_name(&request.name)?;
        color(&request.color)?;
        self.with_operations(|session| {
            session
                .mutate(|library, catalog| {
                    library.create_tag(catalog, name.as_str(), &request.color)
                })
                .map(tag)
        })
    }

    pub fn update_tag(&self, request: UpdateTag) -> Result<Tag, AppError> {
        let name = super::display_name(&request.name)?;
        color(&request.color)?;
        let id = tag_id(&request.id)?;
        self.with_operations(|session| {
            session
                .mutate(|library, catalog| {
                    library.update_tag(catalog, &id, name.as_str(), &request.color)
                })
                .map(tag)
        })
    }

    pub fn reorder_tags(&self, request: ReorderTags) -> Result<Vec<Tag>, AppError> {
        batch_limit(request.tags.len())?;
        let ids = request
            .tags
            .iter()
            .map(|id| tag_id(id))
            .collect::<Result<Vec<_>, _>>()?;
        self.with_operations(|session| {
            session
                .mutate(|library, catalog| library.reorder_tags(catalog, &ids))
                .map(|items| items.into_iter().map(tag).collect())
        })
    }

    pub fn delete_tag(&self, request: DeleteTag) -> Result<TagDeleted, AppError> {
        let id = tag_id(&request.id)?;
        self.with_operations(|session| {
            session
                .mutate(|library, catalog| library.delete_tag(catalog, &id))
                .map(|assignments| TagDeleted { assignments })
        })
    }

    pub fn set_entry_tags(&self, request: SetEntryTags) -> Result<BatchResult, AppError> {
        let references = references(&request.entries)?;
        batch_limit(request.add.len())?;
        batch_limit(request.remove.len())?;
        let add = request
            .add
            .iter()
            .map(|id| tag_id(id))
            .collect::<Result<BTreeSet<_>, _>>()?;
        let remove = request
            .remove
            .iter()
            .map(|id| tag_id(id))
            .collect::<Result<BTreeSet<_>, _>>()?;
        if !add.is_disjoint(&remove) {
            return Err(AppError::InvalidArgument(
                "add and remove overlap".to_owned(),
            ));
        }
        self.with_operations(|session| {
            session.mutate_map(
                |library, catalog| library.set_entry_tags(catalog, &references, &add, &remove),
                |_, result| Ok(batch(session, result)),
            )
        })
    }

    pub fn create_folder(&self, request: CreateFolder) -> Result<EntryRow, AppError> {
        let name = file_name(&request.name)?;
        let parent = reference(&request.parent)?;
        self.with_operations(|session| {
            session.mutate_map(
                |library, catalog| library.create_folder(catalog, &parent, &name, now_ns()),
                entry_row,
            )
        })
    }

    pub fn rename_entry(&self, request: RenameEntry) -> Result<EntryRow, AppError> {
        let name = file_name(&request.name)?;
        let reference = reference(&request.entry)?;
        self.with_operations(|session| {
            session.mutate_map(
                |library, catalog| library.rename_entry(catalog, &reference, &name, now_ns()),
                entry_row,
            )
        })
    }

    pub fn move_entries(&self, request: MoveEntries) -> Result<BatchResult, AppError> {
        let references = references(&request.entries)?;
        let target = request.to.as_ref().map(reference).transpose()?;
        self.with_operations(|session| {
            session.mutate_map(
                |library, catalog| {
                    library.move_entries(catalog, &references, target.as_ref(), now_ns())
                },
                |_, result| Ok(batch(session, result)),
            )
        })
    }

    pub fn delete_entries(&self, request: DeleteEntries) -> Result<BatchResult, AppError> {
        self.delete_entries_with_bin(request, &folio_core::win::WindowsRecycleBin)
    }

    fn delete_entries_with_bin(
        &self,
        request: DeleteEntries,
        bin: &dyn RecycleBin,
    ) -> Result<BatchResult, AppError> {
        let references = references(&request.entries)?;
        self.with_operations(|session| {
            session.mutate_map(
                |library, catalog| library.delete_entries(catalog, &references, bin),
                |_, result| Ok(batch(session, result)),
            )
        })
    }
}

/// Checks an entry reference from the page: a positive decimal id and a library path outside
/// `.folio/`. File actions check theirs here too.
pub(super) fn reference(input: &EntryRef) -> Result<core::EntryRef, AppError> {
    let id = input
        .id
        .parse::<i64>()
        .ok()
        .filter(|id| *id > 0 && input.id.bytes().all(|byte| byte.is_ascii_digit()))
        .ok_or_else(|| AppError::InvalidArgument("invalid entry id".to_owned()))?;
    let path = RelPath::parse(&input.path)
        .map_err(|error| AppError::InvalidArgument(error.to_string()))?;
    if is_folio_owned(&path) {
        return Err(AppError::NotFound(
            "Folio metadata is not an entry".to_owned(),
        ));
    }
    Ok(core::EntryRef {
        id: EntryId(id),
        path,
    })
}

fn references(input: &[EntryRef]) -> Result<Vec<core::EntryRef>, AppError> {
    batch_limit(input.len())?;
    input.iter().map(reference).collect()
}

fn batch_limit(count: usize) -> Result<(), AppError> {
    if count > LIMITS.batch as usize {
        Err(AppError::InvalidArgument(
            "batch exceeds LIMITS.batch".to_owned(),
        ))
    } else {
        Ok(())
    }
}

fn file_name(text: &str) -> Result<String, AppError> {
    let text = core::normalize_text(text);
    folio_core::paths::check_name(&text).map_err(path_error)?;
    Ok(text)
}

fn course_fields(
    abbr: Option<String>,
    code: Option<String>,
    colour: Option<String>,
) -> Result<core::CourseFields, AppError> {
    let abbr = abbr.map(|text| core::normalize_text(&text));
    let code = code.map(|text| core::normalize_text(&text));
    if let Some(text) = &abbr {
        if text.is_empty() {
            return Err(AppError::NameEmpty("badge text is empty".to_owned()));
        }
        Abbr::parse(text).map_err(|error| {
            if text.chars().any(|ch| ch.is_whitespace() || ch.is_control()) {
                AppError::NameInvalidCharacter(error.to_string())
            } else {
                AppError::NameTooLong(error.to_string())
            }
        })?;
    }
    if let Some(text) = &code {
        if text.is_empty() {
            return Err(AppError::NameEmpty("course code is empty".to_owned()));
        }
        if text.chars().count() > LIMITS.course_code_chars as usize {
            return Err(AppError::NameTooLong(
                "course code exceeds its limit".to_owned(),
            ));
        }
        CourseCode::parse(text)
            .map_err(|error| AppError::NameInvalidCharacter(error.to_string()))?;
    }
    if let Some(text) = &colour {
        color(text)?;
    }
    Ok(core::CourseFields {
        abbr,
        code,
        color: colour,
    })
}

fn color(text: &str) -> Result<(), AppError> {
    Color::parse(text)
        .map(|_| ())
        .map_err(|error| AppError::InvalidArgument(error.to_string()))
}

fn tag_id(text: &str) -> Result<TagId, AppError> {
    TagId::parse(text).map_err(|error| AppError::InvalidArgument(error.to_string()))
}

fn ipc_reference(entry: &Entry) -> EntryRef {
    EntryRef {
        id: entry.id.to_string(),
        path: entry.record.path.to_string(),
    }
}

fn semester(item: core::Semester) -> Semester {
    Semester {
        folder: ipc_reference(&item.folder),
        name: item.folder.record.path.name().to_owned(),
        archived: item.archived,
    }
}

fn course(item: core::Course) -> Course {
    Course {
        folder: ipc_reference(&item.folder),
        name: item.folder.record.path.name().to_owned(),
        abbr: item.settings.abbr.map(String::from),
        code: item.settings.code.map(String::from),
        color: item.settings.color.map(String::from),
        archived: item.settings.archived,
        files: item.files,
    }
}

fn tag(item: core::Tag) -> Tag {
    Tag {
        id: item.id.into(),
        name: item.definition.name.into(),
        color: item.definition.color.into(),
        usage: item.usage,
    }
}

fn batch(session: &super::worker::Session, result: core::BatchResult) -> BatchResult {
    BatchResult {
        done: result.done,
        failed: result
            .failures
            .into_iter()
            .map(|(entry, error)| {
                session.reconcile_error(&error);
                ItemFailure {
                    entry: EntryRef {
                        id: entry.id.to_string(),
                        path: entry.path.into(),
                    },
                    error: operation_error(error),
                }
            })
            .collect(),
    }
}

fn entry_row(catalog: &Catalog, entry: Entry) -> Result<EntryRow, OperationError> {
    catalog
        .read(|tx| {
            let own = catalog::entry_tags(tx, entry.id)?;
            let mut inherited = BTreeSet::new();
            if let Some(parent) = entry.record.path.parent() {
                for path in parent.ancestors().take_while(|path| path.depth() > 2) {
                    if let Some(folder) = catalog::entry(tx, &path)? {
                        inherited.extend(catalog::entry_tags(tx, folder.id)?);
                    }
                }
            }
            inherited.retain(|id| !own.contains(id));
            let definitions = catalog::tag_definitions(tx)?;
            let ordered = |ids: BTreeSet<TagId>| {
                let mut ids: Vec<_> = ids.into_iter().collect();
                ids.sort_by(|a, b| {
                    let position = |id| {
                        definitions
                            .tags
                            .get(id)
                            .map(|tag| (tag.order, tag.name.as_str()))
                    };
                    let (a_position, b_position) = (position(a), position(b));
                    a_position
                        .is_none()
                        .cmp(&b_position.is_none())
                        .then(a_position.cmp(&b_position))
                        .then(a.cmp(b))
                });
                ids.into_iter().map(String::from).collect()
            };
            Ok(EntryRow {
                id: entry.id.to_string(),
                path: entry.record.path.to_string(),
                name: entry.record.path.name().to_owned(),
                kind: match entry.record.kind {
                    folio_core::meta::EntryKind::File => types::EntryKind::File,
                    folio_core::meta::EntryKind::Folder => types::EntryKind::Folder,
                },
                class: match entry.record.class {
                    folio_core::meta::FileClass::Text => types::FileClass::Text,
                    folio_core::meta::FileClass::Word => types::FileClass::Word,
                    folio_core::meta::FileClass::Other => types::FileClass::Other,
                },
                size: entry.record.size.to_string(),
                modified_ms: entry.record.mtime_ns.map(|ns| (ns / 1_000_000).to_string()),
                added_ms: (entry.added_ns / 1_000_000).to_string(),
                tags: ordered(own),
                folder_tags: ordered(inherited),
            })
        })
        .map_err(|error| OperationError::DiskChanged {
            path: entry.record.path,
            source: Box::new(error.into()),
        })
}

fn path_error(error: PathError) -> AppError {
    let detail = error.to_string();
    match error {
        PathError::Empty => AppError::NameEmpty(detail),
        PathError::NameTooLong => AppError::NameTooLong(detail),
        PathError::TooLong => AppError::PathTooLong(detail),
        PathError::TrailingDotOrSpace => AppError::NameTrailingDotOrSpace(detail),
        PathError::ReservedName | PathError::DotSegment => AppError::NameReserved(detail),
        PathError::ReservedCharacter(_) => AppError::NameInvalidCharacter(detail),
        PathError::NotNfc => AppError::InvalidArgument(detail),
    }
}

fn value_error(error: ValueError) -> AppError {
    AppError::InvalidArgument(error.to_string())
}

pub(super) fn operation_error(error: OperationError) -> AppError {
    let detail = error.to_string();
    match error {
        OperationError::NotFound => AppError::NotFound(detail),
        OperationError::InvalidArgument(_) => AppError::InvalidArgument(detail),
        OperationError::AlreadyExists => AppError::AlreadyExists(detail),
        OperationError::ReadOnly => AppError::ReadOnly(detail),
        OperationError::InvalidMove => AppError::InvalidMove(detail),
        OperationError::UnreadableMetadata(_) => AppError::Internal(detail),
        OperationError::DiskChanged { source, .. }
        | OperationError::RecoveryRequired { source, .. } => operation_error(*source),
        OperationError::NotAttempted => AppError::Busy(detail),
        OperationError::Path(error) => path_error(error),
        OperationError::Value(error) => value_error(error),
        OperationError::Meta(error @ folio_core::meta::MetaError::NewerFormat { .. }) => {
            AppError::ReadOnly(error.to_string())
        }
        OperationError::Meta(error) => errors::meta(error),
        OperationError::Catalog(error) => errors::catalog(error),
        OperationError::Library(folio_core::library::LibraryError::Meta(error)) => {
            operation_error(OperationError::Meta(error))
        }
        OperationError::Library(error) => errors::library(error).error,
        OperationError::InUse { .. } => AppError::InUse(detail),
        OperationError::Io { source, .. } => errors::io(source),
        OperationError::Recycle(error) => match error.failure {
            RecycleFailure::NotFound => AppError::NotFound(detail),
            RecycleFailure::Unrecyclable => AppError::NotRecyclable(detail),
            RecycleFailure::InUse => AppError::InUse(detail),
            RecycleFailure::Denied => AppError::AccessDenied(detail),
            RecycleFailure::Invalid => AppError::Internal(detail),
            RecycleFailure::Other => AppError::FileSystem(detail),
        },
    }
}

#[cfg(test)]
mod tests;
