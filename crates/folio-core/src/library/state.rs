//! Per-machine settings and first-time library creation (ADR-0002, library-state.md).

use std::collections::BTreeMap;
use std::fs::{self, File};
use std::io;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, PoisonError};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

use crate::files;
use crate::meta::{DisplayName, Layout, LibraryConfig, MetaError, PresetTag, TagDefinitions};

const SETTINGS_VERSION: u32 = 1;
const MAX_SETTINGS_BYTES: u64 = 1 << 20;

/// Settings belong to this machine, never to the synced library. Preserve fields of later lanes.
///
/// The App settings fields (ipc-m1 §22) are cosmetic, so a value this Folio does not know, written
/// by a newer Folio or by hand, reads as the default instead of failing the whole file (and with
/// it the library); the next save replaces it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Settings {
    pub format_version: u32,
    pub library_root: Option<PathBuf>,
    /// This computer's name in History; `None`: the name Windows gives the computer.
    #[serde(default, deserialize_with = "lenient")]
    pub device_name: Option<DisplayName>,
    #[serde(default, deserialize_with = "lenient")]
    pub theme: Theme,
    #[serde(default, deserialize_with = "lenient")]
    pub reduce_motion: ReduceMotion,
    #[serde(flatten)]
    pub extra: BTreeMap<String, Value>,
}

/// The colour mode of the window.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Theme {
    /// Follows Windows' app mode.
    #[default]
    System,
    Light,
    Dark,
}

/// Whether animations are shortened to nothing.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ReduceMotion {
    /// Follows Windows' "Animation effects".
    #[default]
    System,
    On,
    Off,
}

/// A value of a type that has a default, or the default when the value does not fit the type.
fn lenient<'de, D: Deserializer<'de>, T: DeserializeOwned + Default>(
    deserializer: D,
) -> Result<T, D::Error> {
    Ok(serde_json::from_value(Value::deserialize(deserializer)?).unwrap_or_default())
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            format_version: SETTINGS_VERSION,
            library_root: None,
            device_name: None,
            theme: Theme::default(),
            reduce_motion: ReduceMotion::default(),
            extra: BTreeMap::new(),
        }
    }
}

