//! Full-text search (ADR-0002 §5).
//!
//! The catalog's FTS5 table uses the `folio_cjk` tokenizer, which matches Chinese queries of one
//! or two characters; FTS5's own trigram tokenizer needs at least three.
//!
//! Text stored for UI results must be valid UTF-8 without NUL. The insert/extraction boundary
//! must enforce this: `highlight()` and `snippet()` copy text as C strings and drop whatever
//! follows a NUL; rusqlite's String reader rejects invalid UTF-8. The FFI's invalid-byte handling
//! is a fallback, not a substitute for that boundary.

mod fts5;
mod tokenizer;

pub use fts5::{TOKENIZER_NAME, register_tokenizer};
pub use tokenizer::{Mode, Token, tokenize};

/// Token format version. The catalog must rebuild its index before any read or write when
/// this changes. Bump it whenever tokens change, including changes to Rust or dependency
/// Unicode tables. Version 2 normalizes before classification and splits file-name punctuation.
pub const TOKENIZER_VERSION: u32 = 2;

/// Quotes one search term as an FTS5 phrase, so no user text is parsed as query syntax.
///
/// FTS5 reads the query as a C string, where a NUL would end it early. A NUL is never part of a
/// token, so it becomes a space, which separates tokens the same way.
/// This quotes syntax only. The future query builder and privileged IPC must reject oversized
/// user queries before calling it; FTS5 can take quadratic time to parse very long phrases.
pub fn phrase(term: &str) -> String {
    format!("\"{}\"", term.replace('"', "\"\"").replace('\0', " "))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_terms_and_escapes_quotes() {
        assert_eq!(phrase("线性代数"), "\"线性代数\"");
        assert_eq!(phrase("say \"hi\" OR x*"), "\"say \"\"hi\"\" OR x*\"");
        assert_eq!(phrase("a\0b"), "\"a b\"");
    }
}
