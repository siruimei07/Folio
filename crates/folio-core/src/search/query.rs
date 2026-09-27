//! Turning what the user typed into an FTS5 query (ADR-0002 §5, docs/specs/library-core.md §6).

use std::ops::ControlFlow;

use super::phrase;
use super::tokenizer::{Mode, Token, is_cjk, tokenize};

/// The longest search text Folio accepts. FTS5 can take quadratic time to parse long phrases.
pub const MAX_QUERY_CHARS: usize = 256;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum QueryError {
    #[error("the search text is longer than {MAX_QUERY_CHARS} characters")]
    TooLong,
}

/// A full-text query built from user text: the only way user text reaches `MATCH`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchQuery {
    expression: String,
}

impl SearchQuery {
    /// Each whitespace-separated term becomes a quoted phrase, and all of them must match. The
    /// last term matches as a prefix when it ends in a word of two or more letters or digits
    /// (`alg` finds `algebra`); one letter matches whole words only, and CJK text never gets a
    /// prefix. `None` when the text has nothing to search for.
    pub fn parse(text: &str) -> Result<Option<Self>, QueryError> {
        if text.chars().count() > MAX_QUERY_CHARS {
            return Err(QueryError::TooLong);
        }
        let terms: Vec<(&str, Token<'_>)> = text
            .split_whitespace()
            .filter_map(|term| last_token(term).map(|token| (term, token)))
            .collect();
        let Some((_, last)) = terms.last() else {
            return Ok(None);
        };
        let mut expression = terms
            .iter()
            .map(|(term, _)| phrase(term))
            .collect::<Vec<_>>()
            .join(" ");
        if last.text.chars().count() >= 2 && !last.text.chars().any(is_cjk) {
            expression.push_str(" *");
        }
        Ok(Some(Self { expression }))
    }

    /// The expression for `MATCH`.
    pub fn expression(&self) -> &str {
        &self.expression
    }
}

/// The term's last query token, or `None` if it has none (only punctuation, for example).
fn last_token(term: &str) -> Option<Token<'_>> {
    let mut last = None;
    let _ = tokenize(term, Mode::Query, &mut |token| {
        last = Some(token);
        ControlFlow::Continue(())
    });
    last
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;
    use rusqlite::Connection;

    use super::*;
    use crate::search::{TOKENIZER_NAME, register_tokenizer};

    fn expression(text: &str) -> Option<String> {
        SearchQuery::parse(text)
            .unwrap()
            .map(|query| query.expression)
    }

    #[test]
    fn quotes_every_term_and_adds_a_prefix_to_the_last_word() {
        assert_eq!(expression("线代").as_deref(), Some(r#""线代""#));
        assert_eq!(
            expression("linear alg").as_deref(),
            Some(r#""linear" "alg" *"#)
        );
        assert_eq!(expression("hw1").as_deref(), Some(r#""hw1" *"#));
        assert_eq!(expression("c语言").as_deref(), Some(r#""c语言""#));
        assert_eq!(expression("线代 hw").as_deref(), Some(r#""线代" "hw" *"#));
        assert_eq!(
            expression("Linear_Alg").as_deref(),
            Some(r#""Linear_Alg" *"#)
        );
    }

    #[test]
    fn a_single_letter_matches_whole_words_only() {
        assert_eq!(expression("a").as_deref(), Some(r#""a""#));
        assert_eq!(expression("算法 C").as_deref(), Some(r#""算法" "C""#));
    }

    #[test]
    fn user_text_never_becomes_query_syntax() {
        assert_eq!(
            expression(r#"a OR b NEAR(c) name:x -y "z"#).as_deref(),
            Some(r#""a" "OR" "b" "NEAR(c)" "name:x" "-y" """z""#)
        );
        assert_eq!(expression("ab\0cd").as_deref(), Some(r#""ab cd" *"#));
    }

    #[test]
    fn splits_at_any_whitespace_and_drops_terms_without_tokens() {
        assert_eq!(
            expression("线性\u{3000}代数").as_deref(),
            Some(r#""线性" "代数""#)
        );
        assert_eq!(expression("  ,,  线代 !! ").as_deref(), Some(r#""线代""#));
        for text in ["", "   ", "!!! …", "\u{200b}"] {
            assert_eq!(expression(text), None, "{text:?}");
        }
    }

    #[test]
    fn rejects_text_longer_than_the_limit() {
        assert!(SearchQuery::parse(&"字".repeat(MAX_QUERY_CHARS)).is_ok());
        assert_eq!(
            SearchQuery::parse(&"字".repeat(MAX_QUERY_CHARS + 1)),
            Err(QueryError::TooLong)
        );
    }

    proptest! {
        /// Whatever the user types, FTS5 accepts the expression.
        #[test]
        fn every_query_is_valid_fts5(text in "\\PC{0,40}|[a-z 线代\"*():^-]{0,40}") {
            let conn = Connection::open_in_memory().unwrap();
            register_tokenizer(&conn).unwrap();
            conn.execute_batch(&format!(
                "CREATE VIRTUAL TABLE t USING fts5(body, tokenize = '{TOKENIZER_NAME}');
                 INSERT INTO t (body) VALUES ('线性代数 linear algebra');"
            )).unwrap();
            if let Some(query) = SearchQuery::parse(&text).unwrap() {
                let result: rusqlite::Result<i64> = conn.query_row(
                    "SELECT count(*) FROM t WHERE t MATCH ?1",
                    [query.expression()],
                    |row| row.get(0),
                );
                prop_assert!(result.is_ok(), "{:?}: {:?}", query.expression(), result);
            }
        }
    }
}
