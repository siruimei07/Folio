//! Read-only catalogued file bytes. Every response, including failures, is inert and no-store.

use std::io::{Read, Seek, SeekFrom};

use tauri::http::header::{
    ACCEPT_RANGES, ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_EXPOSE_HEADERS, CACHE_CONTROL,
    CONTENT_LENGTH, CONTENT_RANGE, CONTENT_SECURITY_POLICY, CONTENT_TYPE, ORIGIN, RANGE,
    X_CONTENT_TYPE_OPTIONS,
};
use tauri::http::{Method, Request, Response, StatusCode};

use crate::error::AppError;
use crate::ipc::entries::FILE_ERROR_HEADER;
use crate::ipc::types::EntryRef;
use crate::library::{LibraryState, io_error};
use crate::open::PinnedEntry;
use crate::thumbnail::Cache;

pub(crate) const SCHEME: &str = "folio-file";
const CSP: &str = "sandbox; default-src 'none'";
// Tauri responses are buffered. Match the largest supported document preview and serve
// open-ended media ranges in small pieces instead of allocating the size of a whole video.
const MAX_DOCUMENT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_RANGE_BYTES: u64 = 8 * 1024 * 1024;

pub(crate) fn origin() -> &'static str {
    if cfg!(dev) {
        "http://localhost:5173"
    } else {
        "http://tauri.localhost"
    }
}

struct Route {
    entry: EntryRef,
    thumbnail: Option<u32>,
}

/// Returns a response plus its private diagnostic, which only the shell log receives.
pub(crate) fn respond(
    state: &LibraryState,
    cache: &Cache,
    request: &Request<Vec<u8>>,
) -> (Response<Vec<u8>>, Option<AppError>) {
    let result = if request.method() == Method::GET || request.method() == Method::HEAD {
        serve(state, cache, request).map_err(|error| (error_status(&error), error))
    } else {
        Err((
            StatusCode::METHOD_NOT_ALLOWED,
            invalid("only GET and HEAD are allowed"),
        ))
    };
    result.unwrap_or_else(|(status, error)| (failure(&error, status), Some(error)))
}

fn serve(
    state: &LibraryState,
    cache: &Cache,
    request: &Request<Vec<u8>>,
) -> Result<(Response<Vec<u8>>, Option<AppError>), AppError> {
    let route = validate(request)?;
    // Only the reference check and the pin hold the catalog writer; reading does not.
    let (entry, pinned) = state.with_entry(&route.entry, |root, entry| {
        Ok((entry.clone(), PinnedEntry::resolve(root, entry)?))
    })?;
    if let Some(size) = route.thumbnail {
        // A cache that cannot be written still serves the image; the log hears why.
        let (bytes, cache_error) = cache.thumbnail(&entry, &pinned, size)?;
        let (response, error) = bytes_response(
            std::io::Cursor::new(&bytes),
            bytes.len() as u64,
            "image/png",
            request,
        )?;
        Ok((response, error.or(cache_error)))
    } else {
        let file = pinned.read()?;
        let length = file.metadata().map_err(io_error)?.len();
        bytes_response(
            file,
            length,
            mime(&entry.record.path.extension().unwrap_or_default()),
            request,
        )
    }
}

fn validate(request: &Request<Vec<u8>>) -> Result<Route, AppError> {
    if request
        .headers()
        .get(ORIGIN)
        .is_some_and(|value| value != origin())
    {
        return Err(AppError::AccessDenied(
            "the scheme is for the main origin only".to_owned(),
        ));
    }
    if request.uri().query().is_some() {
        return Err(invalid("file URLs have no query"));
    }
    let mut parts = request
        .uri()
        .path()
        .strip_prefix('/')
        .ok_or_else(|| invalid("invalid route"))?
        .split('/');
    let route = parts.next().unwrap_or_default();
    // `with_entry` checks the id and the path text, as for any `EntryRef`.
    let id = parts.next().unwrap_or_default();
    let thumbnail = match route {
        "content" => None,
        "thumbnail" => Some(match parts.next() {
            Some("64") => 64,
            Some("128") => 128,
            Some("256") => 256,
            _ => return Err(invalid("invalid thumbnail size")),
        }),
        _ => return Err(invalid("unknown route")),
    };
    let names = parts.map(decode_name).collect::<Result<Vec<_>, _>>()?;
    Ok(Route {
        entry: EntryRef {
            id: id.to_owned(),
            path: names.join("/"),
        },
        thumbnail,
    })
}

