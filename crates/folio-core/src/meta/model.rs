//! The content of the metadata files (docs/specs/library-core.md §4.2).

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Deserializer, Serialize};
use unicode_segmentation::UnicodeSegmentation;

use super::{MetaError, MetaFile};
use crate::paths::RelPath;

/// A value that breaks a rule of the metadata format.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{what} {rule}")]
pub struct ValueError {
    pub what: &'static str,
    pub rule: &'static str,
}

/// A validated string whose rule is a yes/no test; it fails with a [`ValueError`].
macro_rules! text_value {
    ($(#[$doc:meta])* $name:ident, $what:literal, $rule:literal, $valid:expr) => {
        validated_string!($(#[$doc])* $name, ValueError, |text| {
            let valid: fn(&str) -> bool = $valid;
            if valid(text) {
                Ok(())
            } else {
                Err(ValueError { what: $what, rule: $rule })
            }
        });
    };
}

text_value!(
    /// A library's id: 128 random bits as 32 lower-case hexadecimal digits.
    LibraryId,
    "a library id",
    "must be 32 lower-case hexadecimal digits",
    |text| text.len() == 32 && crate::is_lower_hex(text)
);

text_value!(
    /// A tag's stable id: a preset such as `homework`, or 16 random hexadecimal digits.
    TagId,
    "a tag id",
    "must be 1–32 of a–z, 0–9, _ and -, starting with a letter or digit",
    |text| {
        (1..=32).contains(&text.len())
            && text
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
            && text.bytes().next().is_some_and(|b| b.is_ascii_alphanumeric())
    }
);

text_value!(
    /// A key of the design system's tag palette, such as `blue`.
    Color,
    "a colour",
    "must be 1–32 of a–z, 0–9 and -, starting with a letter",
    |text| {
        (1..=32).contains(&text.len())
            && text
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            && text.bytes().next().is_some_and(|b| b.is_ascii_lowercase())
    }
);

text_value!(
    /// The name of a library or a tag.
    DisplayName,
    "a name",
    "must be 1–128 characters without surrounding spaces or control characters",
    |text| {
        (1..=128).contains(&text.chars().count())
            && text.trim() == text
            && !text.chars().any(char::is_control)
    }
);

text_value!(
    /// A course's abbreviation, shown in its coloured square (brief §5.1).
    Abbr,
    "an abbreviation",
    "must be one or two characters without spaces",
    |text| {
        (1..=2).contains(&text.graphemes(true).count())
            && !text.chars().any(|ch| ch.is_whitespace() || ch.is_control())
    }
);

text_value!(
    /// A lower-case file extension without the dot.
    Extension,
    "an extension",
    "must be 1–16 lower-case letters, digits, _, - or +, without the dot",
    |text| {
        (1..=16).contains(&text.chars().count())
            && text
                .chars()
                .all(|ch| ch.is_alphanumeric() || matches!(ch, '_' | '-' | '+'))
            && text.to_lowercase() == text
    }
);

fn random_hex(bytes: usize) -> Result<String, MetaError> {
    let mut random = vec![0; bytes];
    getrandom::fill(&mut random).map_err(|error| MetaError::Random(error.to_string()))?;
    Ok(random.iter().map(|byte| format!("{byte:02x}")).collect())
}

impl LibraryId {
    pub fn generate() -> Result<Self, MetaError> {
        random_hex(16).map(Self)
    }
}

impl TagId {
    pub fn generate() -> Result<Self, MetaError> {
        random_hex(8).map(Self)
    }
}

/// `.folio/library.json`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct LibraryConfig {
    pub id: LibraryId,
    pub name: DisplayName,
    pub versioning: VersioningRules,
}

impl LibraryConfig {
    /// Settings for a new library: a fresh id and the default versioning rules.
    pub fn new(name: DisplayName) -> Result<Self, MetaError> {
        Ok(Self {
            id: LibraryId::generate()?,
            name,
            versioning: VersioningRules::default(),
        })
    }
}

impl MetaFile for LibraryConfig {
    const WHAT: &'static str = "library settings";

    fn check(&self) -> Result<(), String> {
        let rules = &self.versioning;
        match rules
            .text_extensions
            .intersection(&rules.word_extensions)
            .next()
        {
            Some(both) => Err(format!("`{both}` is both a text and a Word extension")),
            None => Ok(()),
        }
    }
}

/// Which files keep every version (brief §5.8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct VersioningRules {
    pub text_extensions: BTreeSet<Extension>,
    /// Larger text files only record changes.
    pub text_max_size: u64,
    pub word_extensions: BTreeSet<Extension>,
}

/// Text, markup, data and source-code formats that students keep next to their notes.
const DEFAULT_TEXT_EXTENSIONS: &[&str] = &[
    "adoc", "asm", "bat", "bib", "c", "cc", "cfg", "cls", "cmake", "cmd", "conf", "cpp", "cs",
    "css", "csv", "dart", "go", "h", "hpp", "hs", "htm", "html", "ini", "ipynb", "java", "js",
    "json", "jsx", "kt", "latex", "lua", "m", "markdown", "md", "mjs", "ml", "org", "php", "pl",
    "ps1", "py", "qmd", "r", "rb", "rmd", "rs", "rst", "s", "sass", "scala", "scss", "sh", "sql",
    "sty", "sv", "swift", "tex", "toml", "ts", "tsv", "tsx", "txt", "v", "vhd", "vhdl", "vue",
    "xml", "yaml", "yml",
];

