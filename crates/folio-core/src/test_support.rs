//! Fixtures shared by the unit tests.

use crate::meta::{DisplayName, LibraryId, PresetTag, TagDefinitions};
use crate::paths::{CoursePath, RelPath, SemesterPath};

pub fn path(text: &str) -> RelPath {
    RelPath::parse(text).unwrap()
}

pub fn semester(text: &str) -> SemesterPath {
    SemesterPath::new(path(text)).unwrap()
}

pub fn course_at(text: &str) -> CoursePath {
    CoursePath::new(path(text)).unwrap()
}

pub fn library_id() -> LibraryId {
    LibraryId::parse("0123456789abcdef0123456789abcdef").unwrap()
}

/// The preset tags with their Chinese names, the slides tag named `slides`.
pub fn presets(slides: &str) -> TagDefinitions {
    TagDefinitions::with_presets(|preset| {
        let name = match preset {
            PresetTag::Notes => "笔记",
            PresetTag::Slides => slides,
            PresetTag::Homework => "作业",
            PresetTag::Exam => "考试",
            PresetTag::Reference => "资料",
        };
        DisplayName::parse(name).unwrap()
    })
}
