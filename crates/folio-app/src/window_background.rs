//! The main window's theme, and its colour before the page paints its first frame. WebView2 shows
//! its default background, white, until then, which flashes in dark mode (roadmap §3.4,
//! feat/ui-app-shell).
//!
//! The window is built from its configuration (`create: false` in tauri.conf.json) with the theme
//! stored in App settings → Appearance (ipc-m1 §22): Light and Dark fix the window's theme, System
//! leaves it to Windows. tauri-runtime-wry builds the webview with its window's theme as
//! `prefers-color-scheme` and passes every change of it on, so the page has the stored theme
//! before it sets `data-theme` (design/tokens/README.md "Modes"). The background is the app
//! background of the same theme. Both have to be set when the window is built: creating the
//! webview dispatches window messages, so the window can paint before the setup code that built
//! it goes on. After that, the background follows every change of the window's theme.

#![allow(
    unsafe_code,
    reason = "Win32 registry FFI; the unsafe block states why it is sound"
)]

use folio_core::library::state::Theme;
use tauri::window::Color;
use tauri::{Manager, WebviewWindow, WindowEvent};
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
use windows::core::w;

use crate::diagnostics;

/// `color.surface.app` of the light and dark modes (design/tokens/color.*.tokens.json), the body
/// background of the page. A test keeps them equal to the tokens.
const LIGHT: Color = Color(0xf3, 0xf2, 0xf0, 0xff);
const DARK: Color = Color(0x15, 0x13, 0x12, 0xff);

/// The window's theme for a theme from App settings; `None` leaves it to Windows.
pub(crate) fn window_theme(theme: Theme) -> Option<tauri::Theme> {
    match theme {
        Theme::System => None,
        Theme::Light => Some(tauri::Theme::Light),
        Theme::Dark => Some(tauri::Theme::Dark),
    }
}

/// The background for the window and its webview before the page has painted. For System it is
/// a guess from Windows' app mode, which `follow_theme` checks once the window exists.
pub(crate) fn for_theme(theme: Theme) -> Color {
    background(window_theme(theme).unwrap_or_else(app_mode))
}

/// Repaints the background whenever the window's theme changes: a new theme in App settings, or
/// Windows' mode while the theme is System. Also repaints it at once if the window was built with
/// another background than its theme's: with System, tao picks the theme itself and counts high
/// contrast as light.
pub(crate) fn follow_theme(window: &WebviewWindow, built: Color) {
    let target = window.clone();
    window.on_window_event(move |event| {
        if let WindowEvent::ThemeChanged(theme) = event {
            repaint(&target, *theme);
        }
    });
    match window.theme() {
        Ok(theme) if background(theme) != built => repaint(window, theme),
        Ok(_) => {}
        Err(error) => diagnostics::report(
            window.app_handle(),
            &format!("window theme unreadable: {error}"),
        ),
    }
}

fn repaint(window: &WebviewWindow, theme: tauri::Theme) {
    if let Err(error) = window.set_background_color(Some(background(theme))) {
        diagnostics::report(
            window.app_handle(),
            &format!("window background not updated: {error}"),
        );
    }
}

fn background(theme: tauri::Theme) -> Color {
    if theme == tauri::Theme::Dark {
        DARK
    } else {
        LIGHT
    }
}

/// The mode Windows asks apps to use (Settings → Personalization → Colors → "Choose your app
/// mode"). Light when it cannot be read, as Windows itself defaults.
fn app_mode() -> tauri::Theme {
    let mut light: u32 = 1;
    let mut size = std::mem::size_of::<u32>() as u32;
    // SAFETY: the output buffer is a live u32 and `size` gives its exact byte capacity.
    let result = unsafe {
        RegGetValueW(
            HKEY_CURRENT_USER,
            w!(r"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"),
            w!("AppsUseLightTheme"),
            RRF_RT_REG_DWORD,
            None,
            Some((&raw mut light).cast()),
            Some(&mut size),
        )
    };
    if result == ERROR_SUCCESS && light == 0 {
        tauri::Theme::Dark
    } else {
        tauri::Theme::Light
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `color.surface.app` from a token file, as its `hex` fallback.
    fn surface_app(tokens: &str) -> Color {
        let tokens: serde_json::Value = serde_json::from_str(tokens).expect("token file is JSON");
        let hex = tokens["color"]["surface"]["app"]["$value"]["hex"]
            .as_str()
            .expect("color.surface.app has a hex value");
        let channel = |at: usize| u8::from_str_radix(&hex[at..at + 2], 16).expect("hex digits");
        Color(channel(1), channel(3), channel(5), 0xff)
    }

    #[test]
    fn first_frame_matches_the_app_background_tokens() {
        let light = include_str!("../../../design/tokens/color.light.tokens.json");
        let dark = include_str!("../../../design/tokens/color.dark.tokens.json");
        assert_eq!(for_theme(Theme::Light), surface_app(light));
        assert_eq!(for_theme(Theme::Dark), surface_app(dark));
    }
}
