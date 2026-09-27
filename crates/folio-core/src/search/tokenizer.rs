//! Splits text into search tokens (ADR-0002 §5).
//!
//! - Chinese, Japanese and Korean text: every character is a token. When indexing, the pair it
//!   starts is a second token at the same position (FTS5 "colocated"). In a query, a run becomes
//!   its pairs followed by its last character, at consecutive positions: `线` stays `线`, and
//!   `线性代数` becomes `线性 性代 代数 数`. So every query matches as a contiguous substring, like
//!   Lucene's CJK bigram filter with unigrams. The last character makes the phrase cover one
//!   position per character: `highlight()` and `snippet()` mark the positions a phrase covers,
//!   with the offsets of the first token at each position.
//! - Normalize before classification, removing Unicode default-ignorables and preserving
//!   original grapheme ranges. Compatibility expansions may share an original range.
//! - Other text: letters and numbers with combining marks, split at punctuation and lower-cased.
//!   One CR, LF or CRLF between CJK characters joins a hard-wrapped line; spaces, punctuation
//!   and blank lines still separate runs.
//!
//! Offsets are byte ranges in the original text, so FTS5's `highlight()` and `snippet()` work on
//! the stored text directly. They tokenize it again for every row they show, and skip colocated
//! tokens, so [`Mode::Highlight`] leaves the pairs out.

use std::borrow::Cow;
use std::ops::ControlFlow;

use unicode_normalization::char::{decompose_compatible, is_combining_mark};
use unicode_normalization::{UnicodeNormalization, is_nfkc};
use unicode_script::{Script, UnicodeScript};
use unicode_segmentation::UnicodeSegmentation;

/// What the text is tokenized for.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// Stored text, for the index.
    Document,
    /// Stored text again, for `highlight()` and `snippet()`: the document tokens without the
    /// colocated pairs.
    Highlight,
    /// One phrase of a query.
    Query,
}

/// A token and the byte range of the original text it came from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Token<'a> {
    pub text: Cow<'a, str>,
    pub start: usize,
    pub end: usize,
    /// Shares the position of the previous token (a CJK pair next to its first character).
    pub colocated: bool,
}

/// Passes the tokens of `text` to `emit` in order, until `emit` breaks.
pub fn tokenize<'a>(
    text: &'a str,
    mode: Mode,
    emit: &mut impl FnMut(Token<'a>) -> ControlFlow<()>,
) -> ControlFlow<()> {
    // The usual ASCII/Han text needs no mapping. These common CJK punctuation marks remain
    // separators under NFKC, so their original bytes can also pass through unchanged.
    if text.chars().all(|ch| {
        ch.is_ascii()
            || is_unified_ideograph(ch)
            || matches!(ch, '，' | '。' | '、' | '；' | '：' | '！' | '？')
    }) {
        return split(text, mode, emit);
    }
    if !text
        .chars()
        .any(|ch| is_default_ignorable(ch) || is_combining_mark(ch))
        && is_nfkc(text)
    {
        return split(text, mode, emit);
    }

    // Decompose before grapheme segmentation: compatibility jamo can form a syllable across
    // original grapheme boundaries. Each output scalar remembers the original source range.
    // ponytail: temporary O(n) maps for uncommon Unicode; stream them if profiling needs it.
    let mut decomposed = String::new();
    let mut origins: Vec<(usize, usize, usize)> = Vec::new();
    for (start, ch) in text.char_indices() {
        let end = start + ch.len_utf8();
        if is_default_ignorable(ch) {
            if let Some(last) = origins.last_mut() {
                last.2 = end;
            }
            continue;
        }
        origins.push((decomposed.len(), start, end));
        decompose_compatible(ch, |part| decomposed.push(part));
    }
    let mut normalized = String::new();
    let mut ranges: Vec<(usize, usize, usize)> = Vec::new();
    let mut first = 0;
    let mut last = 0;
    for (offset, cluster) in decomposed.grapheme_indices(true) {
        while first + 1 < origins.len() && origins[first + 1].0 <= offset {
            first += 1;
        }
        while last + 1 < origins.len() && origins[last + 1].0 < offset + cluster.len() {
            last += 1;
        }
        let (start, end) = (origins[first].1, origins[last].2);
        if ranges
            .last()
            .is_none_or(|&(_, a, b)| (a, b) != (start, end))
        {
            ranges.push((normalized.len(), start, end));
        }
        normalized.extend(cluster.nfkc());
    }
    split(&normalized, mode, &mut |token| {
        let first = ranges.partition_point(|&(offset, _, _)| offset <= token.start) - 1;
        let last = ranges.partition_point(|&(offset, _, _)| offset < token.end) - 1;
        emit(Token {
            text: Cow::Owned(token.text.into_owned()),
            start: ranges[first].1,
            end: ranges[last].2,
            colocated: token.colocated,
        })
    })
}

