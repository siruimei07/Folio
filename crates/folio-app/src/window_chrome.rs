//! Windows 11 snap layouts for the custom title bar (ADR-0001, spike 4b).
//!
//! The main window has no native title bar (`decorations: false`), and WebView2 covers its whole
//! client area with a child window that answers every hit test there. So Windows never learns
//! where the maximize button is, and it shows no snap layouts flyout. The fix every working Tauri
//! app uses: an invisible child window over the HTML maximize button that answers `WM_NCHITTEST`
//! with `HTMAXBUTTON`. It never paints, so the HTML button shows through. It does receive the
//! mouse instead of the page, so it reports hover and press to the page
//! ([`MaximizeButtonChanged`]) and maximizes or restores the window on click itself.
//!
//! Win32 windows may only be changed by the thread that created them. Everything here runs on
//! the UI thread: Tauri's `setup` hook and synchronous commands run there, and
//! [`ui_thread_hwnd`] checks it.

#![allow(
    unsafe_code,
    reason = "Win32 FFI; each unsafe block states why it is sound"
)]

use std::cell::Cell;
use std::mem::{size_of, zeroed};
use std::ptr::{null, null_mut};

use serde::{Deserialize, Serialize};
use specta::Type;
use tauri::{AppHandle, Manager, WebviewWindow};
use tauri_specta::Event;
use windows_sys::Win32::Foundation::{
    ERROR_CLASS_ALREADY_EXISTS, HWND, LPARAM, LRESULT, RECT, WPARAM,
};
use windows_sys::Win32::Graphics::Gdi::{GetStockObject, HBRUSH, NULL_BRUSH};
use windows_sys::Win32::System::LibraryLoader::GetModuleHandleW;
use windows_sys::Win32::System::Threading::GetCurrentThreadId;
use windows_sys::Win32::UI::HiDpi::GetDpiForWindow;
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    TME_LEAVE, TME_NONCLIENT, TRACKMOUSEEVENT, TrackMouseEvent,
};
use windows_sys::Win32::UI::Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CreateWindowExW, DefWindowProcW, DestroyWindow, FindWindowExW, GWLP_USERDATA, GWLP_WNDPROC,
    GetClientRect, GetWindowLongPtrW, GetWindowThreadProcessId, HTMAXBUTTON, HWND_TOP, IsZoomed,
    PostMessageW, RegisterClassExW, SC_MAXIMIZE, SC_RESTORE, SW_HIDE, SWP_NOACTIVATE,
    SWP_SHOWWINDOW, SetWindowLongPtrW, SetWindowPos, ShowWindow, WM_DPICHANGED, WM_NCDESTROY,
    WM_NCHITTEST, WM_NCLBUTTONDOWN, WM_NCLBUTTONUP, WM_NCMOUSELEAVE, WM_NCMOUSEMOVE, WM_SIZE,
    WM_SYSCOMMAND, WNDCLASSEXW, WS_CHILD, WS_CLIPSIBLINGS,
};
use windows_sys::w;

use crate::{diagnostics, error::AppError};

const OVERLAY_CLASS: *const u16 = w!("FolioSnapLayoutsOverlay");
const SUBCLASS_ID: usize = 1;
/// The page may position a caption button, never an input surface over the whole window.
const MAX_BUTTON_WIDTH: u32 = 64;
const CAPTION_HEIGHT: u32 = 48;
const CAPTION_RIGHT_BAND: u32 = 160;

/// Where the HTML maximize button is, in whole CSS pixels. `right` is the distance from the
/// window's right edge to the button's right edge. Caption buttons are anchored to the right, so
/// the overlay can follow window resizes without asking the page again.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Type)]
pub struct ButtonBounds {
    pub right: u32,
    pub top: u32,
    pub width: u32,
    pub height: u32,
}

