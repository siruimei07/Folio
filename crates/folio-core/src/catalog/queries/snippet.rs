//! A 16-token body excerpt from FTS5's indexed phrase positions.
//!
//! Native snippet() scores a window around every occurrence. Frequent CJK terms make that
//! quadratic. We use the first body match, the existing tokenizer's source offsets, and the
//! existing span parser. Matching and phrase/prefix semantics still belong to FTS5.

#![allow(
    unsafe_code,
    reason = "SQLite's FTS5 callback; unsafe blocks document the C lifetimes"
)]

use std::ffi::c_int;
use std::ops::ControlFlow;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr::{null, null_mut};

use rusqlite::{Connection, ffi};

use crate::catalog::MAX_BODY_BYTES;
use crate::catalog::fulltext::{CLOSE, OPEN};
use crate::search::{Mode, tokenize};

const TOKENS: usize = 16;
const BODY: c_int = 3;

/// Makes `folio_snippet16` available on `conn`. Call it once per connection: FTS5 appends
/// registrations rather than replacing them.
pub(in crate::catalog) fn register(conn: &Connection) -> rusqlite::Result<()> {
    let api = crate::search::fts5_api(conn)?;
    // SAFETY: the existing getter returns this connection's API. The borrow keeps it alive;
    // FTS5 copies the static function name and stores the callback, with no owned user data.
    let rc = unsafe {
        let create = (*api).xCreateFunction.ok_or_else(|| {
            rusqlite::Error::SqliteFailure(ffi::Error::new(ffi::SQLITE_ERROR), None)
        })?;
        create(
            api,
            c"folio_snippet16".as_ptr(),
            null_mut(),
            Some(callback),
            None,
        )
    };
    if rc == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(rusqlite::Error::SqliteFailure(ffi::Error::new(rc), None))
    }
}

unsafe extern "C" fn callback(
    api: *const ffi::Fts5ExtensionApi,
    fts: *mut ffi::Fts5Context,
    ctx: *mut ffi::sqlite3_context,
    argc: c_int,
    _args: *mut *mut ffi::sqlite3_value,
) {
    // SAFETY: SQLite invokes the registered ABI with live contexts and its own extension API.
    // No reference/pointer escapes this call. Catch every Rust panic before returning to C.
    let result = catch_unwind(AssertUnwindSafe(|| unsafe {
        if argc != 0 {
            return Err(ffi::SQLITE_MISUSE);
        }
        extract(&*api, fts)
    }))
    .unwrap_or(Err(ffi::SQLITE_ERROR));
    // SAFETY: ctx is SQLite's live result context. TRANSIENT copies the UTF-8 bytes before
    // their String is dropped; explicit length handles the full string without a C-string read.
    unsafe {
        match result {
            Ok(Some(marked)) => match c_int::try_from(marked.len()) {
                Ok(len) => ffi::sqlite3_result_text(
                    ctx,
                    marked.as_ptr().cast(),
                    len,
                    ffi::SQLITE_TRANSIENT(),
                ),
                Err(_) => ffi::sqlite3_result_error_code(ctx, ffi::SQLITE_TOOBIG),
            },
            Ok(None) => ffi::sqlite3_result_null(ctx),
            Err(rc) => ffi::sqlite3_result_error_code(ctx, rc),
        }
    }
}

