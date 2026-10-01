//! Registers the tokenizer with SQLite's FTS5 through its C API (`fts5_api`); rusqlite has no
//! tokenizer API of its own. Invalid UTF-8 in stored text is skipped, not fatal, and a panic in
//! the tokenizer becomes an SQLite error instead of unwinding into C.

#![allow(
    unsafe_code,
    reason = "SQLite's FTS5 C API; each unsafe block states why it is sound"
)]

use std::ffi::{CStr, c_char, c_int, c_void};
use std::ops::ControlFlow;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr::null_mut;

use rusqlite::{Connection, ffi, types::ToSqlOutput};

use super::tokenizer::{Mode, tokenize};

#[cfg(not(panic = "unwind"))]
compile_error!("folio_cjk requires panic = \"unwind\" to report tokenizer panics as SQLite errors");

const NAME: &CStr = c"folio_cjk";

/// The tokenizer's name in `CREATE VIRTUAL TABLE … USING fts5(…, tokenize = 'folio_cjk')`.
pub const TOKENIZER_NAME: &str = match NAME.to_str() {
    Ok(name) => name,
    Err(_) => panic!("the tokenizer name must be UTF-8"),
};

type TokenCallback = unsafe extern "C" fn(
    ctx: *mut c_void,
    flags: c_int,
    token: *const c_char,
    token_len: c_int,
    start: c_int,
    end: c_int,
) -> c_int;

/// Makes `folio_cjk` available on `conn`. Call this before reading, writing or running health
/// checks (`PRAGMA quick_check` / `integrity_check`) on an FTS5 table using it.
///
/// Any failed FTS5 write must roll back its transaction or its per-write savepoint: a tokenizer
/// error can leave a partial row inside an otherwise committable transaction.
pub fn register_tokenizer(conn: &Connection) -> rusqlite::Result<()> {
    let api = fts5_api(conn)?;
    // SAFETY: `api` is valid while `conn` is borrowed, and FTS5 copies the tokenizer struct
    // during the call.
    unsafe {
        let Some(create_tokenizer) = (*api).xCreateTokenizer else {
            return Err(error(ffi::SQLITE_ERROR, "fts5_api has no xCreateTokenizer"));
        };
        let mut tokenizer = ffi::fts5_tokenizer {
            xCreate: Some(create),
            xDelete: Some(delete),
            xTokenize: Some(tokenize_callback),
        };
        let rc = create_tokenizer(api, NAME.as_ptr(), null_mut(), &mut tokenizer, None);
        if rc != ffi::SQLITE_OK {
            return Err(error(rc, "could not register FTS5 tokenizer"));
        }
        Ok(())
    }
}

/// The FTS5 API of `conn`, obtained with `SELECT fts5(?1)` and valid until `conn` closes.
pub(crate) fn fts5_api(conn: &Connection) -> rusqlite::Result<*mut ffi::fts5_api> {
    let mut api: *mut ffi::fts5_api = null_mut();
    // SAFETY: SQLite writes the API pointer into `api` during this synchronous query; `api`
    // outlives the statement, the pointer type is static, and no destructor owns the stack value.
    let pointer = ToSqlOutput::Pointer(((&raw mut api).cast_const().cast(), c"fts5_api_ptr", None));
    conn.query_row("SELECT fts5(?1)", [pointer], |_| Ok(()))?;
    if api.is_null() {
        return Err(error(ffi::SQLITE_ERROR, "SQLite was built without FTS5"));
    }
    Ok(api)
}

/// FTS5 wants an instance per table; the tokenizer has no state and takes no options.
unsafe extern "C" fn create(
    _user_data: *mut c_void,
    _args: *mut *const c_char,
    arg_count: c_int,
    out: *mut *mut ffi::Fts5Tokenizer,
) -> c_int {
    static INSTANCE: u8 = 0;
    if arg_count != 0 {
        return ffi::SQLITE_ERROR;
    }
    // SAFETY: FTS5 passes a valid out-pointer. The instance is only handed back to us, never
    // dereferenced.
    unsafe { *out = (&raw const INSTANCE).cast_mut().cast() };
    ffi::SQLITE_OK
}

unsafe extern "C" fn delete(_tokenizer: *mut ffi::Fts5Tokenizer) {}

unsafe extern "C" fn tokenize_callback(
    _tokenizer: *mut ffi::Fts5Tokenizer,
    ctx: *mut c_void,
    flags: c_int,
    text: *const c_char,
    text_len: c_int,
    token_callback: Option<TokenCallback>,
) -> c_int {
    let Some(token_callback) = token_callback else {
        return ffi::SQLITE_ERROR;
    };
    let bytes: &[u8] = match usize::try_from(text_len) {
        // SAFETY: FTS5 passes `text_len` readable bytes that stay valid during this call.
        Ok(len) if len > 0 && !text.is_null() => unsafe {
            std::slice::from_raw_parts(text.cast(), len)
        },
        _ => &[],
    };
    // Auxiliary functions (`highlight()`, `snippet()`) read the stored text again.
    let mode = if flags & ffi::FTS5_TOKENIZE_QUERY != 0 {
        Mode::Query
    } else if flags & ffi::FTS5_TOKENIZE_AUX != 0 {
        Mode::Highlight
    } else {
        Mode::Document
    };
    catch_unwind(AssertUnwindSafe(|| {
        emit_tokens(bytes, mode, |flags, token, token_len, start, end| {
            // SAFETY: `emit_tokens` checked lengths and offsets; FTS5 copies the token before
            // returning.
            unsafe { token_callback(ctx, flags, token.as_ptr().cast(), token_len, start, end) }
        })
    }))
    .unwrap_or(ffi::SQLITE_ERROR)
}