fn split<'a>(
    text: &'a str,
    mode: Mode,
    emit: &mut impl FnMut(Token<'a>) -> ControlFlow<()>,
) -> ControlFlow<()> {
    let mut chars = text.char_indices().peekable();
    let mut run_start: Option<usize> = None; // start of the non-CJK text not yet split into words
    while let Some((start, ch)) = chars.next() {
        if !is_cjk(ch) {
            run_start.get_or_insert(start);
            continue;
        }
        if let Some(run) = run_start.take() {
            words(text, run, start, emit)?;
        }
        let end = start + ch.len_utf8();
        // The end of the pair this character starts, if the mode uses pairs.
        let pair_end = if mode == Mode::Highlight {
            None
        } else {
            let mut next = chars.clone();
            if next.peek().is_some_and(|&(_, ch)| ch == '\r') {
                next.next();
                if next.peek().is_some_and(|&(_, ch)| ch == '\n') {
                    next.next();
                }
            } else if next.peek().is_some_and(|&(_, ch)| ch == '\n') {
                next.next();
            }
            next.next()
                .filter(|&(_, ch)| is_cjk(ch))
                .map(|(start, ch)| start + ch.len_utf8())
        };
        match (mode, pair_end) {
            (Mode::Document, Some(pair_end)) => {
                emit(cjk_token(text, start, end, false))?;
                emit(cjk_token(text, start, pair_end, true))?;
            }
            (Mode::Query, Some(pair_end)) => emit(cjk_token(text, start, pair_end, false))?,
            _ => emit(cjk_token(text, start, end, false))?,
        }
    }
    if let Some(run) = run_start {
        words(text, run, text.len(), emit)?;
    }
    ControlFlow::Continue(())
}

/// Letters of the scripts that are written without spaces between words. Script extensions
/// include marks shared by kana, such as the prolonged sound mark `ー`; the letter test keeps
/// CJK punctuation out.
pub(super) fn is_cjk(ch: char) -> bool {
    is_unified_ideograph(ch)
        || (!ch.is_ascii() && ch.is_alphabetic() && {
            let scripts = ch.script_extension();
            !scripts.is_common()
                && !scripts.is_inherited()
                && [
                    Script::Han,
                    Script::Hiragana,
                    Script::Katakana,
                    Script::Hangul,
                ]
                .into_iter()
                .any(|script| scripts.contains_script(script))
        })
}

/// The main block of Han characters, the common case: every code point in it is a letter that
/// NFKC leaves unchanged.
fn is_unified_ideograph(ch: char) -> bool {
    ('\u{4E00}'..='\u{9FFF}').contains(&ch)
}

fn cjk_token(text: &str, start: usize, end: usize, colocated: bool) -> Token<'_> {
    let token = &text[start..end];
    Token {
        text: if token.contains(['\r', '\n']) {
            Cow::Owned(token.replace(['\r', '\n'], ""))
        } else {
            Cow::Borrowed(token)
        },
        start,
        end,
        colocated,
    }
}

fn words<'a>(
    text: &'a str,
    start: usize,
    end: usize,
    emit: &mut impl FnMut(Token<'a>) -> ControlFlow<()>,
) -> ControlFlow<()> {
    let mut word_start = None;
    for (offset, ch) in text[start..end].char_indices().chain([(end - start, ' ')]) {
        if ch.is_alphanumeric() || (word_start.is_some() && is_combining_mark(ch)) {
            word_start.get_or_insert(start + offset);
        } else if let Some(word_start) = word_start.take() {
            emit(Token {
                text: fold(&text[word_start..start + offset]),
                start: word_start,
                end: start + offset,
                colocated: false,
            })?;
        }
    }
    ControlFlow::Continue(())
}

