use std::io::Cursor;
use std::sync::atomic::AtomicBool;
use std::time::{Duration, Instant};

use proptest::prelude::*;

use zip::CompressionMethod;

use super::*;
use crate::extract::testing::{Package, Repeating, paragraph};
use crate::extract::{MAX_EXPANDED, MAX_READ, READ_LIMIT};

const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// The body of a whole Markdown file holding `text`.
fn body(text: &str) -> Body {
    text_body("notes.md", text.as_bytes(), true)
}

fn text(text: &str) -> Body {
    Body::Text(text.to_owned())
}

/// `bytes` in base64 with padding, on one line.
fn encode(bytes: &[u8]) -> String {
    let mut encoded = String::new();
    for chunk in bytes.chunks(3) {
        let group = chunk.iter().enumerate().fold(0_u32, |group, (at, &byte)| {
            group | u32::from(byte) << (16 - 8 * at)
        });
        for at in 0..4 {
            if at <= chunk.len() {
                encoded.push(char::from(ALPHABET[(group >> (18 - 6 * at)) as usize & 63]));
            } else {
                encoded.push('=');
            }
        }
    }
    encoded
}

/// `len` bytes of noise (as a compressed image is) in base64, on one line.
fn noise(len: usize) -> String {
    let mut state = 0x9E37_79B9_7F4A_7C15_u64;
    let bytes = (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state.to_le_bytes()[0]
        })
        .collect::<Vec<_>>();
    encode(&bytes)
}

/// The first `len` characters of the base64 alphabet over and over: upper case, lower case and
/// digits once `len` passes 61.
fn cycle(len: usize) -> String {
    ALPHABET
        .iter()
        .cycle()
        .take(len)
        .map(|&b| char::from(b))
        .collect()
}

/// `encoded` in lines of `width` characters joined by `separator`.
fn wrap(encoded: &str, width: usize, separator: &str) -> String {
    encoded
        .as_bytes()
        .chunks(width)
        .map(|line| std::str::from_utf8(line).expect("base64 is ASCII"))
        .collect::<Vec<_>>()
        .join(separator)
}

fn patient(cancel: &AtomicBool) -> Control<'_> {
    Control {
        deadline: Instant::now() + Duration::from_secs(600),
        cancel,
    }
}

fn word(package: &Package) -> Result<Body, WordError> {
    let cancel = AtomicBool::new(false);
    word_body(Cursor::new(package.build()), &patient(&cancel))
}

fn utf16le(text: &str) -> Vec<u8> {
    let mut bytes = vec![0xFF, 0xFE];
    bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
    bytes
}

#[test]
fn a_text_file_is_its_text() {
    let notes = "# 线性代数\n\nEigenvalues and eigenvectors: Av = λv.\n";
    assert_eq!(body(notes), text(notes));
    // Decoded as the preview decodes: GBK, CRLF.
    let gbk = [0xCF, 0xDF, 0xD0, 0xD4, 0xB4, 0xFA, 0xCA, 0xFD, b'\r', b'\n'];
    assert_eq!(text_body("notes.txt", &gbk, true), text("线性代数\n"));
}

#[test]
fn a_file_without_text_has_no_body() {
    for bytes in [
        &b""[..],
        b" \n\t\r\n",
        b"\xEF\xBB\xBF",
        b"\xFF\xFE",
        // U+0000 and U+0001 after a byte order mark are text, but not words.
        b"\xFF\xFE\x00\x00\x01\x00",
    ] {
        assert_eq!(text_body("notes.md", bytes, true), Body::Empty, "{bytes:?}");
    }
    assert_eq!(body(&noise(600)), Body::Empty);
}

#[test]
fn binary_content_has_no_body() {
    let bytes = b"PK\x03\x04\x14\x00\x00\x00 not text";
    assert_eq!(text_body("data.json", bytes, true), Body::Binary);
    assert_eq!(text_body("data.json", bytes, false), Body::Binary);
}

#[test]
fn generated_files_are_skipped_unread() {
    // Content that would be binary shows that it is not decoded.
    let bytes = b"\x00\x01\x02";
    for name in ["jquery.min.js", "package-lock.json", "Cargo.lock"] {
        assert_eq!(text_body(name, bytes, true), Body::Skipped, "{name}");
        assert_eq!(text_body(name, b"{}", false), Body::Skipped, "{name}");
    }
}