impl ButtonBounds {
    /// The page measures these values; reject anything a real layout cannot produce.
    fn validate(&self) -> Result<(), AppError> {
        if self.width > 0
            && self.width <= MAX_BUTTON_WIDTH
            && self.height > 0
            && self
                .top
                .checked_add(self.height)
                .is_some_and(|end| end <= CAPTION_HEIGHT)
            && self
                .right
                .checked_add(self.width)
                .is_some_and(|end| end <= CAPTION_RIGHT_BAND)
        {
            Ok(())
        } else {
            Err(AppError::InvalidArgument(format!(
                "maximize button bounds out of range: {self:?}"
            )))
        }
    }

    /// The overlay rectangle in physical pixels of the window's client area.
    fn client_rect(&self, client_width: i32, dpi: u32) -> RECT {
        let scale = f64::from(dpi) / 96.0;
        let px = |value: u32| (f64::from(value) * scale).round() as i32;
        let right = client_width - px(self.right);
        let top = px(self.top);
        RECT {
            left: right - px(self.width).max(1),
            top,
            right,
            bottom: top + px(self.height).max(1),
        }
    }
}

/// Hover and press state of the maximize button. The overlay receives the mouse over the button,
/// so the page gets no `:hover` or pointer events there and styles the button from this event.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Type, tauri_specta::Event)]
pub struct MaximizeButtonChanged {
    pub hovered: bool,
    pub pressed: bool,
}

/// Creates the overlay for the main window. It stays hidden until the page reports where the
/// maximize button is ([`set_maximize_button_bounds`]).
pub fn install(window: &WebviewWindow) -> Result<(), AppError> {
    let parent = ui_thread_hwnd(window)?;
    // SAFETY: `parent` is a live window owned by this thread (checked by `ui_thread_hwnd`).
    unsafe { create_overlay(parent, window.app_handle().clone()) }
}

/// Moves and shows the overlay, or hides it and clears pointer state for `None`.
pub fn set_maximize_button_bounds(
    window: &WebviewWindow,
    bounds: Option<ButtonBounds>,
) -> Result<(), AppError> {
    if let Some(bounds) = bounds {
        bounds.validate()?;
    }
    let parent = ui_thread_hwnd(window)?;
    // SAFETY: `parent` is a live window owned by this thread, and so is its overlay child.
    unsafe {
        let overlay = find_overlay(parent);
        let state = overlay_state(overlay)
            .ok_or_else(|| AppError::Window("the snap layouts overlay is missing".to_owned()))?;
        state.bounds.set(bounds);
        if bounds.is_none() {
            update(state, |button| *button = MaximizeButtonChanged::default());
        }
        position(overlay, parent, bounds)
    }
}

/// The window's handle, after checking that this thread owns it.
fn ui_thread_hwnd(window: &WebviewWindow) -> Result<HWND, AppError> {
    let hwnd = window
        .hwnd()
        .map_err(|error| AppError::Window(error.to_string()))?
        .0;
    // SAFETY: both calls only read; an invalid handle yields thread id 0.
    let (owner, current) = unsafe {
        (
            GetWindowThreadProcessId(hwnd, null_mut()),
            GetCurrentThreadId(),
        )
    };
    if owner == current {
        Ok(hwnd)
    } else {
        Err(AppError::Window(
            "window chrome must be changed on the UI thread".to_owned(),
        ))
    }
}

/// Per-overlay state. The overlay window owns it through `GWLP_USERDATA` and frees it in
/// `WM_NCDESTROY`. Only the UI thread touches it, and `Cell` keeps it safe under re-entrant
/// window messages.
struct OverlayState {
    parent: HWND,
    app: AppHandle,
    bounds: Cell<Option<ButtonBounds>>,
    button: Cell<MaximizeButtonChanged>,
}

