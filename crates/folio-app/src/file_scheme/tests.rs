use std::io::Cursor;
use std::sync::Arc;

use super::*;

fn request(path: &str) -> Request<Vec<u8>> {
    Request::builder()
        .uri(format!("http://folio-file.localhost{path}"))
        .header(ORIGIN, origin())
        .body(Vec::new())
        .unwrap()
}

#[test]
fn routes_decode_each_name_once_and_reject_ambiguous_or_escaping_paths() {
    let route = validate(&request("/content/42/%E7%AC%94%E8%AE%B0/a%20%23%25.txt")).unwrap();
    assert_eq!(
        route.entry,
        EntryRef {
            id: "42".into(),
            path: "笔记/a #%.txt".into()
        }
    );
    assert_eq!(route.thumbnail, None);
    assert_eq!(
        validate(&request("/thumbnail/42/128/a%252F.txt"))
            .unwrap()
            .entry
            .path,
        "a%2F.txt"
    );
    // Checked before the library is consulted: a URL the UI never builds is InvalidArgument,
    // whether the route (here) or the reference (`with_entry`) is wrong.
    let dir = tempfile::tempdir().unwrap();
    let state = LibraryState::new(Ok(dir.path().to_path_buf()), Arc::new(|_| {}));
    state.initialize();
    let cache = Cache::new(Err(AppError::Internal("unused".into())));
    for path in [
        "/content/0/a",
        "/content//a",
        "/content/+1/a",
        "/content/-1/a",
        "/content/9223372036854775808/a",
        "/content/1/",
        "/content/1/a//b",
        "/content/1/../secret",
        "/content/1/%2e%2e/secret",
        "/content/1/a%2Fb",
        "/content/1/a%5Cb",
        "/content/1/C%3A/file",
        "/content/1/a%00b",
        "/content/1/%FF",
        "/content/1/%",
        "/content/1/%G0",
        "/content/1/a?other=1",
        "/thumbnail/1/32/a",
        "/thumbnail/1/064/a",
        "/unknown/1/a",
    ] {
        let (response, error) = respond(&state, &cache, &request(path));
        assert!(
            matches!(error, Some(AppError::InvalidArgument(_))),
            "{path}: {error:?}"
        );
        assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{path}");
    }
    let mut untrusted = request("/content/1/a");
    untrusted
        .headers_mut()
        .insert(ORIGIN, "null".parse().unwrap());
    assert!(matches!(
        validate(&untrusted),
        Err(AppError::AccessDenied(_))
    ));
    // The method is checked first, whatever else the request holds.
    *untrusted.method_mut() = Method::POST;
    let (response, error) = respond(&state, &cache, &untrusted);
    assert!(matches!(error, Some(AppError::InvalidArgument(_))));
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    state.shutdown().unwrap();
}

#[test]
fn ranges_cover_closed_open_suffix_empty_and_large_files_without_overflow() {
    for (range, expected) in [
        ("bytes=0-0", (0, 0)),
        ("bytes=2-4", (2, 4)),
        ("bytes=2-", (2, 9)),
        ("bytes=-3", (7, 9)),
        ("bytes=-30", (0, 9)),
        ("bytes=2-99", (2, 9)),
    ] {
        assert_eq!(byte_range(range, 10), Ok(expected), "{range}");
    }
    for range in ["bytes=10-", "bytes=4-2", "bytes=-0"] {
        assert_eq!(byte_range(range, 10), Err(RangeError::Outside));
    }
    for range in ["bytes=0-", "bytes=-1"] {
        assert_eq!(byte_range(range, 0), Err(RangeError::Outside));
    }
    for range in [
        "items=0-1",
        "bytes=",
        "bytes=-",
        "bytes=0-1,3-4",
        "bytes=+1-2",
        "bytes=0-18446744073709551616",
    ] {
        assert_eq!(byte_range(range, 10), Err(RangeError::Malformed), "{range}");
    }
    assert_eq!(
        byte_range("bytes=0-", u64::MAX),
        Ok((0, MAX_RANGE_BYTES - 1))
    );
    assert_eq!(
        byte_range(&format!("bytes={}-", u64::MAX - 2), u64::MAX),
        Ok((u64::MAX - 2, u64::MAX - 1))
    );
}

fn inert(response: &Response<Vec<u8>>) {
    assert_eq!(response.headers()[CONTENT_SECURITY_POLICY], CSP);
    assert_eq!(response.headers()[X_CONTENT_TYPE_OPTIONS], "nosniff");
    assert_eq!(response.headers()[CACHE_CONTROL], "no-store");
    assert_eq!(response.headers()[ACCESS_CONTROL_ALLOW_ORIGIN], origin());
    assert_eq!(
        response.headers()[ACCESS_CONTROL_EXPOSE_HEADERS],
        "X-Folio-Error, Content-Range, Accept-Ranges"
    );
}

