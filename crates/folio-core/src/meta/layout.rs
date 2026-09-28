//! Where the metadata files live (docs/specs/library-core.md §4.1).

use std::path::{Path, PathBuf};

use super::{
    CourseMeta, EntryKind, GroupMeta, LibraryConfig, MetaError, RootMeta, TagDefinitions, read,
    read_bytes, write,
};
use crate::files;
use crate::paths::{
    CoursePath, MAX_NAME_UNITS, PathKey, RelPath, SemesterPath, same_name, utf16_len,
};

/// Folio's folder at the library root.
const FOLIO_DIR: &str = ".folio";

pub(super) const ROOT_FILE: &str = "_root.json";
pub(super) const GROUP_FILE: &str = "_group.json";

/// The paths inside one library's `.folio/` folder. Nothing else builds them.
#[derive(Debug, Clone)]
pub struct Layout {
    root: PathBuf,
}

impl Layout {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    /// The library folder.
    pub fn root(&self) -> &Path {
        &self.root
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

    /// The journal of a scan's metadata writes (docs/specs/library-scan.md §7.1); never synced
    /// (ADR-0003 §4).
    pub fn scan_journal_file(&self) -> PathBuf {
        self.folio_dir()
            .join("local")
            .join("journal")
            .join("scan.json")
    }

    /// The path of the file that holds tags in `file`.
    pub fn tag_file_path(&self, file: &TagFile) -> Result<PathBuf, MetaError> {
        let mut path = self.meta_dir();
        path.extend(file.meta_path()?.split('/'));
        Ok(path)
    }

    /// The folder in `.folio/meta/` that holds a semester's files.
    pub(super) fn semester_dir(&self, semester: &SemesterPath) -> Result<PathBuf, MetaError> {
        Ok(self.meta_dir().join(escape(semester.name(), "")?))
    }

    /// The library's ignore rules, or `None` if it has none: text without a byte order mark,
    /// invalid UTF-8 replaced.
    pub fn read_ignore(&self) -> Result<Option<String>, MetaError> {
        Ok(read_bytes(&self.ignore_file())?.map(|bytes| files::lossy_text(&bytes)))
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
        read(&self.tag_file_path(&TagFile::Group(semester.clone()))?)
    }

    pub fn write_group_meta(
        &self,
        semester: &SemesterPath,
        meta: &GroupMeta,
    ) -> Result<(), MetaError> {
        write(
            self,
            &self.tag_file_path(&TagFile::Group(semester.clone()))?,
            meta,
        )
    }

    pub fn read_course_meta(&self, course: &CoursePath) -> Result<Option<CourseMeta>, MetaError> {
        read(&self.tag_file_path(&TagFile::Course(course.clone()))?)
    }

    pub fn write_course_meta(
        &self,
        course: &CoursePath,
        meta: &CourseMeta,
    ) -> Result<(), MetaError> {
        write(
            self,
            &self.tag_file_path(&TagFile::Course(course.clone()))?,
            meta,
        )
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

/// The semester whose folder in `.folio/meta/` has this name.
pub(super) fn semester_named(name: &str) -> Option<SemesterPath> {
    SemesterPath::new(RelPath::parse(unescape_name(name)?).ok()?).ok()
}

/// The course of `semester` whose file in the semester's folder has this name.
pub(super) fn course_named(semester: &SemesterPath, file: &str) -> Option<CoursePath> {
    let name = RelPath::parse(unescape_name(file.strip_suffix(".json")?)?).ok()?;
    CoursePath::new(semester.path().join(&name).ok()?).ok()
}

/// The metadata file that holds tags.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum TagFile {
    /// `meta/_root.json`: files at the library root.
    Root,
    /// `meta/<semester>/_group.json`: files directly in a semester.
    Group(SemesterPath),
    /// `meta/<semester>/<course>.json`: everything inside a course.
    Course(CoursePath),
}

impl TagFile {
    /// The file's path below `.folio/meta/`, names joined by `/`, which [`TagFile::at`] reads
    /// back.
    pub(super) fn meta_path(&self) -> Result<String, MetaError> {
        Ok(match self {
            Self::Root => ROOT_FILE.to_owned(),
            Self::Group(semester) => format!("{}/{GROUP_FILE}", escape(semester.name(), "")?),
            Self::Course(course) => format!(
                "{}/{}",
                escape(course.semester().name(), "")?,
                escape(course.name(), ".json")?
            ),
        })
    }

    /// The file whose [`TagFile::meta_path`] is `path`; `None` for any other path.
    pub(super) fn at(path: &str) -> Option<Self> {
        match *path.split('/').collect::<Vec<_>>() {
            [ROOT_FILE] => Some(Self::Root),
            [folder, GROUP_FILE] => semester_named(folder).map(Self::Group),
            [folder, file] => course_named(&semester_named(folder)?, file).map(Self::Course),
            _ => None,
        }
    }

    /// The file of the same kind for `folder`, or `None` if `folder` has the wrong depth for it
    /// or the file is `Root`.
    pub fn with_folder(&self, folder: RelPath) -> Option<Self> {
        match self {
            Self::Root => None,
            Self::Group(_) => SemesterPath::new(folder).ok().map(Self::Group),
            Self::Course(_) => CoursePath::new(folder).ok().map(Self::Course),
        }
    }

    /// The folder whose content the file describes; its keys are relative to it. `None` is the
    /// library root.
    pub fn folder(&self) -> Option<&RelPath> {
        match self {
            Self::Root => None,
            Self::Group(semester) => Some(semester.path()),
            Self::Course(course) => Some(course.path()),
        }
    }

    /// The file's identity on NTFS: names that differ only in case name the same file.
    pub fn key(&self) -> TagFileKey {
        TagFileKey(match self {
            Self::Root => None,
            Self::Group(semester) => Some((false, semester.path().key())),
            Self::Course(course) => Some((true, course.path().key())),
        })
    }
}

/// See [`TagFile::key`].
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct TagFileKey(Option<(bool, PathKey)>);

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
