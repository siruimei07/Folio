//! Text out of library files (versioning.md §10.2–§10.3): the one reader of text-class and
//! Word-class content.
//!
//! Full-text search makes its bodies with it, and diffs read the versions they compare with it, so
//! a file reads the same in its preview, its diff and its search body. Everything here is pure:
//! bytes in, text out, with no catalog and no file system.

use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use crate::catalog::MAX_BODY_BYTES;

mod body;
#[cfg(test)]
pub(crate) mod testing;
mod text;
mod word;

pub use body::{Body, is_generated, text_body, word_body};
pub use text::{Decoded, LineEndings, TextEncoding, TextFile, decode, decode_prefix};
pub use word::{MAX_ENTRIES, MAX_EXPANDED, MAX_READ, WordError, WordLimits, WordText, read_word};

/// Version of the extractors. Bump it whenever they give other text for the same bytes, so the
/// text derived from every file (search bodies) is derived again.
pub const VERSION: u32 = 1;

/// The most bytes of a text file read for its search body. Every encoding gives at least one
/// UTF-8 byte for every two bytes it decodes, and the 8 cover a byte order mark and a character
/// the end cuts, so this many fill the body unless joined line breaks (`\r\n`) or dropped base64
/// make the text shorter.
pub const READ_LIMIT: usize = 2 * MAX_BODY_BYTES + 8;

/// The most time one file's extraction may take, from opening it: a backstop, since the caps on
/// what is read bound the work.
pub const TIME_LIMIT: Duration = Duration::from_secs(10);

/// When an extraction must stop before it is done.
#[derive(Debug, Clone, Copy)]
pub struct Control<'a> {
    /// The extraction stops, timed out, once this instant has come.
    pub deadline: Instant,
    /// The extraction stops, cancelled, once another thread sets this.
    pub cancel: &'a AtomicBool,
}
