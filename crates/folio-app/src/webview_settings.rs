//! Release-only WebView2 settings, applied before the first navigation (UI architecture §6.4).

#![allow(
    unsafe_code,
    reason = "WebView2 COM calls on the controller's UI thread; the unsafe block states why it is sound"
)]

use tauri::utils::config::WindowConfig;
use tauri::{Url, WebviewUrl};

pub fn build_main(
    app: &tauri::App,
    mut config: WindowConfig,
    dark: bool,
) -> Result<tauri::WebviewWindow, Box<dyn std::error::Error>> {
    let navigation = defer_navigation(&mut config)?;
    let main = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?
        .background_color(crate::window_background::first_frame(dark))
        .build()?;
    if let Some(url) = navigation {
        navigate_release(&main, url)?;
    }
    Ok(main)
}

/// In release builds, starts the window at `about:blank`, which tauri-runtime-wry does not
/// navigate to, and returns the app page to navigate to once the keys are off.
fn defer_navigation(config: &mut WindowConfig) -> Result<Option<Url>, Box<dyn std::error::Error>> {
    if cfg!(debug_assertions) {
        return Ok(None);
    }
    let WebviewUrl::App(path) = &config.url else {
        return Err("the main window must load an app page".into());
    };
    // The page's origin, which the folio-file scheme also checks; a test keeps it Tauri's.
    let page = Url::parse(crate::file_scheme::origin())?;
    // Tauri's own rule: index.html is the origin itself.
    let destination = if path.to_str() == Some("index.html") {
        page
    } else {
        page.join(&path.to_string_lossy())?
    };
    config.url = WebviewUrl::External(Url::parse("about:blank")?);
    Ok(Some(destination))
}

/// Turns the browser accelerator keys off, then navigates natively, so both HRESULTs reach
/// startup (`WebviewWindow::navigate` reports only that the request was dispatched).
fn navigate_release(
    main: &tauri::WebviewWindow,
    url: Url,
) -> Result<(), Box<dyn std::error::Error>> {
    use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2Settings3;
    use windows_core::Interface;

    // The callback must be Send + 'static, so its result comes back through a channel.
    let (send, receive) = std::sync::mpsc::channel();
    main.with_webview(move |webview| {
        // SAFETY: with_webview runs on the controller's UI thread. The owned COM interfaces
        // stay in this callback, and the HSTRING outlives the synchronous Navigate call.
        let result = unsafe {
            (|| {
                let core = webview.controller().CoreWebView2()?;
                let settings: ICoreWebView2Settings3 = core.Settings()?.cast()?;
                settings.SetAreBrowserAcceleratorKeysEnabled(false)?;
                core.Navigate(&windows_core::HSTRING::from(url.as_str()))
            })()
        };
        // The receiver lives until this setup-only callback has run.
        let _ = send.send(result);
    })?;
    receive
        .recv()
        .map_err(|_| "the main webview dropped its accelerator key settings")??;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::utils::config::FrontendDist;

    #[test]
    fn defers_first_navigation_only_in_release_builds() {
        let config: tauri::Config =
            serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let mut main = config.app.windows[0].clone();
        // Where Tauri loads the page (`AppManager::get_app_url`): devUrl in dev, else the bundled
        // assets over http. The deferred navigation goes to file_scheme::origin(), the same page.
        assert!(!main.use_https_scheme);
        assert!(!matches!(
            config.build.frontend_dist,
            Some(FrontendDist::Url(_))
        ));
        let page = if tauri::is_dev() {
            config.build.dev_url.clone().unwrap()
        } else {
            Url::parse("http://tauri.localhost/").unwrap()
        };
        assert_eq!(Url::parse(crate::file_scheme::origin()).unwrap(), page);

        let original = main.url.clone();
        let destination = defer_navigation(&mut main).unwrap();
        if cfg!(debug_assertions) {
            assert_eq!((main.url, destination), (original, None));
        } else {
            assert_eq!(
                (main.url, destination),
                (
                    WebviewUrl::External(Url::parse("about:blank").unwrap()),
                    Some(page),
                )
            );
        }
    }
}
