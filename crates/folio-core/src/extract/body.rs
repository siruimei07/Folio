//! Search bodies (ADR-0002 §5): the text full-text search keeps for a text or Word file, made
//! from what [`decode_prefix`] and [`read_word`] give.
//!
//! 1. A generated file, known by its name (a `.min` stem or a lockfile), is skipped unread.
//! 2. Text is decoded by the preview's rule; binary content behind a text extension has no body.
//! 3. Runs of base64 (images embedded in notebooks, Markdown, HTML or mail) are dropped.
//! 4. Word paragraphs that still have text are joined by a blank line, so the tokenizer, which
//!    pairs CJK characters across one line break, pairs none across two paragraphs; a line break
//!    inside a paragraph stays one line break.
//! 5. The body is cut to [`MAX_BODY_BYTES`] at a character boundary. A body of nothing but white
//!    space and control characters is no body.

use std::borrow::Cow;
use std::io::{Read, Seek};

use super::{Control, Decoded, WordError, WordLimits, decode, decode_prefix, read_word};
use crate::catalog::MAX_BODY_BYTES;

/// Lockfiles, which package managers write: matched by whole name, ignoring ASCII case.
const LOCKFILES: &[&str] = &[
    "bun.lock",
    "Cargo.lock",
    "composer.lock",
    "deno.lock",
    "flake.lock",
    "Gemfile.lock",
    "go.sum",
    "npm-shrinkwrap.json",
    "package-lock.json",
    "packages.lock.json",
    "Pipfile.lock",
    "pnpm-lock.yaml",
    "Podfile.lock",
    "poetry.lock",
    "pubspec.lock",
    "uv.lock",
    "yarn.lock",
];

/// Base64 characters a run needs before it is dropped.
const MIN_RUN: usize = 256;

/// Base64 characters a line of a run needs for the run to go on to the next line. Encoders wrap
/// base64 at 64 (PEM) or 76 (MIME, Python's `encodebytes`) characters, while a list of short codes,
/// one per line, must stay.
const MIN_LINE: usize = 60;

/// What full-text search keeps for a file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Body {
    /// The text to index: at most [`MAX_BODY_BYTES`], never only white space.
    Text(String),
    /// No text: an empty file or document, white space only, or only base64.
    Empty,
    /// Binary content behind a text extension (a NUL in the first 8 KiB and no byte order mark).
    Binary,
    /// A generated file ([`is_generated`]), not read.
    Skipped,
}

/// Whether the file named `name` (its last path segment) is generated, so search skips it: its
/// stem ends in `.min` (`jquery.min.js`), or it is a lockfile (`package-lock.json`). ASCII case is
/// ignored. [`text_body`] checks it too; checking first saves reading such a file.
pub fn is_generated(name: &str) -> bool {
    let stem = name.rsplit_once('.').map_or(name, |(stem, _)| stem);
    let min_stem = stem
        .len()
        .checked_sub(".min".len())
        .is_some_and(|at| stem.as_bytes()[at..].eq_ignore_ascii_case(b".min"));
    min_stem
        || LOCKFILES
            .iter()
            .any(|lockfile| lockfile.eq_ignore_ascii_case(name))
}

/// The body of the text file named `name` (its last path segment): `prefix` is the whole file
/// when `complete`, else its first bytes, of which [`READ_LIMIT`](super::READ_LIMIT) are enough.
/// A character the end of an incomplete prefix cuts is dropped.
pub fn text_body(name: &str, prefix: &[u8], complete: bool) -> Body {
    if is_generated(name) {
        return Body::Skipped;
    }
    let decoded = if complete {
        decode(prefix)
    } else {
        decode_prefix(prefix)
    };
    match decoded {
        Decoded::Text(file) => body_of(without_base64_runs(&file.text).into_owned()),
        Decoded::Binary => Body::Binary,
    }
}

