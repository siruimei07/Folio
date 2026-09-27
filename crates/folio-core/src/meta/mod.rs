//! Library metadata in `.folio/`: the files everything the user authors lives in (ADR-0002 §3,
//! docs/specs/library-core.md §4).
//!
//! The files are the source of truth; the catalog only mirrors them. Reading is strict and
//! reports every problem with the file it came from. Writing is deterministic, so the files diff
//! and merge line by line, and atomic.

mod layout;
mod model;

use std::fs::File;
use std::io::{self, Read};
use std::path::{Path, PathBuf};

use serde::de::{self, DeserializeOwned, Deserializer, MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use layout::{Layout, TagFile, is_folio_owned, tag_location, unescape_name};
pub use model::{
    Abbr, Assignments, Color, CourseMeta, CourseSettings, DisplayName, EntryKind, Extension,
    FileClass, GroupMeta, GroupSettings, LibraryConfig, LibraryId, PresetTag, RootMeta,
    TagDefinition, TagDefinitions, TagId, ValueError, VersioningRules,
};

use crate::files;

/// The format every metadata file is written in. Readers accept older versions and switch the
/// library to read-only for newer ones (ADR-0002 §3).
pub const FORMAT_VERSION: u32 = 1;

/// Larger files are rejected before they are parsed.
const MAX_FILE_BYTES: u64 = 32 << 20;

#[derive(Debug, thiserror::Error)]
pub enum MetaError {
    #[error("could not access {}: {source}", path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("{} is larger than {} MiB", path.display(), MAX_FILE_BYTES >> 20)]
    TooLarge { path: PathBuf },
    #[error("{} is not valid: {reason}", path.display())]
    Invalid { path: PathBuf, reason: String },
    /// Written by a newer Folio; the library metadata must become read-only.
    #[error(
        "{} has format version {found}; this Folio reads up to {FORMAT_VERSION}",
        path.display()
    )]
    NewerFormat { path: PathBuf, found: u64 },
    #[error("the name `{name}` is too long for a metadata file")]
    NameTooLong { name: String },
    #[error("the operating system could not provide random numbers: {0}")]
    Random(String),
}

/// A metadata file's content. The format version is not part of it: reading checks it, and
/// writing always writes [`FORMAT_VERSION`].
trait MetaFile: Serialize + DeserializeOwned {
    /// What the file holds, for messages.
    const WHAT: &'static str;

    /// Rules serde cannot express. Runs after every read and before every write.
    fn check(&self) -> Result<(), String> {
        Ok(())
    }
}

/// Reads a metadata file; a missing file is `None`. Paths come from [`Layout`] only.
fn io_error(path: &Path) -> impl FnOnce(io::Error) -> MetaError {
    let path = path.to_owned();
    move |source| MetaError::Io { path, source }
}

fn invalid<T: MetaFile>(path: &Path, reason: impl std::fmt::Display) -> MetaError {
    MetaError::Invalid {
        path: path.to_owned(),
        reason: format!("{}: {reason}", T::WHAT),
    }
}

fn read<T: MetaFile>(path: &Path) -> Result<Option<T>, MetaError> {
    let file = match files::retry_transient(|| File::open(path)) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error(path)(error)),
    };
    let mut bytes = Vec::new();
    file.take(MAX_FILE_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error(path))?;
    if bytes.len() as u64 > MAX_FILE_BYTES {
        return Err(MetaError::TooLarge {
            path: path.to_owned(),
        });
    }
    match from_bytes(&bytes) {
        Ok(value) => Ok(Some(value)),
        Err(Problem::Newer(found)) => Err(MetaError::NewerFormat {
            path: path.to_owned(),
            found,
        }),
        Err(Problem::Invalid(reason)) => Err(invalid::<T>(path, reason)),
    }
}

/// Writes a metadata file atomically through the library's staging folder. Paths come from
/// [`Layout`] only.
fn write<T: MetaFile>(layout: &Layout, path: &Path, value: &T) -> Result<(), MetaError> {
    let bytes = to_bytes(value).map_err(|reason| invalid::<T>(path, reason))?;
    files::write_atomically(&layout.staging_dir(), path, &bytes).map_err(io_error(path))
}

/// Why bytes are not a readable metadata file.
#[derive(Debug, PartialEq, Eq)]
enum Problem {
    Newer(u64),
    Invalid(String),
}