/// # Safety
/// `parent` must be a live window owned by the calling thread.
unsafe fn create_overlay(parent: HWND, app: AppHandle) -> Result<(), AppError> {
    // SAFETY: plain Win32 calls with valid arguments, on the thread that owns `parent`. The state
    // is attached only after the overlay exists, so exactly one WM_NCDESTROY frees it.
    unsafe {
        let instance = GetModuleHandleW(null());
        let class = WNDCLASSEXW {
            cbSize: size_of::<WNDCLASSEXW>() as u32,
            lpfnWndProc: Some(overlay_proc),
            hInstance: instance,
            // Never painted, so the HTML button shows through.
            hbrBackground: GetStockObject(NULL_BRUSH) as HBRUSH,
            lpszClassName: OVERLAY_CLASS,
            ..zeroed()
        };
        if RegisterClassExW(&class) == 0 {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() != Some(ERROR_CLASS_ALREADY_EXISTS as i32) {
                return Err(AppError::Window(format!(
                    "RegisterClassExW failed: {error}"
                )));
            }
        }

        // WS_CLIPSIBLINGS stops WebView2's sibling window from claiming this rectangle.
        let overlay = CreateWindowExW(
            0,
            OVERLAY_CLASS,
            null(),
            WS_CHILD | WS_CLIPSIBLINGS,
            0,
            0,
            0,
            0,
            parent,
            null_mut(),
            instance,
            null(),
        );
        if overlay.is_null() {
            return Err(AppError::Window(format!(
                "CreateWindowExW failed: {}",
                std::io::Error::last_os_error()
            )));
        }
        let state = Box::new(OverlayState {
            parent,
            app,
            bounds: Cell::new(None),
            button: Cell::new(MaximizeButtonChanged::default()),
        });
        SetWindowLongPtrW(overlay, GWLP_USERDATA, Box::into_raw(state) as isize);

        if SetWindowSubclass(parent, Some(parent_proc), SUBCLASS_ID, 0) == 0 {
            DestroyWindow(overlay);
            return Err(AppError::Window("SetWindowSubclass failed".to_owned()));
        }
        Ok(())
    }
}

/// The overlay child of `parent`, or null if it has none.
///
/// # Safety
/// `parent` must be a live window owned by the calling thread.
unsafe fn find_overlay(parent: HWND) -> HWND {
    // SAFETY: only reads the child list of a live window.
    unsafe { FindWindowExW(parent, null_mut(), OVERLAY_CLASS, null()) }
}

/// # Safety
/// `overlay` must be null or an overlay window owned by the calling thread.
unsafe fn overlay_state<'a>(overlay: HWND) -> Option<&'a OverlayState> {
    if overlay.is_null() {
        return None;
    }
    // SAFETY: verify ownership and our window procedure before trusting a class-name match.
    unsafe {
        if GetWindowThreadProcessId(overlay, null_mut()) != GetCurrentThreadId()
            || GetWindowLongPtrW(overlay, GWLP_WNDPROC) != overlay_proc as *const () as isize
        {
            return None;
        }
    }
    // SAFETY: an overlay stores either 0 or a valid `OverlayState` pointer, which stays valid
    // until the overlay's WM_NCDESTROY on this thread, after every message that uses it.
    unsafe { (GetWindowLongPtrW(overlay, GWLP_USERDATA) as *const OverlayState).as_ref() }
}

/// # Safety
/// `overlay` must be a live child window owned by this thread. `parent` is its parent or an
/// invalid handle (which GetClientRect rejects). No state borrow crosses SetWindowPos.
unsafe fn position(
    overlay: HWND,
    parent: HWND,
    bounds: Option<ButtonBounds>,
) -> Result<(), AppError> {
    // SAFETY: the overlay belongs to this thread; other calls only query the supplied parent.
    let result = (|| unsafe {
        let Some(bounds) = bounds else {
            ShowWindow(overlay, SW_HIDE);
            return Ok(());
        };
        let mut client: RECT = zeroed();
        if GetClientRect(parent, &mut client) == 0 {
            return Err(AppError::Window(format!(
                "GetClientRect failed: {}",
                std::io::Error::last_os_error()
            )));
        }
        let rect = bounds.client_rect(client.right, GetDpiForWindow(parent));
        if SetWindowPos(
            overlay,
            HWND_TOP,
            rect.left,
            rect.top,
            rect.right - rect.left,
            rect.bottom - rect.top,
            SWP_NOACTIVATE | SWP_SHOWWINDOW,
        ) == 0
        {
            return Err(AppError::Window(format!(
                "SetWindowPos failed: {}",
                std::io::Error::last_os_error()
            )));
        }
        Ok(())
    })();
    if result.is_err() {
        // SAFETY: hiding our overlay prevents a failed move from leaving stale input interception.
        unsafe {
            ShowWindow(overlay, SW_HIDE);
        }
    }
    result
}