/// The body of the Word document `reader` holds, read until the body is full: [`Body::Text`] or
/// [`Body::Empty`], or why the document gave no text.
pub fn word_body(reader: impl Read + Seek, control: &Control<'_>) -> Result<Body, WordError> {
    let word = read_word(reader, &WordLimits::with_max_text(MAX_BODY_BYTES), control)?;
    let paragraphs = word
        .paragraphs
        .iter()
        .map(|paragraph| without_base64_runs(paragraph))
        .filter(|paragraph| has_text(paragraph))
        .collect::<Vec<_>>();
    Ok(body_of(paragraphs.join("\n\n")))
}

/// `text` cut to [`MAX_BODY_BYTES`], holding no more memory than that.
fn body_of(mut text: String) -> Body {
    text.truncate(text.floor_char_boundary(MAX_BODY_BYTES));
    text.shrink_to_fit();
    if has_text(&text) {
        Body::Text(text)
    } else {
        Body::Empty
    }
}

/// Whether `text` has a character other than white space and control characters.
fn has_text(text: &str) -> bool {
    !text.chars().all(|ch| ch.is_whitespace() || ch.is_control())
}

/// `text` without its runs of base64.
///
/// A run is a stretch of base64 characters (`A–Z a–z 0–9 + / =`) that goes on across a line break
/// (with any indentation after it) or a JSON `\n` escape when the line before has at least
/// [`MIN_LINE`] of them. It is dropped, with the breaks inside it, when it has at least
/// [`MIN_RUN`] base64 characters and upper-case letters, lower-case letters and digits all three:
/// encoded data always has them, while a long word, a DNA sequence, a hex digest or a row of `=`
/// lacks one. URLs stay: their dots, hyphens and other punctuation end runs. When the last line of
/// a wrapped block is full, letters and digits that start the next line go with it.
fn without_base64_runs(text: &str) -> Cow<'_, str> {
    let bytes = text.as_bytes();
    let mut kept = String::new();
    // The text from `copied` on is not decided yet. Runs begin and end at ASCII bytes, so every
    // split is at a character boundary.
    let mut copied = 0;
    let mut at = 0;
    while at < bytes.len() {
        if !is_base64(bytes[at]) {
            at += 1;
            continue;
        }
        let start = at;
        let mut run = Run::default();
        loop {
            let line = at;
            while at < bytes.len() && is_base64(bytes[at]) {
                run.add(bytes[at]);
                at += 1;
            }
            let end = at;
            if end - line >= MIN_LINE
                && let Some(len) = line_break(&bytes[end..])
                && bytes.get(end + len).copied().is_some_and(is_base64)
            {
                at = end + len;
            } else {
                break;
            }
        }
        if run.is_encoded() {
            kept.push_str(&text[copied..start]);
            copied = at;
        }
    }
    // A dropped run ends after it starts, so nothing was dropped while `copied` is 0.
    if copied == 0 {
        return Cow::Borrowed(text);
    }
    kept.push_str(&text[copied..]);
    Cow::Owned(kept)
}

fn is_base64(byte: u8) -> bool {
    byte.is_ascii_alphanumeric() || matches!(byte, b'+' | b'/' | b'=')
}

/// The length of the line break `rest` starts with: `\n` and the spaces and tabs after it, or a
/// JSON `\n` escape.
fn line_break(rest: &[u8]) -> Option<usize> {
    match rest {
        [b'\n', after @ ..] => Some(
            1 + after
                .iter()
                .take_while(|&&byte| matches!(byte, b' ' | b'\t'))
                .count(),
        ),
        [b'\\', b'n', ..] => Some(2),
        _ => None,
    }
}

/// The base64 characters of a run so far.
#[derive(Default)]
struct Run {
    len: usize,
    upper: bool,
    lower: bool,
    digit: bool,
}

impl Run {
    fn add(&mut self, byte: u8) {
        self.len += 1;
        self.upper |= byte.is_ascii_uppercase();
        self.lower |= byte.is_ascii_lowercase();
        self.digit |= byte.is_ascii_digit();
    }

    fn is_encoded(&self) -> bool {
        self.len >= MIN_RUN && self.upper && self.lower && self.digit
    }
}

#[cfg(test)]
mod tests;
