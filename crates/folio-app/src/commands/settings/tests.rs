//! App settings: validation, partial updates and the stored file (ipc-m1 §22).

use std::fs;
use std::path::Path;
use std::sync::Arc;

use super::*;
use crate::ipc::types::LIMITS;

/// The library state of an app that has no library: App settings need only its data directory.
fn without_library(data: &Path) -> LibraryState {
    LibraryState::new(Ok(data.to_owned()), Arc::new(|_| {}))
}

fn change(
    device_name: Option<&str>,
    theme: Option<Theme>,
    reduce_motion: Option<ReduceMotion>,
) -> UpdateAppSettings {
    UpdateAppSettings {
        device_name: device_name.map(str::to_owned),
        theme,
        reduce_motion,
    }
}

#[test]
fn defaults_follow_windows_and_name_the_computer() {
    let dir = tempfile::tempdir().unwrap();
    let settings = app_settings(&without_library(dir.path()).settings().unwrap());
    assert_eq!(settings.theme, Theme::System);
    assert_eq!(settings.reduce_motion, ReduceMotion::System);
    // Every Windows computer has a name; it is what Settings → System → About shows.
    let name = settings.device_name.expect("Windows names this computer");
    assert!(!name.is_empty() && name.trim() == name, "{name:?}");
    assert_eq!(read_computer_name().as_deref(), Some(name.as_str()));
}

#[test]
fn each_field_changes_alone_and_an_unchanged_request_writes_nothing() {
    let dir = tempfile::tempdir().unwrap();
    let state = without_library(dir.path());
    let file = dir.path().join("settings.json");
    let (before, after) = update(&state, change(None, None, None)).unwrap();
    assert!(before == after && !file.exists());

    let (_, dark) = update(&state, change(None, Some(Theme::Dark), None)).unwrap();
    assert_eq!(
        app_settings(&dark),
        AppSettings {
            theme: Theme::Dark,
            ..app_settings(&after)
        }
    );
    // Typed names are trimmed and converted to NFC, as the IME and File Explorer expect.
    let (before, named) = update(
        &state,
        change(Some("  Cafe\u{301} PC "), None, Some(ReduceMotion::On)),
    )
    .unwrap();
    assert_eq!(before.theme, named.theme, "the background keeps its colour");
    assert_eq!(
        app_settings(&named),
        AppSettings {
            device_name: Some("Café PC".to_owned()),
            theme: Theme::Dark,
            reduce_motion: ReduceMotion::On,
        }
    );
    let (before, again) = update(&state, change(Some("Café PC"), Some(Theme::Dark), None)).unwrap();
    assert!(
        before == again && again == named,
        "nothing changed, nothing to announce"
    );

    // What the next start reads, and what other writers keep.
    assert_eq!(state.settings().unwrap(), named);
    let library = dir.path().join("library");
    state
        .update_settings(|settings| settings.library_root = Some(library.clone()))
        .unwrap();
    update(&state, change(None, Some(Theme::Light), None)).unwrap();
    assert_eq!(state.settings().unwrap().library_root, Some(library));
}

#[test]
fn device_names_follow_the_display_name_rules() {
    let dir = tempfile::tempdir().unwrap();
    let state = without_library(dir.path());
    let too_long = "字".repeat(LIMITS.display_name_chars as usize + 1);
    for (name, expected) in [
        ("   ", "NameEmpty"),
        (too_long.as_str(), "NameTooLong"),
        ("G\u{7}16", "NameInvalidCharacter"),
    ] {
        let error = update(&state, change(Some(name), Some(Theme::Dark), None)).unwrap_err();
        assert_eq!(code(&error), expected, "{name:?}");
    }
    assert!(
        !dir.path().join("settings.json").exists(),
        "a refused name changes no other field"
    );
    let longest = "字".repeat(LIMITS.display_name_chars as usize);
    let (_, after) = update(&state, change(Some(&longest), None, None)).unwrap();
    assert_eq!(app_settings(&after).device_name, Some(longest));
}

#[test]
fn an_unreadable_settings_file_is_the_data_directory_failing_and_stays() {
    let dir = tempfile::tempdir().unwrap();
    let state = without_library(dir.path());
    let file = dir.path().join("settings.json");
    for bytes in [&b"{"[..], br#"{"format_version":2,"library_root":null}"#] {
        fs::write(&file, bytes).unwrap();
        let error = update(&state, change(None, Some(Theme::Light), None)).unwrap_err();
        assert!(
            matches!(error, AppError::DataDirUnavailable(_)),
            "{error:?}"
        );
        assert!(matches!(
            state.settings(),
            Err(AppError::DataDirUnavailable(_))
        ));
        assert_eq!(fs::read(&file).unwrap(), bytes);
    }
}

#[test]
fn appearance_values_cross_ipc_as_the_ui_names_them() {
    fn json(value: &impl serde::Serialize) -> String {
        serde_json::to_string(value).unwrap()
    }
    assert_eq!(json(&Theme::System), r#""system""#);
    assert_eq!(json(&Theme::Light), r#""light""#);
    assert_eq!(json(&Theme::Dark), r#""dark""#);
    assert_eq!(json(&ReduceMotion::On), r#""on""#);
    assert_eq!(json(&ReduceMotion::Off), r#""off""#);
    let request: UpdateAppSettings =
        serde_json::from_str(r#"{"deviceName":null,"theme":"dark","reduceMotion":null}"#).unwrap();
    assert_eq!(request, change(None, Some(Theme::Dark), None));
    for theme in [Theme::System, Theme::Light, Theme::Dark] {
        assert_eq!(Theme::from(state::Theme::from(theme)), theme);
    }
    for motion in [ReduceMotion::System, ReduceMotion::On, ReduceMotion::Off] {
        assert_eq!(
            ReduceMotion::from(state::ReduceMotion::from(motion)),
            motion
        );
    }
}

fn code(error: &AppError) -> String {
    serde_json::to_value(error).unwrap()["code"]
        .as_str()
        .unwrap()
        .to_owned()
}
