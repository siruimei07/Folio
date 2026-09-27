//! The `folio_cjk` tokenizer inside SQLite: registration, MATCH, `highlight()` and `snippet()`
//! (ADR-0002 §5).

use folio_core::search::{TOKENIZER_NAME, phrase, register_tokenizer};
use proptest::prelude::*;
use rusqlite::Connection;

/// An in-memory FTS5 table with one row per text, in order. Texts go in as bytes, so they can
/// hold invalid UTF-8.
fn index<T: AsRef<[u8]>>(texts: &[T]) -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    register_tokenizer(&conn).unwrap();
    conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE docs USING fts5(body, tokenize = '{TOKENIZER_NAME}')"
    ))
    .unwrap();
    for text in texts {
        conn.execute(
            "INSERT INTO docs (body) VALUES (CAST(?1 AS TEXT))",
            [text.as_ref()],
        )
        .unwrap();
    }
    conn
}

/// `highlight()` of every row that matches `query`, in row order.
fn highlights(conn: &Connection, query: &str) -> Vec<Vec<u8>> {
    conn.prepare(
        "SELECT CAST(highlight(docs, 0, '[', ']') AS BLOB) FROM docs
         WHERE docs MATCH ?1 ORDER BY rowid",
    )
    .unwrap()
    .query_map([query], |row| row.get(0))
    .unwrap()
    .collect::<Result<_, _>>()
    .unwrap()
}

/// The highlighted rows that contain `term`.
fn search(conn: &Connection, term: &str) -> Vec<String> {
    highlights(conn, &phrase(term))
        .into_iter()
        .map(|row| String::from_utf8(row).unwrap())
        .collect()
}

#[test]
fn matches_chinese_queries_of_any_length_as_contiguous_substrings() {
    let conn = index(&["线性代数", "代数几何", "线代复习"]);
    assert_eq!(search(&conn, "线"), ["[线]性代数", "[线]代复习"]);
    assert_eq!(search(&conn, "代数"), ["线性[代数]", "[代数]几何"]);
    assert_eq!(search(&conn, "线代"), ["[线代]复习"]);
    assert_eq!(search(&conn, "线性代数"), ["[线性代数]"]);
    assert!(search(&conn, "性数").is_empty());
}

#[test]
fn matches_across_chinese_and_other_text() {
    let conn = index(&["第3章 C语言指针"]);
    assert_eq!(search(&conn, "3章"), ["第[3章] C语言指针"]);
    assert_eq!(search(&conn, "c语言"), ["第3章 [C语言]指针"]);
}

#[test]
fn folds_case_and_width_and_matches_word_prefixes() {
    let conn = index(&["Linear Algebra notes", "ＡＢＣ 期中"]);
    assert_eq!(search(&conn, "ALGEBRA"), ["Linear [Algebra] notes"]);
    assert_eq!(
        highlights(&conn, &format!("{} *", phrase("alg"))),
        [b"Linear [Algebra] notes"]
    );
    assert!(search(&conn, "gebra").is_empty());
    assert_eq!(search(&conn, "abc"), ["[ＡＢＣ] 期中"]);
}

#[test]
fn splits_filename_and_prose_punctuation_into_words() {
    let conn = index(&[
        "Linear_Algebra_HW1.pdf",
        "HW1_solution.pdf",
        "report.final.docx",
        "Chapter:Intro",
        "Newton’s laws",
        "Newton's laws",
    ]);
    assert_eq!(search(&conn, "algebra"), ["Linear_[Algebra]_HW1.pdf"]);
    assert_eq!(
        search(&conn, "hw1"),
        ["Linear_Algebra_[HW1].pdf", "[HW1]_solution.pdf"]
    );
    assert_eq!(search(&conn, "final"), ["report.[final].docx"]);
    assert_eq!(search(&conn, "intro"), ["Chapter:[Intro]"]);
    assert_eq!(
        highlights(&conn, &format!("{} *", phrase("sol"))),
        [b"HW1_[solution].pdf"]
    );
    for query in ["Newton's", "Newton’s"] {
        assert_eq!(search(&conn, query), ["[Newton’s] laws", "[Newton's] laws"]);
    }
    assert_eq!(
        search(&conn, "newton"),
        ["[Newton]’s laws", "[Newton]'s laws"]
    );
}

#[test]
fn matches_normalized_common_script_letters_as_whole_words() {
    let conn = index(&["µm", "ℂalculus"]);
    assert_eq!(search(&conn, "μm"), ["[µm]"]);
    assert_eq!(search(&conn, "calculus"), ["[ℂalculus]"]);
    for query in ["μ", "m", "c", "alculus"] {
        assert!(search(&conn, query).is_empty(), "{query}");
    }
}

