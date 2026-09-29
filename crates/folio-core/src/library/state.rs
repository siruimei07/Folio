//! Per-machine settings and first-time library creation (ADR-0002, library-state.md).

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::files;
use crate::meta::{DisplayName, Layout, LibraryConfig, MetaError, PresetTag, TagDefinitions};

const SETTINGS_VERSION: u32 = 1;
const MAX_SETTINGS_BYTES: u64 = 1 << 20;

/// Settings belong to this machine, never to the synced library. Preserve fields of later lanes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    pub format_version: u32,
    pub library_root: Option<PathBuf>,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            format_version: SETTINGS_VERSION,
            library_root: None,
            extra: BTreeMap::new(),
        }
    }
}

impl Settings {
    pub fn load(data_dir: &Path) -> Result<Self, MetaError> {
        let path = data_dir.join("settings.json");
        let file = match File::open(&path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(source) => return Err(MetaError::Io { path, source }),
        };
        let bytes = files::read_capped(file, MAX_SETTINGS_BYTES)
            .map_err(|source| MetaError::Io {
                path: path.clone(),
                source,
            })?
            .ok_or_else(|| MetaError::TooLarge { path: path.clone() })?;
        let value: Value = serde_json::from_slice(&bytes).map_err(|error| invalid(&path, error))?;
        let version = value
            .get("format_version")
            .and_then(Value::as_u64)
            .ok_or_else(|| invalid(&path, "missing or invalid format_version"))?;
        if version > u64::from(SETTINGS_VERSION) {
            return Err(MetaError::NewerFormat {
                path,
                found: version,
            });
        }
        let settings: Self =
            serde_json::from_slice(&bytes).map_err(|error| invalid(&path, error))?;
        settings.validate(&path)?;
        Ok(settings)
    }

    pub fn save(&self, data_dir: &Path) -> Result<(), MetaError> {
        let path = data_dir.join("settings.json");
        self.validate(&path)?;
        let mut bytes = serde_json::to_vec_pretty(self).map_err(|error| invalid(&path, error))?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_SETTINGS_BYTES {
            return Err(MetaError::TooLarge { path });
        }
        files::write_atomically(&data_dir.join("staging"), &path, &bytes)
            .map_err(|source| MetaError::Io { path, source })
    }

    fn validate(&self, path: &Path) -> Result<(), MetaError> {
        if self.format_version != SETTINGS_VERSION
            || self
                .library_root
                .as_ref()
                .is_some_and(|root| !root.is_absolute())
            || self.extra.contains_key("format_version")
            || self.extra.contains_key("library_root")
        {
            return Err(invalid(path, "invalid settings version or library root"));
        }
        Ok(())
    }
}

fn invalid(path: &Path, reason: impl std::fmt::Display) -> MetaError {
    MetaError::Invalid {
        path: path.to_owned(),
        reason: reason.to_string(),
    }
}

/// Rejects links in the metadata paths Folio reads or writes, checking each parent before
/// descending. Missing paths are valid. Cloud placeholders that do not redirect a name are
/// allowed, using the same `FileType::is_symlink` policy as `StdFileSystem`.
///
/// Call before opening metadata and again under the catalog writer before recovery/mutation.
/// This prevents following an existing link; it does not reserve paths against a different
/// local process replacing them between this check and use.
pub fn validate_metadata(root: &Path) -> Result<(), MetaError> {
    let layout = Layout::new(root);
    if !metadata_directory(&layout.folio_dir())? {
        return Ok(());
    }
    for file in [
        layout.library_file(),
        layout.tags_file(),
        layout.ignore_file(),
    ] {
        metadata_file(&file)?;
    }

    let meta = layout.meta_dir();
    if metadata_directory(&meta)? {
        for entry in fs::read_dir(&meta).map_err(|source| io_at(&meta, source))? {
            let path = entry.map_err(|source| io_at(&meta, source))?.path();
            if unlinked_type(&path)?.is_some_and(|kind| kind.is_dir()) {
                // Metadata has only two levels: a semester folder and its group/course files.
                // Never recurse through an unchecked parent, even for an unknown filename.
                for child in fs::read_dir(&path).map_err(|source| io_at(&path, source))? {
                    let child = child.map_err(|source| io_at(&path, source))?.path();
                    unlinked_type(&child)?;
                }
            }
        }
    }

    let staging = layout.staging_dir();
    let local = staging.parent().expect("staging has a local parent");
    if metadata_directory(local)? {
        metadata_directory(&staging)?;
        let journal = layout.scan_journal_file();
        if metadata_directory(journal.parent().expect("journal has a parent"))? {
            metadata_file(&journal)?;
        }
    }
    Ok(())
}

