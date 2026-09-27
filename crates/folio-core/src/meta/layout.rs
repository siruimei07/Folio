//! Where the metadata files live (docs/specs/library-core.md §4.1).

use std::path::PathBuf;

use super::{
    CourseMeta, EntryKind, GroupMeta, LibraryConfig, MetaError, RootMeta, TagDefinitions, read,
    write,
};
use crate::paths::{CoursePath, MAX_NAME_UNITS, RelPath, SemesterPath, same_name, utf16_len};

/// Folio's folder at the library root.
const FOLIO_DIR: &str = ".folio";

const ROOT_FILE: &str = "_root.json";
const GROUP_FILE: &str = "_group.json";

/// The paths inside one library's `.folio/` folder. Nothing else builds them.
#[derive(Debug, Clone)]
pub struct Layout {
    root: PathBuf,
}

impl Layout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn folio_dir(&self) -> PathBuf {
        self.root.join(FOLIO_DIR)
    }

    pub fn library_file(&self) -> PathBuf {
        self.folio_dir().join("library.json")
    }

    pub fn tags_file(&self) -> PathBuf {
        self.folio_dir().join("tags.json")
    }

    /// Ignore rules in gitignore syntax (ADR-0002 §2).
    pub fn ignore_file(&self) -> PathBuf {
        self.folio_dir().join("ignore")
    }

    pub fn meta_dir(&self) -> PathBuf {
        self.folio_dir().join("meta")
    }

    /// Temporary files for atomic writes; never synced (ADR-0003 §4).
    pub fn staging_dir(&self) -> PathBuf {
        self.folio_dir().join("local").join("staging")
    }

    /// The path of the file that holds tags in `file`.
    pub fn tag_file_path(&self, file: &TagFile) -> Result<PathBuf, MetaError> {
        match file {
            TagFile::Root => Ok(self.meta_dir().join(ROOT_FILE)),
            TagFile::Group(semester) => self.group_file(semester),
            TagFile::Course(course) => self.course_file(course),
        }
    }

    fn group_file(&self, semester: &SemesterPath) -> Result<PathBuf, MetaError> {
        Ok(self
            .meta_dir()
            .join(escape(semester.name(), "")?)
            .join(GROUP_FILE))
    }

    fn course_file(&self, course: &CoursePath) -> Result<PathBuf, MetaError> {
        Ok(self
            .meta_dir()
            .join(escape(course.semester_name(), "")?)
            .join(escape(course.name(), ".json")?))
    }

    pub fn read_library(&self) -> Result<Option<LibraryConfig>, MetaError> {
        read(&self.library_file())
    }

    pub fn write_library(&self, config: &LibraryConfig) -> Result<(), MetaError> {
        write(self, &self.library_file(), config)
    }

    pub fn read_tags(&self) -> Result<Option<TagDefinitions>, MetaError> {
        read(&self.tags_file())
    }

    pub fn write_tags(&self, tags: &TagDefinitions) -> Result<(), MetaError> {
        write(self, &self.tags_file(), tags)
    }

    pub fn read_root_meta(&self) -> Result<Option<RootMeta>, MetaError> {
        read(&self.tag_file_path(&TagFile::Root)?)
    }

    pub fn write_root_meta(&self, meta: &RootMeta) -> Result<(), MetaError> {
        write(self, &self.tag_file_path(&TagFile::Root)?, meta)
    }

    pub fn read_group_meta(&self, semester: &SemesterPath) -> Result<Option<GroupMeta>, MetaError> {
        read(&self.group_file(semester)?)
    }

    pub fn write_group_meta(
        &self,
        semester: &SemesterPath,
        meta: &GroupMeta,
    ) -> Result<(), MetaError> {
        write(self, &self.group_file(semester)?, meta)
    }

    pub fn read_course_meta(&self, course: &CoursePath) -> Result<Option<CourseMeta>, MetaError> {
        read(&self.course_file(course)?)
    }

    pub fn write_course_meta(
        &self,
        course: &CoursePath,
        meta: &CourseMeta,
    ) -> Result<(), MetaError> {
        write(self, &self.course_file(course)?, meta)
    }
}

/// A semester or course name as it appears in `.folio/meta/`, followed by `suffix`. Names that
/// start with `_` get one more, so they never meet `_root.json` or `_group.json`.
pub(super) fn escape(name: &str, suffix: &str) -> Result<String, MetaError> {
    let prefix = if name.starts_with('_') { "_" } else { "" };
    let escaped = format!("{prefix}{name}{suffix}");
    if utf16_len(&escaped) > MAX_NAME_UNITS {
        return Err(MetaError::NameTooLong {
            name: name.to_owned(),
        });
    }
    Ok(escaped)
}

/// The semester or course name behind a name in `.folio/meta/` (without `.json`), or `None`
/// for a name Folio owns, such as `_group`.
pub fn unescape_name(escaped: &str) -> Option<&str> {
    match escaped.strip_prefix('_') {
        None => Some(escaped),
        Some(rest) if rest.starts_with('_') => Some(rest),
        Some(_) => None,
    }
}

/// The metadata file that holds tags.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum TagFile {
    /// `meta/_root.json`: files at the library root.
    Root,
    /// `meta/<semester>/_group.json`: files directly in a semester.
    Group(SemesterPath),
    /// `meta/<semester>/<course>.json`: everything inside a course.
    Course(CoursePath),
}

/// Where the tags of an entry live: the file, and the key inside it. Semester and course folders
/// carry no tags, so they have no location.
pub fn tag_location(entry: &RelPath, kind: EntryKind) -> Option<(TagFile, RelPath)> {
    if let Some((course, rest)) = entry.course_and_rest() {
        Some((TagFile::Course(course), rest))
    } else if kind == EntryKind::Folder {
        None
    } else if let Some((semester, rest)) = entry.semester_and_rest() {
        Some((TagFile::Group(semester), rest))
    } else {
        Some((TagFile::Root, entry.clone()))
    }
}

/// Whether `path` is Folio's own folder or inside it, whatever the case of its name. Operations
/// on the user's files refuse such paths (docs/specs/library-core.md §3).
pub fn is_folio_owned(path: &RelPath) -> bool {
    path.names()
        .next()
        .is_some_and(|first| same_name(first, FOLIO_DIR))
}