#[test]
fn normalizes_combining_marks_but_does_not_casefold_words() {
    let conn = index(&["cafe\u{301}", "CAFÉ", "Straße"]);
    for query in ["café", "cafe\u{301}"] {
        assert_eq!(search(&conn, query), ["[cafe\u{301}]", "[CAFÉ]"]);
    }
    assert_eq!(search(&conn, "STRAẞE"), ["[Straße]"]);
    assert!(search(&conn, "STRASSE").is_empty());
    // Random byte pairs can form a real combining mark. Keep the visible source grapheme
    // together rather than requiring the highlight to end at the Han scalar's byte boundary.
    assert_eq!(search(&index(&["线\u{591}"]), "线"), ["[线\u{591}]"]);
}

#[test]
fn normalizes_decomposed_hangul_and_kana_and_halfwidth_kana() {
    for (original, canonical, first_original, first_canonical) in [
        (
            "\u{1112}\u{1161}\u{11AB}\u{1100}\u{116E}\u{11A8}",
            "한국",
            "\u{1112}\u{1161}\u{11AB}",
            "한",
        ),
        ("テ\u{3099}ータ", "データ", "テ\u{3099}", "デ"),
        ("ｶﾞｲﾄﾞ", "ガイド", "ｶﾞ", "ガ"),
    ] {
        let conn = index(&[original, canonical]);
        for query in [original, canonical] {
            assert_eq!(
                search(&conn, query),
                [format!("[{original}]"), format!("[{canonical}]")],
                "{query}"
            );
        }
        assert_eq!(
            search(&conn, first_canonical),
            [
                format!("[{first_original}]{}", &original[first_original.len()..]),
                format!("[{first_canonical}]{}", &canonical[first_canonical.len()..]),
            ]
        );
        assert!(search(&conn, "하").is_empty());
    }
}

#[test]
fn normalizes_kangxi_radicals_before_classifying_cjk() {
    let conn = index(&["⾼等数学", "高等数学"]);
    for query in ["高等数学", "⾼等数学"] {
        assert_eq!(search(&conn, query), ["[⾼等数学]", "[高等数学]"]);
    }
    assert_eq!(search(&conn, "高等"), ["[⾼等]数学", "[高等]数学"]);
    assert_eq!(search(&conn, "等数"), ["⾼[等数]学", "高[等数]学"]);
}