#[test]
fn generated_names_are_min_stems_and_lockfiles_in_any_case() {
    for name in [
        "jquery.min.js",
        "JQUERY.MIN.JS",
        "style.Min.css",
        "lib.v2.min.mjs",
        ".min.js",
        "PACKAGE-LOCK.JSON",
        "cargo.lock",
        "Pipfile.lock",
        "pnpm-lock.yaml",
        "yarn.lock",
    ] {
        assert!(is_generated(name), "{name}");
    }
    for lockfile in LOCKFILES {
        assert!(is_generated(lockfile), "{lockfile}");
        assert!(is_generated(&lockfile.to_uppercase()), "{lockfile}");
    }
    for name in [
        "min.md",
        "admin.js",
        "minutes.min",
        "notes.mind.md",
        "min",
        "",
        "package.json",
        "package-lock.json.bak",
        "my-package-lock.json",
        "Cargo.toml",
        "lock",
    ] {
        assert!(!is_generated(name), "{name}");
    }
    assert_eq!(text_body("min.md", b"# min", true), text("# min"));
}

#[test]
fn base64_on_one_line_is_dropped() {
    let markdown = format!(
        "![plot](data:image/png;base64,{})\n\nThe plot shows 特征值.\n",
        noise(600)
    );
    assert_eq!(
        body(&markdown),
        text("![plot](data:image/png;base64,)\n\nThe plot shows 特征值.\n")
    );
    let html = format!(
        "<p>Figure 1</p><img alt=\"plot\" src=\"data:image/jpeg;base64,{}\"><p>线性</p>",
        noise(900)
    );
    assert_eq!(
        body(&html),
        text("<p>Figure 1</p><img alt=\"plot\" src=\"data:image/jpeg;base64,\"><p>线性</p>")
    );
}

#[test]
fn wrapped_base64_is_dropped_with_its_line_breaks() {
    let mail = format!(
        "Content-Transfer-Encoding: base64\n\n{}\n--boundary--\n",
        wrap(&noise(1000), 76, "\n")
    );
    assert_eq!(
        body(&mail),
        text("Content-Transfer-Encoding: base64\n\n\n--boundary--\n")
    );
    // A certificate in YAML: 64-character lines, indented.
    let yaml = format!("cert: |\n  {}\nname: tls\n", wrap(&noise(700), 64, "\n  "));
    assert_eq!(body(&yaml), text("cert: |\n  \nname: tls\n"));
    // CRLF breaks are line breaks once decoded.
    let crlf = format!("before\r\n{}\r\nafter", wrap(&noise(480), 76, "\r\n"));
    assert_eq!(body(&crlf), text("before\n\nafter"));
}

#[test]
fn a_full_last_line_takes_the_word_that_starts_the_next_line() {
    // 912 characters: twelve full lines, so the run goes on into "name".
    let encoded = noise(684);
    assert_eq!(encoded.len() % 76, 0);
    let yaml = format!("data: |\n{}\nname: tls\n", wrap(&encoded, 76, "\n"));
    assert_eq!(body(&yaml), text("data: |\n: tls\n"));
}

#[test]
fn base64_in_a_notebook_is_dropped_with_its_escapes() {
    let wrapped = format!(
        "{{\"data\": {{\"image/png\": \"{}\\n\", \"text/plain\": [\"<Figure size 640x480>\"]}}}}",
        wrap(&noise(1200), 76, "\\n")
    );
    assert_eq!(
        body(&wrapped),
        text("{\"data\": {\"image/png\": \"\\n\", \"text/plain\": [\"<Figure size 640x480>\"]}}")
    );
    let one_line = format!(
        "{{\"image/png\": \"{}\\n\", \"source\": [\"plt.plot(x, y)\\n\"]}}",
        noise(1200)
    );
    assert_eq!(
        body(&one_line),
        text("{\"image/png\": \"\\n\", \"source\": [\"plt.plot(x, y)\\n\"]}")
    );
}

#[test]
fn base64_needs_256_characters() {
    let short = format!("key {} end", cycle(255));
    assert_eq!(body(&short), text(&short));
    assert_eq!(body(&format!("key {} end", cycle(256))), text("key  end"));
}

#[test]
fn only_full_lines_continue_a_run() {
    // Lines of 59 base64 characters each: no run goes on past one line.
    let short_lines = wrap(&cycle(59 * 10), 59, "\n");
    assert_eq!(body(&short_lines), text(&short_lines));
    // Nine lines of 60 and a last one of 50.
    let full_lines = format!("a\n{}\nb", wrap(&cycle(60 * 10 - 10), 60, "\n"));
    assert_eq!(body(&full_lines), text("a\n\nb"));
    // A blank line ends a run, so two short runs stay.
    let two_runs = format!("{0}\n\n{0}", wrap(&cycle(200), 100, "\n"));
    assert_eq!(body(&two_runs), text(&two_runs));
}