fn decode_name(encoded: &str) -> Result<String, AppError> {
    let mut decoded = Vec::with_capacity(encoded.len());
    let mut bytes = encoded.as_bytes().iter().copied();
    while let Some(byte) = bytes.next() {
        if byte == b'%' {
            let high = bytes.next().and_then(|byte| (byte as char).to_digit(16));
            let low = bytes.next().and_then(|byte| (byte as char).to_digit(16));
            decoded.push(match (high, low) {
                (Some(high), Some(low)) => (high * 16 + low) as u8,
                _ => return Err(invalid("invalid percent encoding")),
            });
        } else {
            decoded.push(byte);
        }
    }
    let name = String::from_utf8(decoded).map_err(|_| invalid("path is not UTF-8"))?;
    // Never decode an encoded slash into another path segment (or decode a second time).
    if name.contains(['/', '\\']) {
        return Err(invalid("encoded path separator"));
    }
    Ok(name)
}

#[derive(Debug, PartialEq, Eq)]
enum RangeError {
    Malformed,
    Outside,
}

fn byte_range(value: &str, length: u64) -> Result<(u64, u64), RangeError> {
    let value = value.strip_prefix("bytes=").ok_or(RangeError::Malformed)?;
    let (start, end) = value.split_once('-').ok_or(RangeError::Malformed)?;
    let number = |text: &str| {
        if text.is_empty() || !text.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(RangeError::Malformed);
        }
        text.parse::<u64>().map_err(|_| RangeError::Malformed)
    };
    let (start, end) = if start.is_empty() {
        let suffix = number(end)?;
        if suffix == 0 || length == 0 {
            return Err(RangeError::Outside);
        }
        (length.saturating_sub(suffix), length - 1)
    } else {
        let start = number(start)?;
        let end = if end.is_empty() {
            length.saturating_sub(1)
        } else {
            number(end)?
        };
        if start >= length || start > end {
            return Err(RangeError::Outside);
        }
        (start, end.min(length - 1))
    };
    Ok((start, end.min(start.saturating_add(MAX_RANGE_BYTES - 1))))
}

fn bytes_response(
    mut reader: impl Read + Seek,
    length: u64,
    mime: &str,
    request: &Request<Vec<u8>>,
) -> Result<(Response<Vec<u8>>, Option<AppError>), AppError> {
    let mut response = headers()
        .header(CONTENT_TYPE, mime)
        .header(ACCEPT_RANGES, "bytes");
    let (start, count) = if let Some(value) = request.headers().get(RANGE) {
        match value
            .to_str()
            .map_err(|_| RangeError::Malformed)
            .and_then(|value| byte_range(value, length))
        {
            Ok((start, end)) => {
                response = response
                    .status(StatusCode::PARTIAL_CONTENT)
                    .header(CONTENT_RANGE, format!("bytes {start}-{end}/{length}"));
                (start, end - start + 1)
            }
            Err(RangeError::Malformed) => {
                let reason = invalid("invalid byte range");
                return Ok((failure(&reason, StatusCode::BAD_REQUEST), Some(reason)));
            }
            Err(RangeError::Outside) => {
                let reason = invalid("byte range outside the file");
                let mut response = failure(&reason, StatusCode::RANGE_NOT_SATISFIABLE);
                response.headers_mut().insert(
                    CONTENT_RANGE,
                    format!("bytes */{length}")
                        .parse()
                        .map_err(|_| AppError::Internal("invalid range header".to_owned()))?,
                );
                return Ok((response, Some(reason)));
            }
        }
    } else {
        if length > MAX_DOCUMENT_BYTES {
            return Err(invalid("use Range for files larger than 256 MiB"));
        }
        (0, length)
    };
    let mut bytes = Vec::new();
    if request.method() != Method::HEAD {
        bytes
            .try_reserve_exact(count as usize)
            .map_err(|error| AppError::FileSystem(format!("buffer file response: {error}")))?;
        reader.seek(SeekFrom::Start(start)).map_err(io_error)?;
        reader
            .take(count)
            .read_to_end(&mut bytes)
            .map_err(io_error)?;
        if bytes.len() as u64 != count {
            return Err(AppError::FileSystem(
                "the file changed while reading".to_owned(),
            ));
        }
    }
    let response = response
        .header(CONTENT_LENGTH, count)
        .body(bytes)
        .map_err(|error| AppError::Internal(format!("build file response: {error}")))?;
    Ok((response, None))
}

