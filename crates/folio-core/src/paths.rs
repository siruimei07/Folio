//! Paths inside the library (docs/specs/library-core.md §3).
//!
//! A [`RelPath`] is relative to a folder: the library root for catalog entries, a course folder
//! for tag keys. Its text form (NFC, `/`-separated, every segment a valid Windows name) is the
//! only form Folio stores or sends. [`PathKey`] is its case-insensitive identity.

use std::path::{Path, PathBuf};

use unicode_normalization::is_nfc;

/// Changes whenever the name rules ([`check_name`]) or the keys ([`RelPath::key`], including
/// Rust's Unicode case tables) change. The catalog then reads every stored path again, which
/// replaces a catalog holding paths that no longer validate, and recomputes the keys.
pub const PATHS_VERSION: u32 = 1;

/// The longest name NTFS accepts, in UTF-16 code units.
pub const MAX_NAME_UNITS: usize = 255;

/// The longest path NTFS accepts, in UTF-16 code units.
pub const MAX_PATH_UNITS: usize = 32_767;

/// Why a path or name is not valid inside the library.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum PathError {
    #[error("the path is empty or contains an empty name")]
    Empty,
    #[error("the path is not in Unicode normalization form C")]
    NotNfc,
    #[error("`.` and `..` are not names")]
    DotSegment,
    #[error("Windows names cannot contain {0:?}")]
    ReservedCharacter(char),
    #[error("Windows names cannot end with a dot or a space")]
    TrailingDotOrSpace,
    #[error("the name is reserved for a device on Windows")]
    ReservedName,
    #[error("a name is longer than {MAX_NAME_UNITS} UTF-16 code units")]
    NameTooLong,
    #[error("the path is longer than {MAX_PATH_UNITS} UTF-16 code units")]
    TooLong,
}

validated_string!(
    /// A relative path: NFC, names joined by `/`, each name valid on Windows. Other Unicode
    /// forms are rejected, not normalized: callers that read names from the disk normalize them
    /// and report twins themselves.
    RelPath,
    PathError,
    check_path
);

impl RelPath {
    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.0.split('/')
    }

    /// The number of names: 1 for a name directly in the folder.
    pub fn depth(&self) -> usize {
        self.names().count()
    }

    /// The last name.
    pub fn name(&self) -> &str {
        self.0.rsplit_once('/').map_or(&self.0, |(_, name)| name)
    }

    /// The containing path, or `None` for a name directly in the folder.
    pub fn parent(&self) -> Option<Self> {
        self.0
            .rsplit_once('/')
            .map(|(parent, _)| Self(parent.to_owned()))
    }

    /// This path followed by `tail`.
    pub fn join(&self, tail: &Self) -> Result<Self, PathError> {
        let joined = format!("{}/{}", self.0, tail.0);
        if utf16_len(&joined) > MAX_PATH_UNITS {
            return Err(PathError::TooLong);
        }
        Ok(Self(joined))
    }

    /// This path inside `folder`, or itself when `folder` is `None`, the library root.
    pub fn below(&self, folder: Option<&Self>) -> Result<Self, PathError> {
        match folder {
            None => Ok(self.clone()),
            Some(folder) => folder.join(self),
        }
    }

    /// This path, then each of its ancestors, the nearest first.
    pub fn ancestors(&self) -> impl Iterator<Item = Self> + use<> {
        std::iter::successors(Some(self.clone()), Self::parent)
    }

    /// The semester folder this path is in and the rest of it, or `None` for a name directly in
    /// the library.
    pub fn semester_and_rest(&self) -> Option<(SemesterPath, Self)> {
        let (semester, rest) = self.0.split_once('/')?;
        Some((
            SemesterPath(Self(semester.to_owned())),
            Self(rest.to_owned()),
        ))
    }

    /// The course folder this path is in and the rest of it, or `None` unless it is inside one.
    pub fn course_and_rest(&self) -> Option<(CoursePath, Self)> {
        let mut slashes = self.0.match_indices('/').map(|(index, _)| index);
        let (slash, end) = (slashes.next()?, slashes.next()?);
        let course = CoursePath {
            path: Self(self.0[..end].to_owned()),
            slash,
        };
        Some((course, Self(self.0[end + 1..].to_owned())))
    }

    /// Whether `ancestor` is this path or one of its ancestors.
    pub fn starts_with(&self, ancestor: &Self) -> bool {
        self == ancestor || self.strip_prefix(ancestor).is_some()
    }

    /// The rest of this path below `ancestor`, or `None` unless `ancestor` is a proper ancestor.
    pub fn strip_prefix(&self, ancestor: &Self) -> Option<Self> {
        self.0
            .strip_prefix(ancestor.0.as_str())?
            .strip_prefix('/')
            .map(|rest| Self(rest.to_owned()))
    }

    /// The lower-cased extension of the last name, without the dot. A name that only starts with
    /// a dot (`.gitignore`) has none.
    pub fn extension(&self) -> Option<String> {
        match self.name().rsplit_once('.') {
            Some((stem, extension)) if !stem.is_empty() => Some(extension.to_lowercase()),
            _ => None,
        }
    }

    /// The case-insensitive identity of this path.
    pub fn key(&self) -> PathKey {
        PathKey(self.0.chars().map(key_char).collect())
    }

    /// The case-insensitive identity of the last name.
    pub fn name_key(&self) -> PathKey {
        PathKey(self.name().chars().map(key_char).collect())
    }

    /// The path below `root` on this machine.
    pub fn to_native(&self, root: &Path) -> PathBuf {
        let mut path = root.to_path_buf();
        path.extend(self.names());
        path
    }
}