/// Lower case, preserving the borrowed path for already-lowercase ASCII.
fn fold(word: &str) -> Cow<'_, str> {
    if word.is_ascii() {
        if word.bytes().any(|byte| byte.is_ascii_uppercase()) {
            Cow::Owned(word.to_ascii_lowercase())
        } else {
            Cow::Borrowed(word)
        }
    } else {
        Cow::Owned(word.to_lowercase())
    }
}

/// Unicode 17.0 Default_Ignorable_Code_Point (DerivedCoreProperties.txt).
/// https://www.unicode.org/Public/17.0.0/ucd/DerivedCoreProperties.txt
fn is_default_ignorable(ch: char) -> bool {
    matches!(ch,
        '\u{00AD}' | '\u{034F}' | '\u{061C}' | '\u{115F}'..='\u{1160}'
        | '\u{17B4}'..='\u{17B5}' | '\u{180B}'..='\u{180F}' | '\u{200B}'..='\u{200F}'
        | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{206F}' | '\u{3164}'
        | '\u{FE00}'..='\u{FE0F}' | '\u{FEFF}' | '\u{FFA0}' | '\u{FFF0}'..='\u{FFF8}'
        | '\u{1BCA0}'..='\u{1BCA3}' | '\u{1D173}'..='\u{1D17A}' | '\u{E0000}'..='\u{E0FFF}'
    )
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    fn tokens(text: &str, mode: Mode) -> Vec<(String, usize, usize, bool)> {
        let mut out = Vec::new();
        let _ = tokenize(text, mode, &mut |token| {
            out.push((
                token.text.into_owned(),
                token.start,
                token.end,
                token.colocated,
            ));
            ControlFlow::Continue(())
        });
        out
    }

    fn texts(text: &str, mode: Mode) -> Vec<String> {
        tokens(text, mode)
            .into_iter()
            .map(|token| token.0)
            .collect()
    }

    #[test]
    fn is_cjk_excludes_common_and_inherited_scripts() {
        for ch in ['µ', 'ℂ', 'ʹ'] {
            assert!(!is_cjk(ch), "{ch}");
        }
        assert!(is_cjk('ー'));
        assert!(is_cjk('\u{323B0}'));
    }

    #[test]
    fn tokenizer_version_two_pins_unicode_tables_and_multilingual_tokens() {
        assert_eq!(crate::search::TOKENIZER_VERSION, 2);
        // Review tokens and bump TOKENIZER_VERSION when any Unicode table changes.
        assert_eq!(char::UNICODE_VERSION, (17, 0, 0));
        assert_eq!(unicode_normalization::UNICODE_VERSION, (17, 0, 0));
        assert_eq!(unicode_segmentation::UNICODE_VERSION, (17, 0, 0));
        assert_eq!(unicode_script::UNICODE_VERSION, (17, 0, 0));
        assert_eq!(
            texts("Ａ_B ℂ µm ⼤学 カ\u{200B}\u{3099} ㄱㅏ ゟ", Mode::Query),
            ["a", "b", "c", "μm", "大学", "学", "ガ", "가", "より", "り"]
        );
        assert_eq!(texts("x\0\u{345}", Mode::Query), ["x", "\u{345}"]);
        assert_eq!(texts("x \u{345}", Mode::Query), ["x", "\u{345}"]);
    }

    #[test]
    fn indexes_every_character_and_the_pair_it_starts() {
        assert_eq!(
            tokens("线性代数", Mode::Document),
            [
                ("线".into(), 0, 3, false),
                ("线性".into(), 0, 6, true),
                ("性".into(), 3, 6, false),
                ("性代".into(), 3, 9, true),
                ("代".into(), 6, 9, false),
                ("代数".into(), 6, 12, true),
                ("数".into(), 9, 12, false),
            ]
        );
    }

    #[test]
    fn highlights_every_character_without_the_pairs() {
        assert_eq!(
            tokens("线性代数 notes", Mode::Highlight),
            [
                ("线".into(), 0, 3, false),
                ("性".into(), 3, 6, false),
                ("代".into(), 6, 9, false),
                ("数".into(), 9, 12, false),
                ("notes".into(), 13, 18, false),
            ]
        );
    }

    #[test]
    fn queries_a_run_as_its_pairs_and_its_last_character() {
        assert_eq!(texts("线", Mode::Query), ["线"]);
        assert_eq!(texts("线代", Mode::Query), ["线代", "代"]);
        assert_eq!(
            texts("线性代数", Mode::Query),
            ["线性", "性代", "代数", "数"]
        );
    }

    #[test]
    fn splits_other_text_into_folded_words() {
        assert_eq!(
            texts("Hello, WORLD 2026!", Mode::Document),
            ["hello", "world", "2026"]
        );
        assert_eq!(texts("ＡＢＣ１２３", Mode::Document), ["abc123"]);
        assert_eq!(texts("Straße", Mode::Document), ["straße"]);
    }

    #[test]
    fn mixes_words_and_cjk_runs() {
        assert_eq!(
            texts("C语言 notes", Mode::Document),
            ["c", "语", "语言", "言", "notes"]
        );
        assert_eq!(
            texts("C语言 notes", Mode::Query),
            ["c", "语言", "言", "notes"]
        );
        // A single character between words stays a token in a query.
        assert_eq!(texts("第3章", Mode::Query), ["第", "3", "章"]);
    }

    #[test]
    fn keeps_kana_words_together_and_skips_punctuation() {
        assert_eq!(
            texts("コーヒー", Mode::Query),
            ["コー", "ーヒ", "ヒー", "ー"]
        );
        assert_eq!(texts("，。！「」", Mode::Document), Vec::<String>::new());
        assert_eq!(texts("线，代", Mode::Query), ["线", "代"]);
    }

    #[test]
    fn knows_recent_han_characters_and_folds_compatibility_forms() {
        // U+2EBF0 (Unicode 15.1) and U+31350 (Unicode 15.0).
        assert_eq!(
            texts("\u{2EBF0}\u{31350}", Mode::Query),
            ["\u{2EBF0}\u{31350}", "\u{31350}"]
        );
        // U+F900, a compatibility ideograph, is the same character as U+8C48.
        assert_eq!(texts("\u{F900}", Mode::Query), ["\u{8C48}"]);
    }

    #[test]
    fn stops_when_asked() {
        let mut seen = 0;
        let flow = tokenize("线性代数", Mode::Document, &mut |_| {
            seen += 1;
            if seen == 2 {
                ControlFlow::Break(())
            } else {
                ControlFlow::Continue(())
            }
        });
        assert!(flow.is_break());
        assert_eq!(seen, 2);
    }

    /// Any Unicode text, with extra characters from the scripts and forms the tokenizer treats
    /// specially.
    fn unicode_text() -> impl Strategy<Value = String> {
        let ch = prop_oneof![
            any::<char>(),
            prop::sample::select(vec![
                '线', '代', 'ー', 'ヒ', '한', 'Ａ', 'İ', '\u{F900}', '\u{301}', '\u{200D}', ' ',
                '，',
            ]),
        ];
        prop::collection::vec(ch, 0..24).prop_map(String::from_iter)
    }

    proptest! {
        #[test]
        fn token_text_matches_whole_text_normalization(text in unicode_text()) {
            let normalized: String = text.chars().filter(|&ch| !is_default_ignorable(ch)).nfkc().collect();
            for mode in [Mode::Document, Mode::Highlight, Mode::Query] {
                prop_assert_eq!(texts(&text, mode), texts(&normalized, mode));
            }
        }

        #[test]
        fn tokens_are_character_ranges_in_text_order(
            text in unicode_text(),
            mode in prop::sample::select(vec![Mode::Document, Mode::Highlight, Mode::Query]),
        ) {
            let mut previous: Option<(usize, usize)> = None; // the last token that is not colocated
            for (token, start, end, colocated) in tokens(&text, mode) {
                prop_assert!(!token.is_empty());
                prop_assert!(start < end);
                prop_assert!(text.is_char_boundary(start) && text.is_char_boundary(end));
                if colocated {
                    prop_assert_eq!(mode, Mode::Document);
                    prop_assert_eq!(Some(start), previous.map(|(start, _)| start));
                    continue;
                }
                if let Some((previous_start, previous_end)) = previous {
                    prop_assert!(previous_start <= start);
                    prop_assert!(previous_end <= end);
                    // Compatibility expansions can overlap even across words (a½b -> a1, 2b).
                    // SQLite merges their source ranges when highlighting.
                }
                previous = Some((start, end));
            }
        }

        #[test]
        fn highlight_tokens_are_the_document_tokens_without_pairs(text in unicode_text()) {
            let mut document = tokens(&text, Mode::Document);
            document.retain(|token| !token.3);
            prop_assert_eq!(tokens(&text, Mode::Highlight), document);
        }
    }
}