#[test]
fn compatibility_expansions_keep_original_glyphs_and_phrase_positions() {
    let fraction = index(&["a½b", "¹¼"]);
    assert_eq!(search(&fraction, "a1"), ["[a½]b"]);
    assert_eq!(search(&fraction, "2b"), ["a[½b]"]);
    assert_eq!(search(&fraction, "a1 2b"), ["[a½b]"]);
    assert_eq!(search(&fraction, "11 4"), ["[¹¼]"]);
    for (glyph, expanded, inner_terms) in [
        ("ゟ", "より", &["よ", "り"][..]),
        ("㍿", "株式会社", &["株", "式会", "社"][..]),
    ] {
        let original = format!("前{glyph}後");
        let conn = index(&[&original]);
        for query in std::iter::once(expanded).chain(inner_terms.iter().copied()) {
            assert_eq!(search(&conn, query), [format!("前[{glyph}]後")], "{query}");
            let snippet: String = conn
                .query_row(
                    "SELECT snippet(docs, 0, '[', ']', '…', 16) FROM docs WHERE docs MATCH ?1",
                    [phrase(query)],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(snippet, format!("前[{glyph}]後"), "{query}");
        }
        assert_eq!(
            search(&conn, &format!("{expanded}後")),
            [format!("前[{glyph}後]")]
        );
        assert_eq!(search(&conn, "後"), [format!("前{glyph}[後]")]);
        assert_eq!(
            search(&index(&[expanded]), glyph),
            [format!("[{expanded}]")]
        );
        let repeated = index(&[format!("{glyph}{glyph}")]);
        assert_eq!(search(&repeated, expanded), [format!("[{glyph}{glyph}]")]);
        for window in [1, 2] {
            let snippet: String = conn
                .query_row(
                    "SELECT snippet(docs, 0, '[', ']', '…', ?2) FROM docs WHERE docs MATCH ?1",
                    rusqlite::params![phrase(inner_terms[0]), window],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(snippet.contains(&format!("[{glyph}]")), "{snippet}");
            assert_eq!(snippet.matches(glyph).count(), 1, "{snippet}");
        }
    }
}

#[test]
fn default_ignorables_join_words_and_cjk_without_changing_highlighted_text() {
    for ignored in ["\u{AD}", "\u{200B}", "\u{FE0F}", "\u{E0100}"] {
        let word = format!("infor{ignored}mation");
        let cjk = format!("线{ignored}性代数");
        let conn = index(&[word.as_str(), "information", cjk.as_str(), "线性代数"]);
        for query in [word.as_str(), "information"] {
            assert_eq!(
                search(&conn, query),
                [format!("[{word}]"), "[information]".into()]
            );
        }
        for query in [cjk.as_str(), "线性代数"] {
            assert_eq!(
                search(&conn, query),
                [format!("[{cjk}]"), "[线性代数]".into()]
            );
        }
    }
}

#[test]
fn ignored_marks_do_not_attach_a_separator_to_the_next_word() {
    for separator in [" \u{FE0F}", ".\u{FE0F}", "_\u{AD}", "\u{200B} \u{FE0F}"] {
        let text = format!("alpha{separator}beta");
        let conn = index(&[&text]);
        assert_eq!(search(&conn, "beta"), [format!("alpha{separator}[beta]")]);
        assert!(search(&conn, "alphabeta").is_empty());
    }
}

#[test]
fn cjk_line_breaks_join_but_spaces_and_punctuation_break_pairs() {
    let conn = index(&[
        "线性\n代数",
        "线性\r代数",
        "线性\r\n代数",
        "线性 代数",
        "线性，代数",
        "线性\n\n代数",
        "线性\r\n\r\n代数",
        "线性\t代数",
    ]);
    for query in ["线性代数", "线性\r\n代数"] {
        assert_eq!(
            search(&conn, query),
            ["[线性\n代数]", "[线性\r代数]", "[线性\r\n代数]"]
        );
    }
    assert_eq!(
        search(&conn, "性代"),
        ["线[性\n代]数", "线[性\r代]数", "线[性\r\n代]数"]
    );
    assert_eq!(
        search(&index(&["alpha\nbeta"]), "alphabeta"),
        Vec::<String>::new()
    );
}

#[test]
fn a_query_without_tokens_matches_nothing() {
    let conn = index(&["线性代数，期中"]);
    assert!(search(&conn, "，").is_empty());
    assert!(search(&conn, "").is_empty());
}

#[test]
fn snippets_mark_the_match() {
    let conn = index(&["第一章 绪论。第二章 线性方程组的解法。第三章 矩阵。"]);
    let snippet: String = conn
        .query_row(
            "SELECT snippet(docs, 0, '[', ']', '…', 6) FROM docs WHERE docs MATCH ?1",
            [phrase("方程组")],
            |row| row.get(0),
        )
        .unwrap();
    assert!(snippet.contains("[方程组]"), "{snippet}");
}

#[test]
fn indexes_the_valid_parts_of_invalid_utf8() {
    let conn = index(&[["线".as_bytes(), &[0xFF], "代".as_bytes()].concat()]);
    assert_eq!(
        highlights(&conn, &phrase("代")),
        [["线".as_bytes(), b"\xFF[", "代".as_bytes(), b"]"].concat()]
    );
    // The invalid byte separates the characters.
    assert!(search(&conn, "线代").is_empty());
}

#[test]
fn rejects_tokenizer_arguments() {
    let conn = Connection::open_in_memory().unwrap();
    register_tokenizer(&conn).unwrap();
    let created = conn.execute_batch(&format!(
        "CREATE VIRTUAL TABLE docs USING fts5(body, tokenize = '{TOKENIZER_NAME} extra')"
    ));
    assert!(created.is_err());
}

#[test]
fn every_connection_registers_the_tokenizer() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("catalog.sqlite");
    let writer = Connection::open(&path).unwrap();
    register_tokenizer(&writer).unwrap();
    writer
        .execute_batch(&format!(
            "CREATE VIRTUAL TABLE docs USING fts5(body, tokenize = '{TOKENIZER_NAME}');
             INSERT INTO docs (body) VALUES ('线性代数');"
        ))
        .unwrap();

    let reader = Connection::open(&path).unwrap();
    let count = |conn: &Connection| {
        conn.query_row(
            "SELECT count(*) FROM docs WHERE docs MATCH ?1",
            [phrase("代数")],
            |row| row.get::<_, i64>(0),
        )
    };
    assert!(count(&reader).is_err());
    for pragma in ["PRAGMA quick_check", "PRAGMA integrity_check"] {
        assert!(
            reader
                .query_row(pragma, [], |row| row.get::<_, String>(0))
                .is_err()
        );
    }
    register_tokenizer(&reader).unwrap();
    assert_eq!(count(&reader).unwrap(), 1);
    for pragma in ["PRAGMA quick_check", "PRAGMA integrity_check"] {
        assert_eq!(
            reader
                .query_row(pragma, [], |row| row.get::<_, String>(0))
                .unwrap(),
            "ok"
        );
    }

    // FTS5 may write a content row before an unregistered tokenizer causes INSERT to fail.
    // Roll back the whole transaction on any write error; never commit a partially indexed row.
    let mut unregistered_writer = Connection::open(&path).unwrap();
    let transaction = unregistered_writer.transaction().unwrap();
    assert!(
        transaction
            .execute("INSERT INTO docs (body) VALUES (?1)", ["不应保留"])
            .is_err()
    );
    transaction.rollback().unwrap();
    register_tokenizer(&unregistered_writer).unwrap();
    assert_eq!(search(&unregistered_writer, "代数"), ["线性[代数]"]);
    assert!(search(&unregistered_writer, "不应保留").is_empty());
    assert_eq!(
        unregistered_writer
            .query_row("SELECT count(*) FROM docs", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    unregistered_writer
        .execute("INSERT INTO docs(docs) VALUES ('integrity-check')", [])
        .unwrap();
}

/// Text from a few Chinese characters, separators, words and stray bytes that are not UTF-8.
fn mixed_bytes() -> impl Strategy<Value = Vec<u8>> {
    let part = prop_oneof![
        4 => prop::sample::select(vec!["线", "性", "代", "数"]).prop_map(|s| s.as_bytes().to_vec()),
        2 => prop::sample::select(vec![" ", "，", "ab", "Cd", "3"]).prop_map(|s| s.as_bytes().to_vec()),
        // Continuation bytes without a lead cannot accidentally form valid Unicode marks,
        // compatibility letters or ignorables, which this literal-substring oracle does not model.
        1 => (0x80u8..=0xBF).prop_map(|byte| vec![byte]),
    ];
    prop::collection::vec(part, 0..24).prop_map(|parts| parts.concat())
}

/// Any Unicode text, with extra NULs and FTS5 query syntax (`any::<String>()` has no control
/// characters).
fn any_text() -> impl Strategy<Value = String> {
    let ch = prop_oneof![
        any::<char>(),
        prop::sample::select(vec!['\0', '"', '*', '(', ':', '线', '代']),
    ];
    prop::collection::vec(ch, 0..24).prop_map(String::from_iter)
}

fn chinese_term() -> impl Strategy<Value = String> {
    prop::collection::vec(prop::sample::select(vec!["线", "性", "代", "数"]), 1..5)
        .prop_map(|chars| chars.concat())
}

/// `text` with every occurrence of `term` in brackets. Overlapping and touching occurrences share
/// one pair, as in `highlight()`. `None` if `term` does not occur.
fn marked(text: &[u8], term: &[u8]) -> Option<Vec<u8>> {
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    for start in 0..text.len() {
        if text[start..].starts_with(term) {
            let end = start + term.len();
            match ranges.last_mut() {
                Some(last) if start <= last.1 => last.1 = end,
                _ => ranges.push((start, end)),
            }
        }
    }
    if ranges.is_empty() {
        return None;
    }
    let mut out = Vec::new();
    let mut copied = 0;
    for (start, end) in ranges {
        out.extend_from_slice(&text[copied..start]);
        out.push(b'[');
        out.extend_from_slice(&text[start..end]);
        out.push(b']');
        copied = end;
    }
    out.extend_from_slice(&text[copied..]);
    Some(out)
}

proptest! {
    #[test]
    fn a_chinese_term_matches_and_is_highlighted_exactly_where_it_occurs(
        text in mixed_bytes(),
        term in chinese_term(),
    ) {
        let conn = index(&[&text]);
        let expected: Vec<Vec<u8>> = marked(&text, term.as_bytes()).into_iter().collect();
        prop_assert_eq!(highlights(&conn, &phrase(&term)), expected);
    }

    #[test]
    fn any_text_is_a_valid_search_term(text in any_text(), term in any_text()) {
        let conn = index(&[&text]);
        let found = conn.query_row(
            "SELECT count(*) FROM docs WHERE docs MATCH ?1",
            [phrase(&term)],
            |row| row.get::<_, i64>(0),
        );
        prop_assert!(found.is_ok(), "{found:?}");
    }
}
