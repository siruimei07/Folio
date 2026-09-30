//! The main window's colour before the page paints its first frame. WebView2 shows its default
//! background, white, until then, which flashes in dark mode (roadmap §3.4, feat/ui-app-shell).
//! The window is built from its configuration (`create: false` in tauri.conf.json) with the app
//! background of the mode Windows asks apps to use; the page's own theme then takes over, which
//! follows the same setting until App settings → Appearance exists (design/tokens/README.md
//! "Modes").

#![allow(
    unsafe_code,
    reason = "Win32 registry FFI; the unsafe block states why it is sound"
)]

use tauri::window::Color;
use windows::Win32::Foundation::ERROR_SUCCESS;
use windows::Win32::System::Registry::{HKEY_CURRENT_USER, RRF_RT_REG_DWORD, RegGetValueW};
use windows::core::w;

/// `color.surface.app` of the light and dark modes (design/tokens/color.*.tokens.json), the body
/// background of the page. A test keeps them equal to the tokens.
const LIGHT: Color = Color(0xf3, 0xf2, 0xf0, 0xff);
const DARK: Color = Color(0x15, 0x13, 0x12, 0xff);

/// The background for the window and its webview before the page has painted.
pub(crate) fn first_frame(dark: bool) -> Color {
    if dark { DARK } else { LIGHT }
}

/// Whether Windows asks apps for dark mode (Settings → Personalization → Colors → "Choose your
/// app mode"): the value WebView2's `prefers-color-scheme` follows. Light when it cannot be read,
/// as Windows itself defaults.
pub(crate) fn apps_use_dark_mode() -> bool {
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
    result == ERROR_SUCCESS && light == 0
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
        assert_eq!(first_frame(false), surface_app(light));
        assert_eq!(first_frame(true), surface_app(dark));
    }
}