/// A path with the wrong number of names for its role.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("`{path}` is not {expected}")]
pub struct WrongDepth {
    pub path: RelPath,
    pub expected: &'static str,
}

/// A semester, or another first-level group: a folder directly in the library (brief §4).
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct SemesterPath(RelPath);

impl SemesterPath {
    pub fn new(path: RelPath) -> Result<Self, WrongDepth> {
        if path.depth() == 1 {
            Ok(Self(path))
        } else {
            Err(WrongDepth {
                path,
                expected: "a semester folder (one name)",
            })
        }
    }

    pub fn path(&self) -> &RelPath {
        &self.0
    }

    pub fn name(&self) -> &str {
        self.0.as_str()
    }
}

/// A course: a folder directly in a semester.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct CoursePath {
    path: RelPath,
    /// Where the `/` between the semester and the course is.
    slash: usize,
}

impl CoursePath {
    pub fn new(path: RelPath) -> Result<Self, WrongDepth> {
        match path.0.find('/') {
            Some(slash) if path.depth() == 2 => Ok(Self { path, slash }),
            _ => Err(WrongDepth {
                path,
                expected: "a course folder (two names)",
            }),
        }
    }

    pub fn path(&self) -> &RelPath {
        &self.path
    }

    pub fn semester(&self) -> SemesterPath {
        SemesterPath(RelPath(self.semester_name().to_owned()))
    }

    pub fn semester_name(&self) -> &str {
        &self.path.0[..self.slash]
    }

    pub fn name(&self) -> &str {
        &self.path.0[self.slash + 1..]
    }
}

/// The case-insensitive identity of a [`RelPath`], for lookups and for finding names that differ
/// only in case. It is not a uniqueness key: see docs/specs/library-core.md §3.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct PathKey(String);