/// Changes the button state and tells the page when it changed.
fn update(state: &OverlayState, change: impl FnOnce(&mut MaximizeButtonChanged)) {
    let mut button = state.button.get();
    change(&mut button);
    if button != state.button.get() {
        state.button.set(button);
        if let Err(error) = button.emit(&state.app) {
            diagnostics::report(
                &state.app,
                &format!("failed to send MaximizeButtonChanged: {error}"),
            );
        }
    }
}

/// Keeps the overlay in place when the main window is resized or moves to another display.
unsafe extern "system" fn parent_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _subclass_id: usize,
    _ref_data: usize,
) -> LRESULT {
    // SAFETY: called by Windows on the UI thread for the subclassed main window.
    unsafe {
        let result = DefSubclassProc(hwnd, msg, wparam, lparam);
        match msg {
            WM_SIZE | WM_DPICHANGED => {
                let overlay = find_overlay(hwnd);
                if let Some(state) = overlay_state(overlay) {
                    let app = state.app.clone();
                    if let Err(error) = position(overlay, hwnd, state.bounds.get()) {
                        diagnostics::report(
                            &app,
                            &format!("failed to move the snap layouts overlay: {error}"),
                        );
                    }
                }
            }
            WM_NCDESTROY => {
                RemoveWindowSubclass(hwnd, Some(parent_proc), SUBCLASS_ID);
            }
            _ => {}
        }
        result
    }
}

