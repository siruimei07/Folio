//! Text files decoded as the preview decodes them (versioning.md §10.2, ui-architecture.md §10.1).
//!
//! The rule is `apps/desktop/src/preview/frame/decode.ts`'s, so a file reads the same in its
//! preview, its diff and its search body:
//!
//! 1. A byte order mark decides: UTF-8, UTF-16 LE or UTF-16 BE, without the mark, malformed
//!    sequences as U+FFFD.
//! 2. Otherwise a NUL in the first 8 KiB means binary content behind a text extension.
//! 3. Otherwise valid UTF-8 is UTF-8, and anything else is GB18030 (which contains GBK, the
//!    encoding of many Chinese notes written on Windows), malformed sequences as U+FFFD.
//! 4. `\r\n` and a lone `\r` become `\n`.
//!
//! [`decode_prefix`] reads the first bytes of a longer file, as search does: a character the end of
//! the prefix cuts is dropped instead of becoming U+FFFD or making UTF-8 invalid.

use encoding_rs::{CoderResult, Encoding, GB18030, UTF_8, UTF_16BE, UTF_16LE};

/// Bytes searched for a NUL when no byte order mark decides (decode.ts `SNIFF_BYTES`).
const SNIFF_BYTES: usize = 8192;

const UTF8_BOM: &[u8] = &[0xEF, 0xBB, 0xBF];
const UTF16LE_BOM: &[u8] = &[0xFF, 0xFE];
const UTF16BE_BOM: &[u8] = &[0xFE, 0xFF];

/// A text file's content, or binary content behind a text extension.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decoded {
    Text(TextFile),
    /// No byte order mark and a NUL in the first 8 KiB.
    Binary,
}

/// Decoded text and how its bytes were written.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TextFile {
    /// The text without a byte order mark, every line break as `\n`.
    pub text: String,
    pub encoding: TextEncoding,
    /// The line breaks of the bytes before they became `\n`, so a diff can report a change of line
    /// endings alone.
    pub line_endings: LineEndings,
}

/// How the bytes were decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TextEncoding {
    /// Valid UTF-8 without a byte order mark.
    Utf8,
    /// UTF-8 after a byte order mark; malformed sequences became U+FFFD.
    Utf8Bom,
    /// UTF-16 little-endian after a byte order mark.
    Utf16Le,
    /// UTF-16 big-endian after a byte order mark.
    Utf16Be,
    /// Neither a byte order mark nor valid UTF-8; malformed sequences became U+FFFD.
    Gb18030,
}

/// The kinds of line break in a text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineEndings {
    /// No line break.
    None,
    /// Only `\n`.
    Lf,
    /// Only `\r\n`.
    Crlf,
    /// Only a lone `\r`.
    Cr,
    /// More than one kind.
    Mixed,
}

impl LineEndings {
    fn of(lf: bool, crlf: bool, cr: bool) -> Self {
        match (lf, crlf, cr) {
            (false, false, false) => Self::None,
            (true, false, false) => Self::Lf,
            (false, true, false) => Self::Crlf,
            (false, false, true) => Self::Cr,
            _ => Self::Mixed,
        }
    }
}

/// A whole file's bytes (or a whole stored version's) as text, by the preview's rule.
pub fn decode(bytes: &[u8]) -> Decoded {
    decode_bytes(bytes, true)
}

/// The first bytes of a longer file as text, by the preview's rule applied to them, without the
/// character the end of `bytes` cuts (a UTF-8, UTF-16 or GB18030 sequence that would go on).
///
/// A `\r` at the very end counts as a lone `\r` in `line_endings`. When the first byte that is not
/// valid UTF-8 lies beyond the prefix, the prefix is UTF-8 while the whole file is GB18030.
pub fn decode_prefix(bytes: &[u8]) -> Decoded {
    decode_bytes(bytes, false)
}

fn decode_bytes(bytes: &[u8], complete: bool) -> Decoded {
    let (text, encoding) = if let Some(rest) = bytes.strip_prefix(UTF8_BOM) {
        (decode_with(UTF_8, rest, complete), TextEncoding::Utf8Bom)
    } else if let Some(rest) = bytes.strip_prefix(UTF16LE_BOM) {
        (decode_with(UTF_16LE, rest, complete), TextEncoding::Utf16Le)
    } else if let Some(rest) = bytes.strip_prefix(UTF16BE_BOM) {
        (decode_with(UTF_16BE, rest, complete), TextEncoding::Utf16Be)
    } else if bytes.get(..SNIFF_BYTES).unwrap_or(bytes).contains(&0) {
        return Decoded::Binary;
    } else {
        match std::str::from_utf8(bytes) {
            Ok(text) => (text.to_owned(), TextEncoding::Utf8),
            // Valid up to a character the end of the prefix cuts, which the decoder holds back.
            Err(error) if !complete && error.error_len().is_none() => {
                (decode_with(UTF_8, bytes, false), TextEncoding::Utf8)
            }
            Err(_) => (decode_with(GB18030, bytes, complete), TextEncoding::Gb18030),
        }
    };
    let (text, line_endings) = normalise_line_breaks(text);
    Decoded::Text(TextFile {
        text,
        encoding,
        line_endings,
    })
}

/// `bytes` decoded by `encoding` with no byte order mark handling, malformed sequences as U+FFFD.
/// Unless `last`, a sequence that the end of `bytes` cuts is held back instead of becoming U+FFFD.
fn decode_with(encoding: &'static Encoding, bytes: &[u8], last: bool) -> String {
    let mut decoder = encoding.new_decoder_without_bom_handling();
    let capacity = decoder
        .max_utf8_buffer_length(bytes.len())
        .unwrap_or(bytes.len());
    let mut text = String::with_capacity(capacity);
    let mut rest = bytes;
    loop {
        let (result, read, _replaced) = decoder.decode_to_string(rest, &mut text, last);
        rest = &rest[read..];
        match result {
            CoderResult::InputEmpty => return text,
            // Only when the worst case above did not fit in a `usize`.
            CoderResult::OutputFull => text.reserve(rest.len().max(16)),
        }
    }
}

/// `text` with `\r\n` and every lone `\r` as `\n`, and the kinds of line break it had.
fn normalise_line_breaks(text: String) -> (String, LineEndings) {
    if !text.contains('\r') {
        let lf = text.contains('\n');
        return (text, LineEndings::of(lf, false, false));
    }
    let (mut lf, mut crlf, mut cr) = (false, false, false);
    let mut normalised = String::with_capacity(text.len());
    let mut rest = text.as_str();
    while let Some(at) = rest.find('\r') {
        let before = &rest[..at];
        lf |= before.contains('\n');
        normalised.push_str(before);
        normalised.push('\n');
        // `\r` is one byte, so the text after it starts on a character boundary.
        let after = &rest[at + 1..];
        rest = match after.strip_prefix('\n') {
            Some(after_lf) => {
                crlf = true;
                after_lf
            }
            None => {
                cr = true;
                after
            }
        };
    }
    lf |= rest.contains('\n');
    normalised.push_str(rest);
    (normalised, LineEndings::of(lf, crlf, cr))
}

#[cfg(test)]
mod tests;