impl Default for VersioningRules {
    fn default() -> Self {
        let extensions = |list: &[&str]| {
            list.iter()
                .map(|extension| Extension((*extension).to_owned()))
                .collect()
        };
        Self {
            text_extensions: extensions(DEFAULT_TEXT_EXTENSIONS),
            text_max_size: 10 * 1024 * 1024,
            word_extensions: extensions(&["docx"]),
        }
    }
}

/// A file or a folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum EntryKind {
    File,
    Folder,
}

/// What a file is, from its extension alone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum FileClass {
    Text,
    Word,
    Other,
}

impl VersioningRules {
    pub fn class_of(&self, path: &RelPath) -> FileClass {
        match path.extension() {
            Some(extension) if self.text_extensions.contains(extension.as_str()) => FileClass::Text,
            Some(extension) if self.word_extensions.contains(extension.as_str()) => FileClass::Word,
            _ => FileClass::Other,
        }
    }

    /// Whether a file of this class and size keeps its versions (ADR-0003 §2, `stored`).
    pub fn is_stored(&self, class: FileClass, size: u64) -> bool {
        match class {
            FileClass::Text => size <= self.text_max_size,
            FileClass::Word => true,
            FileClass::Other => false,
        }
    }
}

/// `.folio/tags.json`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TagDefinitions {
    pub tags: BTreeMap<TagId, TagDefinition>,
}

impl MetaFile for TagDefinitions {
    const WHAT: &'static str = "tag definitions";
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TagDefinition {
    pub color: Color,
    pub name: DisplayName,
    pub order: u32,
}

/// The tags every new library starts with (brief §4).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PresetTag {
    Notes,
    Slides,
    Homework,
    Exam,
    Reference,
}

impl PresetTag {
    pub const ALL: [Self; 5] = [
        Self::Notes,
        Self::Slides,
        Self::Homework,
        Self::Exam,
        Self::Reference,
    ];

    pub fn id(self) -> TagId {
        let id = match self {
            Self::Notes => "notes",
            Self::Slides => "slides",
            Self::Homework => "homework",
            Self::Exam => "exam",
            Self::Reference => "reference",
        };
        TagId(id.to_owned())
    }

    /// Placeholder palette keys until the design system defines the tag palette (milestone 6).
    fn color(self) -> Color {
        let color = match self {
            Self::Notes => "blue",
            Self::Slides => "green",
            Self::Homework => "orange",
            Self::Exam => "red",
            Self::Reference => "gray",
        };
        Color(color.to_owned())
    }
}

impl TagDefinitions {
    /// The preset tags, named in the UI language by `name_of` (CLAUDE.md §2).
    pub fn with_presets(mut name_of: impl FnMut(PresetTag) -> DisplayName) -> Self {
        let tags = PresetTag::ALL
            .into_iter()
            .zip(1..)
            .map(|(preset, order)| {
                let definition = TagDefinition {
                    color: preset.color(),
                    name: name_of(preset),
                    order,
                };
                (preset.id(), definition)
            })
            .collect();
        Self { tags }
    }
}

/// Tags per path, relative to the folder the file describes. Paths without tags are left out.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize)]
#[serde(transparent)]
pub struct Assignments(BTreeMap<RelPath, BTreeSet<TagId>>);

impl<'de> Deserialize<'de> for Assignments {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let map = BTreeMap::<RelPath, BTreeSet<TagId>>::deserialize(deserializer)?;
        Ok(Self(
            map.into_iter()
                .filter(|(_, tags)| !tags.is_empty())
                .collect(),
        ))
    }
}

impl Assignments {
    pub fn get(&self, path: &RelPath) -> Option<&BTreeSet<TagId>> {
        self.0.get(path)
    }

    /// Replaces the tags of `path`; no tags removes it.
    pub fn set(&mut self, path: RelPath, tags: BTreeSet<TagId>) {
        if tags.is_empty() {
            self.0.remove(&path);
        } else {
            self.0.insert(path, tags);
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = (&RelPath, &BTreeSet<TagId>)> {
        self.0.iter()
    }

    pub fn len(&self) -> usize {
        self.0.len()
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    /// Paths must name different files on Windows, and files directly in the folder when
    /// `names_only`.
    fn check(&self, names_only: bool) -> Result<(), String> {
        let mut keys = BTreeMap::new();
        for path in self.0.keys() {
            if names_only && path.depth() > 1 {
                return Err(format!("`{path}` is not a name directly in the folder"));
            }
            if let Some(other) = keys.insert(path.key(), path) {
                return Err(format!("`{other}` and `{path}` differ only in case"));
            }
        }
        Ok(())
    }
}

/// `.folio/meta/_root.json`: tags of files at the library root.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct RootMeta {
    pub tags: Assignments,
}

impl MetaFile for RootMeta {
    const WHAT: &'static str = "tags at the library root";

    fn check(&self) -> Result<(), String> {
        self.tags.check(true)
    }
}

/// `.folio/meta/<semester>/_group.json`: a semester or other first-level group, and the tags of
/// files directly in it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupMeta {
    pub group: GroupSettings,
    pub tags: Assignments,
}

impl MetaFile for GroupMeta {
    const WHAT: &'static str = "semester settings";