unsafe extern "system" fn overlay_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: called by Windows on the UI thread for an overlay window.
    unsafe {
        match msg {
            WM_NCDESTROY => {
                let state = SetWindowLongPtrW(hwnd, GWLP_USERDATA, 0) as *mut OverlayState;
                if !state.is_null() {
                    drop(Box::from_raw(state));
                }
            }
            // The whole point: Windows shows the snap layouts flyout for this answer.
            WM_NCHITTEST => return HTMAXBUTTON as LRESULT,
            WM_NCMOUSEMOVE => {
                if let Some(state) = overlay_state(hwnd)
                    && !state.button.get().hovered
                {
                    // Ask for WM_NCMOUSELEAVE when the pointer leaves the overlay.
                    let mut track = TRACKMOUSEEVENT {
                        cbSize: size_of::<TRACKMOUSEEVENT>() as u32,
                        dwFlags: TME_LEAVE | TME_NONCLIENT,
                        hwndTrack: hwnd,
                        dwHoverTime: 0,
                    };
                    if TrackMouseEvent(&mut track) == 0 {
                        diagnostics::report(
                            &state.app,
                            &format!(
                                "TrackMouseEvent failed: {}",
                                std::io::Error::last_os_error()
                            ),
                        );
                    } else {
                        update(state, |button| button.hovered = true);
                    }
                }
                return 0;
            }
            WM_NCMOUSELEAVE => {
                if let Some(state) = overlay_state(hwnd) {
                    update(state, |button| *button = MaximizeButtonChanged::default());
                }
                return 0;
            }
            WM_NCLBUTTONDOWN => {
                if let Some(state) = overlay_state(hwnd) {
                    update(state, |button| button.pressed = true);
                }
                return 0;
            }
            WM_NCLBUTTONUP => {
                if let Some(state) = overlay_state(hwnd) {
                    if state.button.get().pressed {
                        let command = if IsZoomed(state.parent) != 0 {
                            SC_RESTORE
                        } else {
                            SC_MAXIMIZE
                        };
                        if PostMessageW(state.parent, WM_SYSCOMMAND, command as WPARAM, 0) == 0 {
                            diagnostics::report(
                                &state.app,
                                &format!(
                                    "PostMessageW failed: {}",
                                    std::io::Error::last_os_error()
                                ),
                            );
                        }
                    }
                    update(state, |button| button.pressed = false);
                }
                return 0;
            }
            _ => {}
        }
        DefWindowProcW(hwnd, msg, wparam, lparam)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn bounds(right: u32, top: u32, width: u32, height: u32) -> ButtonBounds {
        ButtonBounds {
            right,
            top,
            width,
            height,
        }
    }

    #[test]
    fn accepts_a_real_button() {
        assert!(bounds(46, 0, 46, 32).validate().is_ok());
    }

    #[test]
    fn rejects_bounds_no_layout_produces() {
        for bad in [
            bounds(46, 0, 0, 32),
            bounds(46, 0, 46, 0),
            bounds(0, 0, 10_000, 10_000),
            bounds(46, 0, MAX_BUTTON_WIDTH + 1, 32),
            bounds(46, 17, 46, 32),
            bounds(115, 0, 46, 32),
            bounds(u32::MAX, 0, 46, 32),
            bounds(46, u32::MAX, 46, 32),
        ] {
            assert!(
                matches!(bad.validate(), Err(AppError::InvalidArgument(_))),
                "{bad:?}"
            );
        }
    }

    #[test]
    fn places_the_overlay_from_the_right_edge() {
        let rect = bounds(46, 0, 46, 32).client_rect(1280, 96);
        assert_eq!(
            (rect.left, rect.top, rect.right, rect.bottom),
            (1188, 0, 1234, 32)
        );
    }

    #[test]
    fn scales_css_pixels_by_the_window_dpi() {
        // 150 % scaling: 144 dpi.
        let rect = bounds(46, 0, 46, 32).client_rect(1920, 144);
        assert_eq!(
            (rect.left, rect.top, rect.right, rect.bottom),
            (1782, 0, 1851, 48)
        );
    }

    #[test]
    fn hides_overlay_for_absent_bounds_and_failed_positioning() {
        use windows_sys::Win32::UI::WindowsAndMessaging::{GWL_STYLE, GetWindowLongW, WS_VISIBLE};

        // SAFETY: standard STATIC windows are created and destroyed on this test thread. The
        // parent stays hidden; query the child's own visible style instead of ancestor visibility.
        unsafe {
            let parent = CreateWindowExW(
                0,
                w!("STATIC"),
                null(),
                0,
                0,
                0,
                500,
                320,
                null_mut(),
                null_mut(),
                null_mut(),
                null(),
            );
            assert!(!parent.is_null());
            let overlay = CreateWindowExW(
                0,
                w!("STATIC"),
                null(),
                WS_CHILD,
                0,
                0,
                0,
                0,
                parent,
                null_mut(),
                null_mut(),
                null(),
            );
            assert!(!overlay.is_null());
            let visible = || GetWindowLongW(overlay, GWL_STYLE) as u32 & WS_VISIBLE != 0;
            position(overlay, parent, Some(bounds(46, 0, 46, 32))).unwrap();
            assert!(visible());
            position(overlay, parent, None).unwrap();
            assert!(!visible());
            // A later resize with cleared bounds must not show it again.
            position(overlay, parent, None).unwrap();
            assert!(!visible());
            position(overlay, parent, Some(bounds(46, 0, 46, 32))).unwrap();
            assert!(visible());
            assert!(position(overlay, null_mut(), Some(bounds(46, 0, 46, 32))).is_err());
            assert!(!visible());
            // A class-name match must never make an unrelated window's USERDATA trusted.
            SetWindowLongPtrW(overlay, GWLP_USERDATA, 1);
            assert!(overlay_state(overlay).is_none());
            assert_ne!(DestroyWindow(parent), 0);
        }
    }
}