#[test]
fn long_words_codes_and_urls_stay() {
    let lecture_list = (1..=100)
        .map(|n| format!("Lecture{n}"))
        .collect::<Vec<_>>()
        .join("\n");
    let kept = [
        "pneumonoultramicroscopicsilicovolcanoconiosis".repeat(7),
        "ACGT".repeat(100),
        "0123456789abcdef".repeat(20),
        "=".repeat(300),
        lecture_list,
        format!(
            "See https://example.com/courses/linear-algebra/lectures/2026/week-03/notes.html?\
             section=eigenvalues&lang=en&id={}#summary-of-the-proof",
            "a1B2c3D4".repeat(4)
        ),
        "https://docs.example.org/MATH201/Fall2026/Chapter3/Section2/Eigenvalues/Notes.pdf"
            .repeat(4),
    ];
    for text_kept in kept {
        assert_eq!(body(&text_kept), text(&text_kept), "{text_kept}");
    }
}

#[test]
fn a_text_body_is_cut_at_a_character_boundary() {
    let long = format!("{}代", "a".repeat(MAX_BODY_BYTES - 1));
    assert_eq!(body(&long), text(&long[..MAX_BODY_BYTES - 1]));
    // The cut counts the text left once base64 is dropped.
    let with_image = format!("{} {}", noise(3000), "b".repeat(MAX_BODY_BYTES + 10));
    let Body::Text(kept) = body(&with_image) else {
        panic!("a text body");
    };
    assert_eq!(kept.len(), MAX_BODY_BYTES);
    assert!(kept.starts_with(" bbb"));
    // The memory of the text cut off is given back.
    assert!(
        kept.capacity() < MAX_BODY_BYTES + 1024,
        "{}",
        kept.capacity()
    );
}

#[test]
fn a_prefix_drops_the_character_its_end_cuts() {
    // "abc" and the first two bytes of "代".
    let prefix = b"abc\xE4\xBB";
    assert_eq!(text_body("notes.md", prefix, false), text("abc"));
    assert_ne!(text_body("notes.md", prefix, true), text("abc"));
}

#[test]
fn a_utf16_prefix_of_the_read_limit_fills_the_body() {
    // UTF-16's worst case, ASCII: two bytes for each byte of text.
    let words = "Eigen ".repeat(READ_LIMIT / 6);
    let mut prefix = utf16le(&words);
    prefix.truncate(READ_LIMIT);
    assert_eq!(prefix.len(), READ_LIMIT);
    assert_eq!(
        text_body("notes.txt", &prefix, false),
        text(&words[..MAX_BODY_BYTES])
    );
    // Ending inside a surrogate pair, which is held back.
    let mut prefix = utf16le(&format!("{}😀", "x".repeat(MAX_BODY_BYTES + 2)));
    prefix.truncate(READ_LIMIT);
    assert_eq!(prefix.len(), READ_LIMIT);
    assert_eq!(
        text_body("notes.txt", &prefix, false),
        text(&"x".repeat(MAX_BODY_BYTES))
    );
}

#[test]
fn word_paragraphs_with_text_are_joined_by_a_blank_line() {
    let document = Package::docx(
        &[
            paragraph("线性代数"),
            "<w:p/>".to_owned(),
            paragraph(" \u{3000} "),
            "<w:p><w:r><w:tab/></w:r></w:p>".to_owned(),
            "<w:p><w:r><w:t>Line one</w:t><w:br/><w:t>Line two</w:t></w:r></w:p>".to_owned(),
            paragraph(&noise(600)),
            paragraph("Eigenvalues"),
        ]
        .concat(),
    );
    assert_eq!(
        word(&document).unwrap(),
        text("线性代数\n\nLine one\nLine two\n\nEigenvalues")
    );
}

#[test]
fn a_word_document_without_text_has_no_body() {
    for content in [
        "",
        "<w:p/><w:p/>",
        "<w:p><w:r><w:t xml:space=\"preserve\">  </w:t></w:r></w:p>",
    ] {
        assert_eq!(
            word(&Package::docx(content)).unwrap(),
            Body::Empty,
            "{content}"
        );
    }
}