#[test]
fn content_and_head_have_inert_headers_ranges_and_empty_error_bodies() {
    let mut req = request("/content/1/a.txt");
    let (whole, error) =
        bytes_response(Cursor::new(b"0123456789"), 10, "text/plain", &req).unwrap();
    assert!(error.is_none());
    assert_eq!(whole.status(), StatusCode::OK);
    assert_eq!(whole.body(), b"0123456789");
    inert(&whole);
    req.headers_mut()
        .insert(RANGE, "bytes=2-4".parse().unwrap());
    let (partial, _) = bytes_response(Cursor::new(b"0123456789"), 10, "text/plain", &req).unwrap();
    assert_eq!(partial.status(), StatusCode::PARTIAL_CONTENT);
    assert_eq!(partial.headers()[CONTENT_RANGE], "bytes 2-4/10");
    assert_eq!(partial.headers()[CONTENT_LENGTH], "3");
    assert_eq!(partial.body(), b"234");
    inert(&partial);
    *req.method_mut() = Method::HEAD;
    let (head, _) = bytes_response(Cursor::new([]), 10, "text/plain", &req).unwrap();
    assert_eq!(head.status(), partial.status());
    assert_eq!(head.headers(), partial.headers());
    assert!(head.body().is_empty());
    for (range, status) in [("bytes=10-", 416), ("bytes=0-1,2-3", 400)] {
        req.headers_mut().insert(RANGE, range.parse().unwrap());
        let (failed, error) = bytes_response(Cursor::new([]), 10, "text/plain", &req).unwrap();
        assert_eq!(failed.status().as_u16(), status);
        assert!(matches!(error, Some(AppError::InvalidArgument(_))));
        assert!(failed.body().is_empty());
        assert_eq!(failed.headers()[FILE_ERROR_HEADER], "InvalidArgument");
        if status == 416 {
            assert_eq!(failed.headers()[CONTENT_RANGE], "bytes */10");
        }
        inert(&failed);
    }
    *req.method_mut() = Method::GET;
    req.headers_mut().remove(RANGE);
    assert!(matches!(
        bytes_response(Cursor::new([]), MAX_DOCUMENT_BYTES + 1, "video/mp4", &req),
        Err(AppError::InvalidArgument(_))
    ));
    assert!(matches!(
        bytes_response(Cursor::new(b"short"), 10, "text/plain", &req),
        Err(AppError::FileSystem(_))
    ));
}

#[test]
fn every_landed_contract_failure_has_its_status_and_no_private_detail() {
    let cases = [
        (AppError::InvalidArgument("secret".into()), 400),
        (AppError::NoLibrary("secret".into()), 503),
        (AppError::NotFound("secret".into()), 404),
        (AppError::AccessDenied("secret".into()), 403),
        (AppError::InUse("secret".into()), 409),
        (AppError::NotLocal("secret".into()), 409),
        (AppError::NoThumbnail("secret".into()), 404),
        (AppError::FileSystem("secret".into()), 500),
        (AppError::Internal("secret".into()), 500),
        (AppError::Pruned("secret".into()), 404),
        (AppError::HistoryDamaged("secret".into()), 500),
    ];
    let codes = cases
        .iter()
        .map(|(error, status)| {
            let response = failure(error, error_status(error));
            assert_eq!(response.status().as_u16(), *status);
            inert(&response);
            assert!(response.body().is_empty());
            assert!(!format!("{:?}", response.headers()).contains("secret"));
            error_code(error)
        })
        .collect::<Vec<_>>();
    assert_eq!(codes, crate::ipc::entries::FILE_ERROR_CODES);
    let dir = tempfile::tempdir().unwrap();
    let state = LibraryState::new(Ok(dir.path().to_path_buf()), Arc::new(|_| {}));
    state.initialize();
    let cache = Cache::new(Err(AppError::Internal("unused".into())));
    let (response, _) = respond(&state, &cache, &request("/content/1/a"));
    assert_eq!(response.headers()[FILE_ERROR_HEADER], "NoLibrary");
    let mut req = request("/content/1/a");
    *req.method_mut() = Method::DELETE;
    let (response, _) = respond(&state, &cache, &req);
    assert_eq!(response.status(), StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(response.headers()["Allow"], "GET, HEAD");
    state.shutdown().unwrap();
}
