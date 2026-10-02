//! Settings commands (ipc-m1.md §22): App settings, which belong to this computer and live in
//! `settings.json` beside the catalogs, and the library's ignore rules (`library/ignore.rs`).

use std::sync::{Mutex, OnceLock, PoisonError};

use folio_core::library::state::{self, Settings};
use tauri::{Manager, State, WebviewWindow};
use tauri_specta::Event;

use super::blocking;
use crate::diagnostics;
use crate::error::AppError;
use crate::ipc::events::{AppSettingsChanged, IgnoreRulesChanged};
use crate::ipc::settings::{
    AppSettings, IgnoreRules, ReduceMotion, SetIgnoreRules, Theme, UpdateAppSettings,
};
use crate::library::{LibraryState, display_name};
use crate::window_background;

// App settings need no library: the library state only lends them `settings.json`, which it
// also writes, and `blocking`, which keeps file I/O off the async runtime.

#[tauri::command]
#[specta::specta]
pub async fn get_app_settings(state: State<'_, LibraryState>) -> Result<AppSettings, AppError> {
    blocking(state, "read App settings", |state| {
        Ok(app_settings(&state.settings()?))
    })
    .await
}

/// Saves the fields that are not `null`. A change goes to every listener as
/// `AppSettingsChanged`, and a new theme repaints the window background; both only follow a
/// saved change, so their failures go to the log instead of failing the command.
#[tauri::command]
#[specta::specta]
pub async fn update_app_settings(
    window: WebviewWindow,
    state: State<'_, LibraryState>,
    request: UpdateAppSettings,
) -> Result<AppSettings, AppError> {
    blocking(state, "save App settings", move |state| {
        // One update at a time from its save to its event, so events arrive in the order of the
        // saves and the last one holds what the file holds.
        static ANNOUNCING: Mutex<()> = Mutex::new(());
        let _order = ANNOUNCING.lock().unwrap_or_else(PoisonError::into_inner);
        let (before, after) = update(&state, request)?;
        let settings = app_settings(&after);
        // The page's `prefers-color-scheme` and the window background follow the window's theme
        // (`window_background::follow_theme`).
        if after.theme != before.theme
            && let Err(error) = window.set_theme(window_background::window_theme(after.theme))
        {
            diagnostics::report(
                window.app_handle(),
                &format!("window theme not updated: {error}"),
            );
        }
        if after != before {
            let event = AppSettingsChanged {
                settings: settings.clone(),
            };
            if let Err(error) = event.emit(&window) {
                diagnostics::report(
                    window.app_handle(),
                    &format!("App settings event failed: {error}"),
                );
            }
        }
        Ok(settings)
    })
    .await
}

#[tauri::command]
#[specta::specta]
pub async fn get_ignore_rules(state: State<'_, LibraryState>) -> Result<IgnoreRules, AppError> {
    blocking(state, "read ignore rules", |state| state.ignore_rules()).await
}

/// Saves the rules; the watcher sees `.folio/ignore` change and starts a full scan.
#[tauri::command]
#[specta::specta]
pub async fn set_ignore_rules(
    window: WebviewWindow,
    state: State<'_, LibraryState>,
    request: SetIgnoreRules,
) -> Result<IgnoreRules, AppError> {
    blocking(state, "save ignore rules", move |state| {
        state.set_ignore_rules(request, |rules| {
            let event = IgnoreRulesChanged {
                rules: rules.clone(),
            };
            if let Err(error) = event.emit(&window) {
                diagnostics::report(
                    window.app_handle(),
                    &format!("ignore rules event failed: {error}"),
                );
            }
        })
    })
    .await
}

/// Validates the request before taking the settings lock, then saves what it changes. Returns
/// the settings before and after.
fn update(
    state: &LibraryState,
    request: UpdateAppSettings,
) -> Result<(Settings, Settings), AppError> {
    let device_name = request
        .device_name
        .as_deref()
        .map(display_name)
        .transpose()?;
    state.update_settings(|settings| {
        if let Some(name) = device_name {
            settings.device_name = Some(name);
        }
        if let Some(theme) = request.theme {
            settings.theme = theme.into();
        }
        if let Some(reduce_motion) = request.reduce_motion {
            settings.reduce_motion = reduce_motion.into();
        }
    })
}

fn app_settings(settings: &Settings) -> AppSettings {
    AppSettings {
        device_name: settings
            .device_name
            .as_ref()
            .map(|name| name.as_str().to_owned())
            .or_else(computer_name),
        theme: settings.theme.into(),
        reduce_motion: settings.reduce_motion.into(),
    }
}

/// The name Windows shows as this computer's "Device name", read once: Windows renames a
/// computer only when it restarts.
fn computer_name() -> Option<String> {
    static NAME: OnceLock<Option<String>> = OnceLock::new();
    NAME.get_or_init(read_computer_name).clone()
}

/// The computer's DNS host name as typed, else its NetBIOS name. `None` when neither can be read
/// or neither is a valid display name.
#[allow(
    unsafe_code,
    reason = "Win32 FFI; each unsafe block states why it is sound"
)]
fn read_computer_name() -> Option<String> {
    use windows::Win32::System::SystemInformation::{
        ComputerNamePhysicalDnsHostname, ComputerNamePhysicalNetBIOS, GetComputerNameExW,
    };
    use windows::core::PWSTR;

    [ComputerNamePhysicalDnsHostname, ComputerNamePhysicalNetBIOS]
        .into_iter()
        .find_map(|format| {
            let mut size = 0_u32;
            // SAFETY: without a buffer the call only writes the size it needs, terminator
            // included, to `size`; it fails with ERROR_MORE_DATA, which is expected.
            let _ = unsafe { GetComputerNameExW(format, None, &mut size) };
            if size == 0 {
                return None;
            }
            let mut buffer = vec![0_u16; size as usize];
            // SAFETY: `buffer` holds exactly `size` UTF-16 units, the capacity `size` states;
            // on success `size` is the length written, without the terminator.
            unsafe { GetComputerNameExW(format, Some(PWSTR(buffer.as_mut_ptr())), &mut size) }
                .ok()?;
            let name = String::from_utf16(buffer.get(..size as usize)?).ok()?;
            display_name(&name)
                .ok()
                .map(|name| name.as_str().to_owned())
        })
}

impl From<state::Theme> for Theme {
    fn from(theme: state::Theme) -> Self {
        match theme {
            state::Theme::System => Self::System,
            state::Theme::Light => Self::Light,
            state::Theme::Dark => Self::Dark,
        }
    }
}

impl From<Theme> for state::Theme {
    fn from(theme: Theme) -> Self {
        match theme {
            Theme::System => Self::System,
            Theme::Light => Self::Light,
            Theme::Dark => Self::Dark,
        }
    }
}

impl From<state::ReduceMotion> for ReduceMotion {
    fn from(reduce_motion: state::ReduceMotion) -> Self {
        match reduce_motion {
            state::ReduceMotion::System => Self::System,
            state::ReduceMotion::On => Self::On,
            state::ReduceMotion::Off => Self::Off,
        }
    }
}

impl From<ReduceMotion> for state::ReduceMotion {
    fn from(reduce_motion: ReduceMotion) -> Self {
        match reduce_motion {
            ReduceMotion::System => Self::System,
            ReduceMotion::On => Self::On,
            ReduceMotion::Off => Self::Off,
        }
    }
}

#[cfg(test)]
mod tests;