    fn check(&self) -> Result<(), String> {
        self.tags.check(true)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GroupSettings {
    pub archived: bool,
    pub order: u32,
}

/// `.folio/meta/<semester>/<course>.json`: a course and the tags of everything inside it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CourseMeta {
    pub course: CourseSettings,
    pub tags: Assignments,
}

impl MetaFile for CourseMeta {
    const WHAT: &'static str = "course settings";

    fn check(&self) -> Result<(), String> {
        self.tags.check(false)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct CourseSettings {
    pub abbr: Abbr,
    pub archived: bool,
    pub color: Color,
    pub order: u32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn values_follow_their_rules() {
        assert!(LibraryId::parse("0123456789abcdef0123456789abcdef").is_ok());
        for text in ["0123456789ABCDEF0123456789ABCDEF", "abc", ""] {
            assert!(LibraryId::parse(text).is_err(), "{text:?}");
        }

        for text in ["notes", "3f9a1c2b5e6d7a8b", "my-tag_2"] {
            assert!(TagId::parse(text).is_ok(), "{text:?}");
        }
        for text in ["", "Notes", "-x", "_x", "a b", "作业", &"a".repeat(33)] {
            assert!(TagId::parse(text).is_err(), "{text:?}");
        }

        assert!(Color::parse("blue-2").is_ok());
        for text in ["", "2blue", "Blue", "blue green"] {
            assert!(Color::parse(text).is_err(), "{text:?}");
        }

        assert!(DisplayName::parse("考试").is_ok());
        for text in ["", " 考试", "考试 ", "a\nb", &"字".repeat(129)] {
            assert!(DisplayName::parse(text).is_err(), "{text:?}");
        }

        for text in ["线代", "LA", "C", "👩‍💻"] {
            assert!(Abbr::parse(text).is_ok(), "{text:?}");
        }
        for text in ["", "线性代", "L A", "\t"] {
            assert!(Abbr::parse(text).is_err(), "{text:?}");
        }

        for text in ["md", "c++", "tar-gz", "ñ"] {
            assert!(Extension::parse(text).is_ok(), "{text:?}");
        }
        for text in ["", ".md", "MD", "a b", &"x".repeat(17)] {
            assert!(Extension::parse(text).is_err(), "{text:?}");
        }
    }

    #[test]
    fn value_errors_name_the_rule() {
        assert_eq!(
            TagId::parse("A").unwrap_err().to_string(),
            "a tag id must be 1–32 of a–z, 0–9, _ and -, starting with a letter or digit"
        );
    }

    #[test]
    fn generated_ids_are_valid_and_differ() {
        let library = LibraryId::generate().unwrap();
        assert!(LibraryId::parse(library.as_str()).is_ok());
        let (a, b) = (TagId::generate().unwrap(), TagId::generate().unwrap());
        assert_eq!(a.as_str().len(), 16);
        assert!(TagId::parse(a.as_str()).is_ok());
        assert_ne!(a, b);
    }

    #[test]
    fn default_rules_are_valid_and_classify_by_extension() {
        let rules = VersioningRules::default();
        for extension in rules.text_extensions.iter().chain(&rules.word_extensions) {
            assert_eq!(Extension::parse(extension.as_str()).as_ref(), Ok(extension));
        }
        let class = |text: &str| rules.class_of(&RelPath::parse(text).unwrap());
        assert_eq!(class("课/笔记.MD"), FileClass::Text);
        assert_eq!(class("report.docx"), FileClass::Word);
        assert_eq!(class("slides.pptx"), FileClass::Other);
        assert_eq!(class(".gitignore"), FileClass::Other);
        assert_eq!(class("Makefile"), FileClass::Other);

        assert!(rules.is_stored(FileClass::Text, 10 * 1024 * 1024));
        assert!(!rules.is_stored(FileClass::Text, 10 * 1024 * 1024 + 1));
        assert!(rules.is_stored(FileClass::Word, u64::MAX));
        assert!(!rules.is_stored(FileClass::Other, 0));
    }

    #[test]
    fn presets_take_their_names_from_the_caller() {
        let tags = TagDefinitions::with_presets(|preset| {
            DisplayName::parse(&format!("{preset:?}")).unwrap()
        });
        let order: Vec<_> = tags
            .tags
            .iter()
            .map(|(id, tag)| (id.as_str(), tag.name.as_str(), tag.order))
            .collect();
        assert_eq!(
            order,
            [
                ("exam", "Exam", 4),
                ("homework", "Homework", 3),
                ("notes", "Notes", 1),
                ("reference", "Reference", 5),
                ("slides", "Slides", 2),
            ]
        );
    }
}