/// Tokenizes the valid UTF-8 parts of `bytes`, with offsets into `bytes`, and passes each token
/// to `token_callback` until it returns an error code or `SQLITE_DONE` (successful early stop).
fn emit_tokens(
    bytes: &[u8],
    mode: Mode,
    mut token_callback: impl FnMut(c_int, &str, c_int, c_int, c_int) -> c_int,
) -> c_int {
    let mut rc = ffi::SQLITE_OK;
    let mut offset = 0;
    for chunk in bytes.utf8_chunks() {
        let valid = chunk.valid();
        let flow = tokenize(valid, mode, &mut |token| {
            let flags = if token.colocated {
                ffi::FTS5_TOKEN_COLOCATED
            } else {
                0
            };
            let (Ok(len), Ok(start), Ok(end)) = (
                c_int::try_from(token.text.len()),
                c_int::try_from(offset + token.start),
                c_int::try_from(offset + token.end),
            ) else {
                rc = ffi::SQLITE_TOOBIG;
                return ControlFlow::Break(());
            };
            rc = token_callback(flags, &token.text, len, start, end);
            if rc == ffi::SQLITE_OK {
                ControlFlow::Continue(())
            } else {
                ControlFlow::Break(())
            }
        });
        if flow.is_break() {
            break;
        }
        offset += valid.len() + chunk.invalid().len();
    }
    rc
}

fn error(rc: c_int, message: &str) -> rusqlite::Error {
    rusqlite::Error::SqliteFailure(ffi::Error::new(rc), Some(message.to_owned()))
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn collect(bytes: &[u8], mode: Mode) -> Vec<(String, c_int, c_int, c_int)> {
        let mut out = Vec::new();
        let rc = emit_tokens(bytes, mode, |flags, token, len, start, end| {
            assert_eq!(usize::try_from(len).unwrap(), token.len());
            out.push((token.to_owned(), flags, start, end));
            ffi::SQLITE_OK
        });
        assert_eq!(rc, ffi::SQLITE_OK);
        out
    }

    #[test]
    fn skips_invalid_utf8_and_keeps_offsets_into_the_bytes() {
        // "线" 0xFF "代": the invalid byte splits the run, and "代" starts at byte 4.
        let bytes = [0xE7, 0xBA, 0xBF, 0xFF, 0xE4, 0xBB, 0xA3];
        assert_eq!(
            collect(&bytes, Mode::Document),
            [("线".to_owned(), 0, 0, 3), ("代".to_owned(), 0, 4, 7)]
        );
    }

    #[test]
    fn marks_pairs_as_colocated() {
        let flags: Vec<_> = collect("线性".as_bytes(), Mode::Document)
            .into_iter()
            .map(|token| token.1)
            .collect();
        assert_eq!(flags, [0, ffi::FTS5_TOKEN_COLOCATED, 0]);
    }

    #[test]
    fn stops_at_the_first_error_from_fts5_across_invalid_utf8() {
        let mut calls = 0;
        let rc = emit_tokens(b"alpha beta\xffgamma", Mode::Document, |_, _, _, _, _| {
            calls += 1;
            ffi::SQLITE_NOMEM
        });
        assert_eq!((rc, calls), (ffi::SQLITE_NOMEM, 1));
    }

    #[test]
    fn done_propagates_and_stops_across_invalid_utf8() {
        let mut calls = 0;
        let rc = emit_tokens(b"alpha beta\xffgamma", Mode::Document, |_, _, _, _, _| {
            calls += 1;
            ffi::SQLITE_DONE
        });
        assert_eq!((rc, calls), (ffi::SQLITE_DONE, 1));
    }

    /// Valid UTF-8 with stray bytes in between.
    fn mostly_utf8() -> impl Strategy<Value = Vec<u8>> {
        let part = prop_oneof![
            prop::collection::vec(any::<char>(), 0..24)
                .prop_map(|chars| String::from_iter(chars).into_bytes()),
            prop::sample::select(vec![
                "线代",
                "ー",
                "カ\u{3099}",
                "한",
                "\u{F900}",
                "⼤",
                "Ａ",
                "İ",
                "\u{301}",
                "\u{200D}",
                "\u{200B}",
                "\u{AD}",
                "\u{E0100}",
                "\0",
            ])
            .prop_map(|text| text.as_bytes().to_vec()),
            prop::collection::vec(any::<u8>(), 1..4),
        ];
        prop::collection::vec(part, 0..8).prop_map(|parts| parts.concat())
    }

    proptest! {
        /// FTS5 reads the text at these offsets, so they must stay inside it.
        #[test]
        fn offsets_are_utf8_ranges_of_the_bytes(
            bytes in mostly_utf8(),
            mode in prop::sample::select(vec![Mode::Document, Mode::Highlight, Mode::Query]),
        ) {
            for (token, _, start, end) in collect(&bytes, mode) {
                let (start, end) = (usize::try_from(start).unwrap(), usize::try_from(end).unwrap());
                prop_assert!(start < end && end <= bytes.len());
                prop_assert!(std::str::from_utf8(&bytes[start..end]).is_ok());
                prop_assert!(!token.is_empty());
            }
        }
    }
}