fn from_bytes<T: MetaFile>(bytes: &[u8]) -> Result<T, Problem> {
    let invalid = |error: serde_json::Error| Problem::Invalid(error.to_string());
    let bytes = bytes.strip_prefix(b"\xEF\xBB\xBF").unwrap_or(bytes);
    // `Value` keeps the last of two equal keys, so find them first.
    serde_json::from_slice::<NoDuplicateKeys>(bytes).map_err(invalid)?;
    let Value::Object(mut fields) = serde_json::from_slice(bytes).map_err(invalid)? else {
        return Err(Problem::Invalid("the file is not a JSON object".to_owned()));
    };
    let version = fields
        .remove("format_version")
        .ok_or_else(|| Problem::Invalid("`format_version` is missing".to_owned()))?;
    match version.as_u64() {
        Some(found) if found > u64::from(FORMAT_VERSION) => return Err(Problem::Newer(found)),
        Some(found) if found == u64::from(FORMAT_VERSION) => {}
        _ => {
            return Err(Problem::Invalid(format!(
                "`format_version` {version} is not a format version"
            )));
        }
    }
    let value: T = serde_json::from_value(Value::Object(fields)).map_err(invalid)?;
    value.check().map_err(Problem::Invalid)?;
    Ok(value)
}

/// The file's bytes: the current format version first, fields and map keys sorted, objects one
/// field per line, arrays on one line, LF line ends and a final newline.
fn to_bytes<T: MetaFile>(value: &T) -> Result<Vec<u8>, String> {
    #[derive(Serialize)]
    struct Envelope<'a, T> {
        format_version: u32,
        #[serde(flatten)]
        body: &'a T,
    }

    value.check()?;
    let mut serializer = serde_json::Serializer::with_formatter(Vec::new(), Formatter::default());
    Envelope {
        format_version: FORMAT_VERSION,
        body: value,
    }
    .serialize(&mut serializer)
    .map_err(|error| error.to_string())?;
    let mut bytes = serializer.into_inner();
    bytes.push(b'\n');
    Ok(bytes)
}

/// Like serde_json's pretty printer, except that arrays stay on one line, so a tag assignment
/// is exactly one line.
#[derive(Default)]
struct Formatter(serde_json::ser::PrettyFormatter<'static>);

impl serde_json::ser::Formatter for Formatter {
    fn begin_array_value<W: ?Sized + io::Write>(
        &mut self,
        writer: &mut W,
        first: bool,
    ) -> io::Result<()> {
        if first {
            Ok(())
        } else {
            writer.write_all(b", ")
        }
    }

    fn begin_object<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.begin_object(writer)
    }

    fn end_object<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_object(writer)
    }

    fn begin_object_key<W: ?Sized + io::Write>(
        &mut self,
        writer: &mut W,
        first: bool,
    ) -> io::Result<()> {
        self.0.begin_object_key(writer, first)
    }

    fn begin_object_value<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.begin_object_value(writer)
    }

    fn end_object_value<W: ?Sized + io::Write>(&mut self, writer: &mut W) -> io::Result<()> {
        self.0.end_object_value(writer)
    }
}

/// Deserializes any JSON and fails on the first object that has a key twice.
struct NoDuplicateKeys;

impl<'de> Deserialize<'de> for NoDuplicateKeys {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(NoDuplicateKeys)
    }
}

impl<'de> Visitor<'de> for NoDuplicateKeys {
    type Value = Self;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("any JSON value")
    }

    fn visit_bool<E>(self, _: bool) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_i64<E>(self, _: i64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_u64<E>(self, _: u64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_f64<E>(self, _: f64) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_str<E>(self, _: &str) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_unit<E>(self) -> Result<Self, E> {
        Ok(self)
    }

    fn visit_seq<A: SeqAccess<'de>>(self, mut seq: A) -> Result<Self, A::Error> {
        while seq.next_element::<Self>()?.is_some() {}
        Ok(self)
    }

    fn visit_map<A: MapAccess<'de>>(self, mut map: A) -> Result<Self, A::Error> {
        let mut keys = std::collections::HashSet::new();
        while let Some(key) = map.next_key::<String>()? {
            map.next_value::<Self>()?;
            if !keys.insert(key.clone()) {
                return Err(de::Error::custom(format_args!(
                    "the key {key:?} appears twice"
                )));
            }
        }
        Ok(self)
    }
}

#[cfg(test)]
mod tests;