/// The API and context must belong to the currently executing FTS5 callback.
unsafe fn extract(
    api: &ffi::Fts5ExtensionApi,
    fts: *mut ffi::Fts5Context,
) -> Result<Option<String>, c_int> {
    let count = api.xInstCount.ok_or(ffi::SQLITE_ERROR)?;
    let instance = api.xInst.ok_or(ffi::SQLITE_ERROR)?;
    let size = api.xPhraseSize.ok_or(ffi::SQLITE_ERROR)?;
    let column = api.xColumnText.ok_or(ffi::SQLITE_ERROR)?;
    let mut n = 0;
    // SAFETY: the caller supplies FTS5's live context; each out-pointer targets an initialized
    // local of the exact C type. API errors are checked before consuming their outputs.
    unsafe {
        check(count(fts, &mut n))?;
        if n < 0 {
            return Err(ffi::SQLITE_CORRUPT);
        }
        let mut matches = Vec::new();
        for i in 0..n {
            let (mut phrase, mut col, mut offset) = (0, 0, 0);
            check(instance(fts, i, &mut phrase, &mut col, &mut offset))?;
            if col != BODY {
                continue;
            }
            let offset = usize::try_from(offset).map_err(|_| ffi::SQLITE_CORRUPT)?;
            // FTS5 instances are ordered by column/position. Only positions that can enter
            // the first match's 16-token window are needed, including overlapping phrases.
            if matches
                .first()
                .is_some_and(|&(first, _)| offset >= first + TOKENS)
            {
                break;
            }
            let len = usize::try_from(size(fts, phrase)).map_err(|_| ffi::SQLITE_CORRUPT)?;
            if len == 0 {
                return Err(ffi::SQLITE_CORRUPT);
            }
            matches.push((offset, len));
        }
        if matches.is_empty() {
            return Ok(None);
        }
        let (mut ptr, mut len) = (null(), 0);
        check(column(fts, BODY, &mut ptr, &mut len))?;
        let len = usize::try_from(len).map_err(|_| ffi::SQLITE_CORRUPT)?;
        if len > MAX_BODY_BYTES {
            return Err(ffi::SQLITE_TOOBIG);
        }
        if len == 0 || ptr.is_null() {
            return Err(ffi::SQLITE_CORRUPT);
        }
        // SAFETY: successful xColumnText supplies exactly len readable bytes, owned by SQLite
        // for this row. No SQLite call mutates the text while this borrowed slice is used.
        let bytes = std::slice::from_raw_parts(ptr.cast::<u8>(), len);
        // NUL and the markers are ASCII, so a byte scan finds them without decoding 1 MiB.
        if bytes
            .iter()
            .any(|&byte| [0, OPEN as u8, CLOSE as u8].contains(&byte))
        {
            return Err(ffi::SQLITE_CORRUPT);
        }
        let text = std::str::from_utf8(bytes).map_err(|_| ffi::SQLITE_CORRUPT)?;
        marked(text, &matches).map(Some)
    }
}

fn check(rc: c_int) -> Result<(), c_int> {
    if rc == ffi::SQLITE_OK {
        Ok(())
    } else {
        Err(rc)
    }
}

fn marked(text: &str, matches: &[(usize, usize)]) -> Result<String, c_int> {
    let (first, len) = matches[0];
    let start = first.saturating_sub((TOKENS - len.min(TOKENS)) / 2);
    let mut position = 0;
    let mut offsets = Vec::with_capacity(TOKENS);
    let flow = tokenize(text, Mode::Highlight, &mut |token| {
        if position >= start {
            if offsets.len() == TOKENS {
                return ControlFlow::Break(());
            }
            offsets.push((token.start, token.end));
        }
        position += 1;
        ControlFlow::Continue(())
    });
    let end = start + offsets.len();
    if first >= end {
        return Err(ffi::SQLITE_CORRUPT);
    }
    let from = if start == 0 { 0 } else { offsets[0].0 };
    let to = if flow.is_break() {
        offsets.last().unwrap().1
    } else {
        text.len()
    };
    let mut ranges = Vec::new();
    for &(offset, len) in matches {
        let last = offset.checked_add(len).ok_or(ffi::SQLITE_CORRUPT)?.min(end);
        if offset < end && last > start {
            ranges.push((
                offsets[offset.max(start) - start].0,
                offsets[last - start - 1].1,
            ));
        }
    }
    // NFKC expansions can share source bytes, and query phrases can overlap. Merge source
    // ranges without marking punctuation between separate, nonoverlapping query clauses.
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = Vec::new();
    for (a, b) in ranges {
        if let Some(last) = merged.last_mut().filter(|last| a <= last.1) {
            last.1 = last.1.max(b);
        } else {
            merged.push((a, b));
        }
    }
    let mut output = String::new();
    if from > 0 {
        output.push('…');
    }
    let mut cursor = from;
    for (a, b) in merged {
        output.push_str(&text[cursor..a]);
        output.push(OPEN);
        output.push_str(&text[a..b]);
        output.push(CLOSE);
        cursor = b;
    }
    output.push_str(&text[cursor..to]);
    if to < text.len() {
        output.push('…');
    }
    Ok(output)
}