fn headers() -> tauri::http::response::Builder {
    Response::builder()
        .header(CONTENT_SECURITY_POLICY, CSP)
        .header(X_CONTENT_TYPE_OPTIONS, "nosniff")
        .header(CACHE_CONTROL, "no-store")
        .header(ACCESS_CONTROL_ALLOW_ORIGIN, origin())
        .header(
            ACCESS_CONTROL_EXPOSE_HEADERS,
            format!("{FILE_ERROR_HEADER}, Content-Range, Accept-Ranges"),
        )
}

fn error_code(error: &AppError) -> &'static str {
    match error {
        AppError::InvalidArgument(_) => "InvalidArgument",
        AppError::NotFound(_) => "NotFound",
        AppError::NoLibrary(_) => "NoLibrary",
        AppError::AccessDenied(_) => "AccessDenied",
        AppError::InUse(_) => "InUse",
        AppError::NotLocal(_) => "NotLocal",
        AppError::NoThumbnail(_) => "NoThumbnail",
        AppError::FileSystem(_) => "FileSystem",
        _ => "Internal",
    }
}

fn error_status(error: &AppError) -> StatusCode {
    match error {
        AppError::InvalidArgument(_) => StatusCode::BAD_REQUEST,
        AppError::NotFound(_) | AppError::NoThumbnail(_) => StatusCode::NOT_FOUND,
        AppError::NoLibrary(_) => StatusCode::SERVICE_UNAVAILABLE,
        AppError::AccessDenied(_) => StatusCode::FORBIDDEN,
        AppError::InUse(_) | AppError::NotLocal(_) => StatusCode::CONFLICT,
        _ => StatusCode::INTERNAL_SERVER_ERROR,
    }
}

pub(crate) fn failure(error: &AppError, status: StatusCode) -> Response<Vec<u8>> {
    let mut response = headers()
        .status(status)
        .header(FILE_ERROR_HEADER, error_code(error))
        .header(CONTENT_LENGTH, 0);
    if status == StatusCode::METHOD_NOT_ALLOWED {
        response = response.header("Allow", "GET, HEAD");
    }
    response
        .body(Vec::new())
        .expect("static file response headers are valid")
}

fn invalid(detail: &str) -> AppError {
    AppError::InvalidArgument(detail.to_owned())
}

fn mime(extension: &str) -> &'static str {
    match extension {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "svg" => "image/svg+xml",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" | "oga" => "audio/ogg",
        "flac" => "audio/flac",
        "m4a" => "audio/mp4",
        "aac" => "audio/aac",
        "mp4" | "m4v" => "video/mp4",
        "webm" => "video/webm",
        "ogv" => "video/ogg",
        "mov" => "video/quicktime",
        "pdf" => "application/pdf",
        "txt" | "csv" | "log" | "md" | "markdown" | "rs" | "py" | "js" | "ts" | "tsx" | "json"
        | "html" | "htm" | "xml" | "css" | "bat" | "ps1" => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests;
