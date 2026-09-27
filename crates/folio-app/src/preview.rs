//! The `folio-preview` URI scheme, which serves the preview frame (ADR-0001, security baseline).
//!
//! Previews render untrusted files. The main window shows them in
//! `<iframe sandbox="allow-scripts">`: the frame gets an opaque origin, so it cannot touch the
//! window, and Tauri rejects its IPC requests. This scheme gives the frame its own Content
//! Security Policy, which blocks fetch-class network requests, and lets it load its scripts
//! across that opaque origin. No CSP directive covers WebRTC, so the frame removes its
//! constructors before it handles a file (`apps/desktop/src/preview/frame.ts`). The scheme serves
//! only built files, never files from the library. The embedder must retain the strict sandbox:
//! Tauri considers this app-registered scheme local.

use std::borrow::Cow;

use tauri::http::header::{
    ACCESS_CONTROL_ALLOW_ORIGIN, CONTENT_SECURITY_POLICY, CONTENT_TYPE, X_CONTENT_TYPE_OPTIONS,
};
use tauri::http::{Request, Response, StatusCode};
use tauri::{AppHandle, Runtime};

/// Pages of this scheme load from `http://folio-preview.localhost/` on Windows.
pub const SCHEME: &str = "folio-preview";

/// The preview page, built from `apps/desktop/preview.html`.
const PAGE: &str = "/preview.html";

/// No `connect-src`, so fetch cannot reach IPC or the network. This does not restrict WebRTC.
/// Renderers write inline styles. The dev-server ancestor is added only under Tauri's dev cfg.
const CSP: &str = "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; \
    img-src 'self' blob: data:; font-src 'self' blob: data:; base-uri 'none'; \
    form-action 'none'; frame-ancestors http://tauri.localhost";

/// Answers a request for the preview page or one of the built scripts and styles it loads.
pub fn respond<R: Runtime>(
    app: &AppHandle<R>,
    request: &Request<Vec<u8>>,
) -> Response<Cow<'static, [u8]>> {
    let path = request.uri().path();
    if !allowed_path(path) {
        return status(StatusCode::NOT_FOUND);
    }
    let resolver = app.asset_resolver();
    // Embedded resolution otherwise falls back to the main index.html for missing assets.
    // In dev mode Tauri reads frontendDist directly and returns None for a missing file.
    #[cfg(not(dev))]
    if !resolver.iter().any(|(key, _)| key == path) {
        return status(StatusCode::NOT_FOUND);
    }
    let asset = resolver.get(path.to_owned());
    let Some(asset) = asset else {
        return status(StatusCode::NOT_FOUND);
    };
    asset_response(path, &asset.mime_type, asset.bytes)
}

fn asset_response(path: &str, mime_type: &str, bytes: Vec<u8>) -> Response<Cow<'static, [u8]>> {
    if path != PAGE && mime_type == "text/html" {
        return status(StatusCode::NOT_FOUND);
    }
    let mut response = response_builder().header(CONTENT_TYPE, mime_type);
    if path != PAGE {
        // Only static subresources need CORS from the frame's opaque origin; HTML does not.
        response = response.header(ACCESS_CONTROL_ALLOW_ORIGIN, "*");
    }
    response
        .body(Cow::Owned(bytes))
        .unwrap_or_else(|_| status(StatusCode::INTERNAL_SERVER_ERROR))
}

fn allowed_path(path: &str) -> bool {
    path == PAGE
        || path.strip_prefix("/assets/").is_some_and(|asset| {
            asset.split('/').all(|segment| {
                !segment.is_empty()
                    && segment != "."
                    && segment != ".."
                    && segment
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
            })
        })
}

fn status(code: StatusCode) -> Response<Cow<'static, [u8]>> {
    response_builder()
        .status(code)
        .body(Cow::Borrowed(&[][..]))
        .expect("static preview response headers are valid")
}

fn response_builder() -> tauri::http::response::Builder {
    let csp = if cfg!(dev) {
        format!("{CSP} http://localhost:5173")
    } else {
        CSP.to_owned()
    };
    Response::builder()
        .header(CONTENT_SECURITY_POLICY, csp)
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serves_html_only_for_the_preview_document_and_cors_only_for_assets() {
        let rejected = asset_response("/assets/main.html", "text/html", b"main shell".to_vec());
        assert_eq!(rejected.status(), StatusCode::NOT_FOUND);
        assert!(rejected.body().is_empty());
        let document = asset_response(PAGE, "text/html", Vec::new());
        assert_eq!(document.status(), StatusCode::OK);
        assert!(!document.headers().contains_key(ACCESS_CONTROL_ALLOW_ORIGIN));
        let script = asset_response("/assets/preview.js", "text/javascript", Vec::new());
        assert_eq!(script.status(), StatusCode::OK);
        assert_eq!(script.headers()[ACCESS_CONTROL_ALLOW_ORIGIN], "*");
    }

    #[test]
    fn errors_keep_the_preview_security_policy() {
        for code in [StatusCode::NOT_FOUND, StatusCode::INTERNAL_SERVER_ERROR] {
            let response = status(code);
            assert_eq!(response.status(), code);
            assert!(response.body().is_empty());
            let csp = response.headers()[CONTENT_SECURITY_POLICY]
                .to_str()
                .unwrap();
            assert!(csp.starts_with(CSP));
            assert_eq!(csp.contains("http://localhost:5173"), cfg!(dev));
            assert_eq!(response.headers()[X_CONTENT_TYPE_OPTIONS], "nosniff");
            assert!(!response.headers().contains_key(ACCESS_CONTROL_ALLOW_ORIGIN));
        }
    }

    #[test]
    fn accepts_only_preview_and_asset_paths_without_traversal() {
        for path in [
            PAGE,
            "/assets/preview-ab12.js",
            "/assets/fonts/example.woff2",
        ] {
            assert!(allowed_path(path), "{path}");
        }
        for path in [
            "/index.html",
            "/assets/",
            "/assets/../index.html",
            "/assets/./x.js",
            "/assets//x.js",
            "/assets/%2e%2e/index.html",
            "/assets/..\\index.html",
            "/assets/C:secret",
        ] {
            assert!(!allowed_path(path), "{path}");
        }
    }
}