#[test]
fn a_long_word_document_is_cut_at_a_character_boundary() {
    let paragraph_text = "线性代数".repeat(100);
    let count = MAX_BODY_BYTES / paragraph_text.len() + 10;
    let document = Package::docx(&paragraph(&paragraph_text).repeat(count));
    let whole = vec![paragraph_text.as_str(); count].join("\n\n");
    let Body::Text(kept) = word(&document).unwrap() else {
        panic!("a text body");
    };
    assert_eq!(kept, whole[..whole.floor_char_boundary(MAX_BODY_BYTES)]);
    assert!(kept.len() > MAX_BODY_BYTES - 4);
}

#[test]
fn word_failures_pass_through() {
    let cancel = AtomicBool::new(false);
    assert!(matches!(
        word_body(Cursor::new(b"not really a document"), &patient(&cancel)),
        Err(WordError::Invalid(_))
    ));
    let document = Package::docx(&paragraph("Eigenvalues")).build();
    let expired = Control {
        deadline: Instant::now(),
        cancel: &cancel,
    };
    assert!(matches!(
        word_body(Cursor::new(&document), &expired),
        Err(WordError::TimedOut)
    ));
    let cancelled = AtomicBool::new(true);
    assert!(matches!(
        word_body(Cursor::new(&document), &patient(&cancelled)),
        Err(WordError::Cancelled)
    ));
}

/// Asserts that `word_body` refused the document as too large, for the reason `detail`.
#[track_caller]
fn assert_refused_as_too_large(document: Repeating, detail: &str) {
    let cancel = AtomicBool::new(false);
    let result = word_body(document, &patient(&cancel));
    assert!(
        matches!(&result, Err(WordError::TooLarge(found)) if found == detail),
        "{result:?}, not {detail:?}"
    );
}

#[test]
fn a_word_body_reads_no_more_of_the_file_than_the_default_cap() {
    // Empty deflate blocks: stored blocks of no bytes, five bytes each that expand to nothing.
    let blocks = Repeating::new(
        CompressionMethod::Deflated,
        &[0x00, 0x00, 0x00, 0xFF, 0xFF],
        &[0x01, 0x00, 0x00, 0xFF, 0xFF],
        MAX_READ,
    );
    assert_refused_as_too_large(
        blocks,
        &format!("reading more than {MAX_READ} bytes of the file"),
    );
}

#[test]
fn a_word_body_expands_no_more_than_the_default_cap() {
    // A stored part of white space between empty elements, which the reader passes over.
    let mut pattern = b"<a/>".to_vec();
    pattern.resize(4096, b' ');
    let part = Repeating::new(
        CompressionMethod::Stored,
        &pattern,
        b"<a/>",
        MAX_EXPANDED + 1,
    );
    assert_refused_as_too_large(
        part,
        &format!("the parts expand to more than {MAX_EXPANDED} bytes"),
    );
}

/// Text of tokens too short to be base64 runs, joined by spaces and line breaks.
fn short_tokens() -> impl Strategy<Value = String> {
    prop::collection::vec(
        ("[A-Za-z0-9+/=]{1,59}", prop_oneof![Just(" "), Just("\n")]),
        0..40,
    )
    .prop_map(|tokens| {
        tokens
            .into_iter()
            .flat_map(|(token, separator)| [token, separator.to_owned()])
            .collect()
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(256))]

    #[test]
    fn text_bodies_are_bounded_and_never_blank(
        bytes in prop::collection::vec(any::<u8>(), 0..512),
        complete in any::<bool>(),
    ) {
        if let Body::Text(kept) = text_body("notes.md", &bytes, complete) {
            prop_assert!(kept.len() <= MAX_BODY_BYTES);
            prop_assert!(has_text(&kept));
        }
    }

    #[test]
    fn short_tokens_stay(tokens in short_tokens()) {
        prop_assert_eq!(without_base64_runs(&tokens), Cow::Borrowed(tokens.as_str()));
    }

    #[test]
    fn encoded_data_is_dropped_and_the_rest_kept(
        before in short_tokens(),
        after in short_tokens(),
        data in prop::collection::vec(any::<u8>(), 192..1200),
        layout in prop_oneof![Just(None), Just(Some("\n")), Just(Some("\\n")), Just(Some("\n    "))],
        width in 60_usize..=76,
    ) {
        let encoded = encode(&data);
        let mut run = Run::default();
        encoded.bytes().for_each(|byte| run.add(byte));
        prop_assume!(run.is_encoded());
        let encoded = match layout {
            Some(separator) => wrap(&encoded, width, separator),
            None => encoded,
        };
        let input = format!("{before} {encoded} {after}");
        prop_assert_eq!(without_base64_runs(&input), format!("{before}  {after}"));
    }
}