impl Settings {
    /// Loads the settings, applies `change` and saves them if it changed anything, holding one
    /// lock for the whole process: switching libraries and App settings both write the file, and
    /// neither may save over the other's change with what it read before. Use it for every
    /// write. Returns the settings before and after the change.
    pub fn update(
        data_dir: &Path,
        change: impl FnOnce(&mut Self),
    ) -> Result<(Self, Self), MetaError> {
        static WRITER: Mutex<()> = Mutex::new(());
        let _writer = WRITER.lock().unwrap_or_else(PoisonError::into_inner);
        let before = Self::load(data_dir)?;
        let mut after = before.clone();
        change(&mut after);
        if after != before {
            after.save(data_dir)?;
        }
        Ok((before, after))
    }

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
        const TYPED: [&str; 5] = [
            "format_version",
            "library_root",
            "device_name",
            "theme",
            "reduce_motion",
        ];
        if self.format_version != SETTINGS_VERSION
            || self
                .library_root
                .as_ref()
                .is_some_and(|root| !root.is_absolute())
            || TYPED.iter().any(|key| self.extra.contains_key(*key))
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
        for entry in listing(&meta)? {
            let path = entry.map_err(|source| io_at(&meta, source))?.path();
            if unlinked_type(&path)?.is_some_and(|kind| kind.is_dir()) {
                // Metadata has only two levels: a semester folder and its group/course files.
                // Never recurse through an unchecked parent, even for an unknown filename.
                for child in listing(&path)? {
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
            metadata_file(&layout.import_journal_file())?;
        }
    }
    Ok(())
}

/// The entries of the metadata folder `path`, checked just before; none once it is gone. The
/// mirror removes a semester's folder when its last file goes, and a reader that checks without
/// the catalog's writer (the workspace) may list it after the removal: nothing left there to
/// follow.
fn listing(path: &Path) -> Result<impl Iterator<Item = io::Result<fs::DirEntry>>, MetaError> {
    match fs::read_dir(path) {
        Ok(entries) => Ok(Some(entries).into_iter().flatten()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok(None::<fs::ReadDir>.into_iter().flatten())
        }
        Err(source) => Err(io_at(path, source)),
    }
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
/// A `.folio` folder without `library.json`, left by a creation that failed, is finished in
/// place: what it holds is kept, and only the missing files are written.
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
    let fresh = match fs::create_dir(layout.folio_dir()) {
        Ok(()) => true,
        // An incomplete library. validate_metadata refuses a link or a file in its place.
        Err(source) if source.kind() == io::ErrorKind::AlreadyExists => false,
        Err(source) => return Err(io_at(&layout.folio_dir(), source)),
    };
    validate_metadata(root)?;
    if fresh || unlinked_type(&layout.tags_file())?.is_none() {
        layout.write_tags(&tags)?;
    }
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
            .insert("ai".to_owned(), Value::String("deepseek".to_owned()));
        settings.save(dir.path()).unwrap();
        assert_eq!(Settings::load(dir.path()).unwrap(), settings);
        // A typed field cannot hide in the untyped ones, where it would be written twice.
        settings
            .extra
            .insert("theme".to_owned(), Value::String("dark".to_owned()));
        assert!(matches!(
            settings.save(dir.path()),
            Err(MetaError::Invalid { .. })
        ));
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
    fn app_settings_round_trip_and_unknown_values_read_as_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        // Version 1 before App settings: the new fields take their defaults.
        fs::write(&file, br#"{"format_version":1,"library_root":null}"#).unwrap();
        assert_eq!(Settings::load(dir.path()).unwrap(), Settings::default());

        let settings = Settings {
            device_name: Some(DisplayName::parse("G16").unwrap()),
            theme: Theme::Dark,
            reduce_motion: ReduceMotion::On,
            ..Settings::default()
        };
        settings.save(dir.path()).unwrap();
        let text = fs::read_to_string(&file).unwrap();
        assert!(text.contains(r#""device_name": "G16""#), "{text}");
        assert!(text.contains(r#""theme": "dark""#), "{text}");
        assert!(text.contains(r#""reduce_motion": "on""#), "{text}");
        assert_eq!(Settings::load(dir.path()).unwrap(), settings);

        // A newer Folio's value, or a hand edit, must not cost the user their library.
        fs::write(
            &file,
            br#"{"format_version":1,"library_root":null,"device_name":" padded ","theme":"highContrast","reduce_motion":7}"#,
        )
        .unwrap();
        assert_eq!(Settings::load(dir.path()).unwrap(), Settings::default());
    }

    #[test]
    fn update_saves_only_changes_and_keeps_what_others_saved() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("settings.json");
        let (before, after) = Settings::update(dir.path(), |_| {}).unwrap();
        assert_eq!(
            (&before, &after),
            (&Settings::default(), &Settings::default())
        );
        assert!(!file.exists(), "an unchanged update writes nothing");

        let root = dir.path().join("library");
        Settings::update(dir.path(), |settings| {
            settings.library_root = Some(root.clone());
        })
        .unwrap();
        let (before, after) = Settings::update(dir.path(), |settings| {
            settings.theme = Theme::Light;
        })
        .unwrap();
        assert_eq!(before.theme, Theme::System);
        assert_eq!(after.theme, Theme::Light);
        assert_eq!(after.library_root.as_deref(), Some(root.as_path()));
        assert_eq!(Settings::load(dir.path()).unwrap(), after);

        // Writers on other threads each see the others' saves.
        std::thread::scope(|scope| {
            for n in 0..8 {
                let data = dir.path();
                scope.spawn(move || {
                    Settings::update(data, |settings| {
                        settings
                            .extra
                            .insert(format!("writer{n}"), Value::Bool(true));
                    })
                    .unwrap();
                });
            }
        });
        assert_eq!(Settings::load(dir.path()).unwrap().extra.len(), 8);
    }

    #[test]
    fn take_over_keeps_files_and_refuses_existing_or_nested_metadata() {
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
    }

    #[test]
    fn an_incomplete_library_is_finished_in_place_and_keeps_its_metadata() {
        // A creation that stopped after tags.json, with tags already in .folio/meta.
        let dir = tempfile::tempdir().unwrap();
        let layout = Layout::new(dir.path());
        fs::create_dir(layout.folio_dir()).unwrap();
        let mut tags = crate::test_support::presets("Old slides");
        tags.tags.remove(&PresetTag::Exam.id());
        layout.write_tags(&tags).unwrap();
        fs::create_dir(layout.meta_dir()).unwrap();
        let meta = layout.meta_dir().join("kept.txt");
        fs::write(&meta, b"kept").unwrap();

        let config = create(dir.path(), DisplayName::parse("Finished").unwrap(), names()).unwrap();
        assert_eq!(layout.read_library().unwrap(), Some(config));
        assert_eq!(layout.read_tags().unwrap(), Some(tags));
        assert_eq!(fs::read(&meta).unwrap(), b"kept");

        // Only tags.json and library.json were missing: the presets fill the first.
        let bare = tempfile::tempdir().unwrap();
        fs::create_dir(bare.path().join(".folio")).unwrap();
        create(bare.path(), DisplayName::parse("Bare").unwrap(), names()).unwrap();
        let presets = Layout::new(bare.path()).read_tags().unwrap().unwrap();
        assert_eq!(presets.tags.len(), 5);

        // A file where .folio belongs is not an incomplete library; nothing is written.
        let file = tempfile::tempdir().unwrap();
        fs::write(file.path().join(".folio"), b"not metadata").unwrap();
        assert!(matches!(
            create(file.path(), DisplayName::parse("File").unwrap(), names()),
            Err(MetaError::Invalid { .. })
        ));
        assert_eq!(
            fs::read(file.path().join(".folio")).unwrap(),
            b"not metadata"
        );
    }

    /// The link check lists a metadata folder removed since it was checked as empty: the
    /// workspace checks without the catalog's writer, while the mirror may remove a semester's
    /// folder with its last file.
    #[test]
    fn a_metadata_folder_removed_since_it_was_checked_lists_nothing() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(listing(&dir.path().join("gone")).unwrap().count(), 0);
        fs::write(dir.path().join("_group.json"), b"{}").unwrap();
        assert_eq!(listing(dir.path()).unwrap().count(), 1);
        assert!(listing(&dir.path().join("_group.json")).is_err());
    }
}