fn unlinked_type(path: &Path) -> Result<Option<fs::FileType>, MetaError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(source) => return Err(io_at(path, source)),
    };
    let kind = metadata.file_type();
    if kind.is_symlink() {
        return Err(invalid(
            path,
            "metadata paths must not be symbolic links or junctions",
        ));
    }
    Ok(Some(kind))
}

fn metadata_directory(path: &Path) -> Result<bool, MetaError> {
    match unlinked_type(path)? {
        None => Ok(false),
        Some(kind) if kind.is_dir() => Ok(true),
        Some(_) => Err(invalid(path, "metadata folder is not a directory")),
    }
}

fn metadata_file(path: &Path) -> Result<(), MetaError> {
    if unlinked_type(path)?.is_some_and(|kind| !kind.is_file()) {
        return Err(invalid(path, "metadata file is not a regular file"));
    }
    Ok(())
}

fn io_at(path: &Path, source: io::Error) -> MetaError {
    MetaError::Io {
        path: path.to_owned(),
        source,
    }
}

/// Creates metadata without modifying existing content. `library.json` is published last.
/// Existing `.folio` content, including a failed earlier creation, is never overwritten.
pub fn create(
    root: &Path,
    name: DisplayName,
    names: [DisplayName; 5],
) -> Result<LibraryConfig, MetaError> {
    let layout = Layout::new(root);
    for ancestor in root.ancestors() {
        let marker = Layout::new(ancestor).library_file();
        if marker.try_exists().map_err(|source| MetaError::Io {
            path: marker.clone(),
            source,
        })? {
            return Err(MetaError::Io {
                path: marker,
                source: io::Error::from(io::ErrorKind::AlreadyExists),
            });
        }
    }
    let config = LibraryConfig::new(name)?;
    let tags = TagDefinitions::with_presets(|preset| {
        names[match preset {
            PresetTag::Notes => 0,
            PresetTag::Slides => 1,
            PresetTag::Homework => 2,
            PresetTag::Exam => 3,
            PresetTag::Reference => 4,
        }]
        .clone()
    });
    fs::create_dir(layout.folio_dir()).map_err(|source| MetaError::Io {
        path: layout.folio_dir(),
        source,
    })?;
    validate_metadata(root)?;
    layout.write_tags(&tags)?;
    layout.write_library(&config)?;
    Ok(config)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names() -> [DisplayName; 5] {
        ["Notes", "Slides", "Homework", "Exam", "Reference"].map(|s| DisplayName::parse(s).unwrap())
    }

    #[test]
    fn settings_round_trip_preserves_unknown_fields_and_rejects_bad_versions() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(Settings::load(dir.path()).unwrap(), Settings::default());
        let mut settings = Settings {
            library_root: Some(dir.path().to_owned()),
            ..Settings::default()
        };
        settings
            .extra
            .insert("theme".to_owned(), Value::String("dark".to_owned()));
        settings.save(dir.path()).unwrap();
        assert_eq!(Settings::load(dir.path()).unwrap(), settings);
        let file = dir.path().join("settings.json");
        let newer = br#"{"format_version":2,"library_root":null}"#;
        fs::write(&file, newer).unwrap();
        assert!(matches!(
            Settings::load(dir.path()),
            Err(MetaError::NewerFormat { .. })
        ));
        assert_eq!(fs::read(&file).unwrap(), newer);
        fs::write(&file, br#"{"format_version":1,"library_root":"relative"}"#).unwrap();
        assert!(matches!(
            Settings::load(dir.path()),
            Err(MetaError::Invalid { .. })
        ));
        fs::write(&file, b"{").unwrap();
        assert!(Settings::load(dir.path()).is_err());
    }

    #[test]
    fn take_over_keeps_files_and_refuses_existing_nested_or_incomplete_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("notes.md");
        fs::write(&file, b"original").unwrap();
        let config = create(dir.path(), DisplayName::parse("Library").unwrap(), names()).unwrap();
        assert_eq!(
            Layout::new(dir.path()).read_library().unwrap(),
            Some(config)
        );
        assert_eq!(
            Layout::new(dir.path())
                .read_tags()
                .unwrap()
                .unwrap()
                .tags
                .len(),
            5
        );
        assert_eq!(fs::read(file).unwrap(), b"original");
        assert!(create(dir.path(), DisplayName::parse("Again").unwrap(), names()).is_err());
        let nested = dir.path().join("nested");
        fs::create_dir(&nested).unwrap();
        assert!(create(&nested, DisplayName::parse("Nested").unwrap(), names()).is_err());
        assert!(!nested.join(".folio").exists());
        let incomplete = tempfile::tempdir().unwrap();
        fs::create_dir(incomplete.path().join(".folio")).unwrap();
        assert!(
            create(
                incomplete.path(),
                DisplayName::parse("Incomplete").unwrap(),
                names()
            )
            .is_err()
        );
    }
}