impl PathKey {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

fn check_path(text: &str) -> Result<(), PathError> {
    for name in text.split('/') {
        check_name(name)?;
    }
    if utf16_len(text) > MAX_PATH_UNITS {
        return Err(PathError::TooLong);
    }
    Ok(())
}

/// Checks one name: a file or folder name that is valid on Windows and in NFC.
pub fn check_name(name: &str) -> Result<(), PathError> {
    if name.is_empty() {
        return Err(PathError::Empty);
    }
    if name == "." || name == ".." {
        return Err(PathError::DotSegment);
    }
    if let Some(ch) = name
        .chars()
        .find(|&ch| ch < ' ' || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'))
    {
        return Err(PathError::ReservedCharacter(ch));
    }
    if name.ends_with(['.', ' ']) {
        return Err(PathError::TrailingDotOrSpace);
    }
    if is_device_name(name) {
        return Err(PathError::ReservedName);
    }
    if utf16_len(name) > MAX_NAME_UNITS {
        return Err(PathError::NameTooLong);
    }
    if !is_nfc(name) {
        return Err(PathError::NotNfc);
    }
    Ok(())
}

/// Windows reserves device names in any case and with any extension (`nul.txt`); it also ignores
/// spaces before the extension (`CON .txt`). `CONIN$` and `CONOUT$` name the console.
fn is_device_name(name: &str) -> bool {
    let stem = name
        .split_once('.')
        .map_or(name, |(stem, _)| stem)
        .trim_end_matches(' ');
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
        .iter()
        .any(|device| stem.eq_ignore_ascii_case(device))
    {
        return true;
    }
    let (Some(prefix), Some(number)) = (stem.get(..3), stem.get(3..)) else {
        return false;
    };
    let mut number = number.chars();
    (prefix.eq_ignore_ascii_case("COM") || prefix.eq_ignore_ascii_case("LPT"))
        && matches!(number.next(), Some('0'..='9' | '¹' | '²' | '³'))
        && number.next().is_none()
}

/// Whether two names are the same name on NTFS, which ignores case (see [`PathKey`]).
pub fn same_name(a: &str, b: &str) -> bool {
    a.chars().map(key_char).eq(b.chars().map(key_char))
}

/// A character's simple uppercase mapping, like the NTFS upcase table; characters whose uppercase
/// is several characters (`ß`) stay as they are.
fn key_char(ch: char) -> char {
    let mut upper = ch.to_uppercase();
    match (upper.next(), upper.next()) {
        (Some(single), None) => single,
        _ => ch,
    }
}

pub(crate) fn utf16_len(text: &str) -> usize {
    text.encode_utf16().count()
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;
    use crate::test_support::path;

    #[test]
    fn accepts_ordinary_library_paths() {
        for text in [
            "2026 秋",
            "2026 秋/线性代数/第3讲 特征值.pptx",
            "个人/.gitignore",
            "a/b c/d.tar.gz",
            " leading space",
            "CONSOLE",
            "COM10",
            "LPT",
            "NUL-notes.md",
            "résumé.docx",
        ] {
            assert_eq!(path(text).as_str(), text);
        }
    }

    #[test]
    fn rejects_empty_names_and_dot_segments() {
        for text in ["", "/", "a/", "/a", "a//b"] {
            assert_eq!(RelPath::parse(text), Err(PathError::Empty), "{text:?}");
        }
        for text in [".", "..", "a/../b", "a/./b"] {
            assert_eq!(RelPath::parse(text), Err(PathError::DotSegment), "{text:?}");
        }
    }

    #[test]
    fn rejects_characters_windows_reserves() {
        for ch in [
            '<', '>', ':', '"', '\\', '|', '?', '*', '\0', '\t', '\u{1f}',
        ] {
            let text = format!("a{ch}b");
            assert_eq!(
                RelPath::parse(&text),
                Err(PathError::ReservedCharacter(ch)),
                "{text:?}"
            );
        }
        assert!(RelPath::parse("a\u{7f}b").is_ok());
    }

    #[test]
    fn rejects_trailing_dots_and_spaces() {
        for text in ["a.", "a ", "a./b", "notes. "] {
            assert_eq!(
                RelPath::parse(text),
                Err(PathError::TrailingDotOrSpace),
                "{text:?}"
            );
        }
    }

    #[test]
    fn rejects_device_names_in_any_case_and_with_extensions() {
        for text in [
            "CON",
            "con",
            "Prn.txt",
            "aux",
            "NUL.tar.gz",
            "COM1",
            "com0",
            "LPT9.md",
            "COM¹",
            "lpt³.x",
            "CON .txt",
            "a/nul",
            "conin$",
            "CONOUT$.log",
        ] {
            assert_eq!(
                RelPath::parse(text),
                Err(PathError::ReservedName),
                "{text:?}"
            );
        }
    }

    #[test]
    fn rejects_other_normalization_forms() {
        assert_eq!(RelPath::parse("cafe\u{301}"), Err(PathError::NotNfc));
        assert!(RelPath::parse("caf\u{e9}").is_ok());
    }

    #[test]
    fn limits_name_and_path_length_in_utf16_units() {
        let longest = "a".repeat(MAX_NAME_UNITS);
        assert!(RelPath::parse(&longest).is_ok());
        assert_eq!(
            RelPath::parse(&format!("{longest}a")),
            Err(PathError::NameTooLong)
        );
        // Characters outside the BMP take two units.
        let emoji = "😀".repeat(MAX_NAME_UNITS / 2 + 1);
        assert_eq!(RelPath::parse(&emoji), Err(PathError::NameTooLong));

        let deep = vec!["a".repeat(200); 164].join("/"); // 164 * 201 - 1 = 32,963 units
        assert_eq!(RelPath::parse(&deep), Err(PathError::TooLong));
        let base = path(&vec!["a".repeat(200); 160].join("/")); // 32,159 units
        let tail = path(&vec!["b".repeat(200); 4].join("/"));
        assert_eq!(base.join(&tail), Err(PathError::TooLong));
    }

    #[test]
    fn splits_and_joins_names() {
        let file = path("2026 秋/线性代数/作业/hw2.pdf");
        assert_eq!(file.depth(), 4);
        assert_eq!(file.name(), "hw2.pdf");
        assert_eq!(file.parent(), Some(path("2026 秋/线性代数/作业")));
        assert_eq!(path("2026 秋").parent(), None);
        assert_eq!(path("2026 秋").name(), "2026 秋");

        let course = path("2026 秋/线性代数");
        assert!(file.starts_with(&course));
        assert!(course.starts_with(&course));
        assert!(!path("2026 秋/线性代数 II/a").starts_with(&course));
        assert_eq!(file.strip_prefix(&course), Some(path("作业/hw2.pdf")));
        assert_eq!(course.strip_prefix(&course), None);
        assert_eq!(course.join(&path("作业/hw2.pdf")).unwrap(), file);
    }

    #[test]
    fn places_paths_below_folders_and_lists_their_ancestors() {
        let course = path("2026 秋/线性代数");
        assert_eq!(
            path("作业/hw2.pdf").below(Some(&course)).unwrap(),
            path("2026 秋/线性代数/作业/hw2.pdf")
        );
        assert_eq!(path("readme.md").below(None).unwrap(), path("readme.md"));
        let ancestors: Vec<_> = path("a/b/c").ancestors().collect();
        assert_eq!(ancestors, [path("a/b/c"), path("a/b"), path("a")]);
        assert_eq!(path("作业/HW2.pdf").name_key(), path("hw2.PDF").key());
    }

    #[test]
    fn finds_the_semester_and_course_a_path_is_in() {
        let file = path("2026 秋/线性代数/作业/hw2.pdf");
        let (course, rest) = file.course_and_rest().unwrap();
        assert_eq!(course, CoursePath::new(path("2026 秋/线性代数")).unwrap());
        assert_eq!(
            (course.semester_name(), course.name()),
            ("2026 秋", "线性代数")
        );
        assert_eq!(rest, path("作业/hw2.pdf"));
        assert_eq!(
            file.semester_and_rest(),
            Some((
                SemesterPath::new(path("2026 秋")).unwrap(),
                path("线性代数/作业/hw2.pdf")
            ))
        );
        assert_eq!(path("2026 秋/日程.pdf").course_and_rest(), None);
        assert_eq!(path("readme.md").semester_and_rest(), None);
    }

    #[test]
    fn semesters_and_courses_have_one_and_two_names() {
        let course = CoursePath::new(path("2026 秋/线性代数")).unwrap();
        assert_eq!(
            (course.semester_name(), course.name()),
            ("2026 秋", "线性代数")
        );
        assert_eq!(
            course.semester(),
            SemesterPath::new(path("2026 秋")).unwrap()
        );
        assert_eq!(
            CoursePath::new(path("a")).unwrap_err().to_string(),
            "`a` is not a course folder (two names)"
        );
        assert!(CoursePath::new(path("a/b/c")).is_err());
        assert!(SemesterPath::new(path("a/b")).is_err());
        assert_eq!(SemesterPath::new(path("a")).unwrap().name(), "a");
    }

    #[test]
    fn extensions_are_lower_case_and_ignore_leading_dots() {
        assert_eq!(path("a/Slides.PPTX").extension().as_deref(), Some("pptx"));
        assert_eq!(path("a.tar.gz").extension().as_deref(), Some("gz"));
        assert_eq!(path(".gitignore").extension(), None);
        assert_eq!(path("Makefile").extension(), None);
        assert_eq!(path("a.d/Makefile").extension(), None);
    }

    #[test]
    fn keys_ignore_case_like_ntfs() {
        assert_eq!(path("Notes/HW1.pdf").key(), path("notes/hw1.PDF").key());
        assert_eq!(path("Σίγμα").key(), path("σίγμα").key());
        assert_eq!(path("Линал").key(), path("линал").key());
        // Only single-character mappings: `ß` does not become `SS`.
        assert_ne!(path("straße").key(), path("STRASSE").key());
        assert_ne!(path("a/b").key(), path("a/c").key());
    }

    #[test]
    fn compares_names_like_ntfs() {
        assert!(same_name(".folio", ".FOLIO"));
        assert!(same_name("线性代数", "线性代数"));
        assert!(!same_name(".folio", ".folio2"));
        assert!(!same_name("straße", "STRASSE"));
    }

    /// The case tables behind `PathKey` come from Rust's Unicode version. Bump `PATHS_VERSION`
    /// together with this pin, and whenever the name rules change, so catalogs check their
    /// stored paths again and recompute their keys.
    #[test]
    fn paths_version_pins_the_unicode_version() {
        assert_eq!((PATHS_VERSION, char::UNICODE_VERSION), (1, (17, 0, 0)));
    }

    #[test]
    fn native_paths_use_the_platform_separator() {
        let root = Path::new("library");
        assert_eq!(
            path("2026 秋/线性代数").to_native(root),
            root.join("2026 秋").join("线性代数")
        );
    }

    #[test]
    fn serializes_as_text_and_validates_when_deserialized() {
        let json = serde_json::to_string(&path("a/b.md")).unwrap();
        assert_eq!(json, r#""a/b.md""#);
        assert_eq!(
            serde_json::from_str::<RelPath>(&json).unwrap(),
            path("a/b.md")
        );
        assert!(serde_json::from_str::<RelPath>(r#""a/../b""#).is_err());
    }

    fn name() -> impl Strategy<Value = String> {
        // Letters, CJK, digits, and characters that are only invalid in some positions.
        "[a-zA-Z0-9_\\-()\u{4e00}-\u{4e0f}\u{e9}\u{3b1}\u{3a3}. ]{1,12}"
            .prop_filter("a valid Windows name", |name| check_name(name).is_ok())
    }

    fn rel_path() -> impl Strategy<Value = String> {
        prop::collection::vec(name(), 1..5).prop_map(|names| names.join("/"))
    }

    proptest! {
        #[test]
        fn valid_paths_round_trip(text in rel_path()) {
            let parsed = RelPath::parse(&text).unwrap();
            prop_assert_eq!(parsed.as_str(), text.as_str());
            prop_assert_eq!(parsed.names().collect::<Vec<_>>().join("/"), text);
        }

        #[test]
        fn keys_ignore_ascii_case(text in rel_path()) {
            let upper = RelPath::parse(&text.to_ascii_uppercase());
            if let Ok(upper) = upper {
                prop_assert_eq!(upper.key(), RelPath::parse(&text).unwrap().key());
            }
        }

        /// Parsing never panics, and whatever it accepts satisfies every rule.
        #[test]
        fn parse_accepts_only_valid_paths(text in any::<String>()) {
            if let Ok(parsed) = RelPath::parse(&text) {
                for name in parsed.names() {
                    prop_assert!(check_name(name).is_ok());
                }
                prop_assert!(is_nfc(parsed.as_str()));
            }
        }

        #[test]
        fn parents_and_names_rebuild_the_path(text in rel_path()) {
            let parsed = RelPath::parse(&text).unwrap();
            let name = RelPath::parse(parsed.name()).unwrap();
            match parsed.parent() {
                Some(parent) => {
                    prop_assert_eq!(parent.join(&name).unwrap(), parsed.clone());
                    prop_assert_eq!(parsed.strip_prefix(&parent), Some(name));
                }
                None => prop_assert_eq!(name, parsed),
            }
        }
    }
}
