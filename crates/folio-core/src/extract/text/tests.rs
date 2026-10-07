// Expected texts of the hand-picked byte sequences come from decode.ts's rule run by Chromium's
// TextDecoder (the preview's decoder), so these tests pin the two rules together.

use proptest::prelude::*;

use super::*;

/// "线性代数" in GBK, which GB18030 contains.
const GBK_LINEAR_ALGEBRA: &[u8] = &[0xCF, 0xDF, 0xD0, 0xD4, 0xB4, 0xFA, 0xCA, 0xFD];
/// U+20000 (𠀀), a GB18030 four-byte sequence.
const GB18030_U20000: &[u8] = &[0x95, 0x32, 0x82, 0x36];

fn text(text: &str, encoding: TextEncoding, line_endings: LineEndings) -> Decoded {
    Decoded::Text(TextFile {
        text: text.to_owned(),
        encoding,
        line_endings,
    })
}

fn utf16le(text: &str) -> Vec<u8> {
    let mut bytes = UTF16LE_BOM.to_vec();
    bytes.extend(text.encode_utf16().flat_map(u16::to_le_bytes));
    bytes
}

fn utf16be(text: &str) -> Vec<u8> {
    let mut bytes = UTF16BE_BOM.to_vec();
    bytes.extend(text.encode_utf16().flat_map(u16::to_be_bytes));
    bytes
}

fn with(prefix: &[u8], rest: &[u8]) -> Vec<u8> {
    [prefix, rest].concat()
}

#[test]
fn reads_utf8_without_a_byte_order_mark() {
    assert_eq!(
        decode("Linear algebra 线性代数 😀\n".as_bytes()),
        text(
            "Linear algebra 线性代数 😀\n",
            TextEncoding::Utf8,
            LineEndings::Lf
        )
    );
}

#[test]
fn reads_utf8_after_a_byte_order_mark_without_the_mark() {
    assert_eq!(
        decode(&with(UTF8_BOM, "线性代数".as_bytes())),
        text("线性代数", TextEncoding::Utf8Bom, LineEndings::None)
    );
    // A second mark is text.
    assert_eq!(
        decode(&[UTF8_BOM, UTF8_BOM, b"a"].concat()),
        text("\u{FEFF}a", TextEncoding::Utf8Bom, LineEndings::None)
    );
}

#[test]
fn replaces_malformed_utf8_after_a_byte_order_mark() {
    assert_eq!(
        decode(&with(UTF8_BOM, b"a\xFFb")),
        text("a\u{FFFD}b", TextEncoding::Utf8Bom, LineEndings::None)
    );
    // A cut character at the end of a whole file is one U+FFFD.
    assert_eq!(
        decode(&with(UTF8_BOM, &"线".as_bytes()[..2])),
        text("\u{FFFD}", TextEncoding::Utf8Bom, LineEndings::None)
    );
}

#[test]
fn reads_utf16_by_its_byte_order_mark() {
    let sample = "线性代数 😀\r\nnotes";
    let expected = "线性代数 😀\nnotes";
    assert_eq!(
        decode(&utf16le(sample)),
        text(expected, TextEncoding::Utf16Le, LineEndings::Crlf)
    );
    assert_eq!(
        decode(&utf16be(sample)),
        text(expected, TextEncoding::Utf16Be, LineEndings::Crlf)
    );
}

#[test]
fn an_odd_last_byte_of_utf16_is_replaced_in_a_file_and_dropped_in_a_prefix() {
    assert_eq!(
        decode(&[0xFF, 0xFE, 0x41]),
        text("\u{FFFD}", TextEncoding::Utf16Le, LineEndings::None)
    );
    assert_eq!(
        decode(&[0xFE, 0xFF, 0x00, 0x41, 0x00]),
        text("A\u{FFFD}", TextEncoding::Utf16Be, LineEndings::None)
    );
    assert_eq!(
        decode_prefix(&[0xFE, 0xFF, 0x00, 0x41, 0x00]),
        text("A", TextEncoding::Utf16Be, LineEndings::None)
    );
}

#[test]
fn a_cut_surrogate_pair_is_replaced_in_a_file_and_dropped_in_a_prefix() {
    let bytes = utf16le("a😀");
    for cut in [bytes.len() - 1, bytes.len() - 2, bytes.len() - 3] {
        assert_eq!(
            decode(&bytes[..cut]),
            text("a\u{FFFD}", TextEncoding::Utf16Le, LineEndings::None),
            "{cut}"
        );
        assert_eq!(
            decode_prefix(&bytes[..cut]),
            text("a", TextEncoding::Utf16Le, LineEndings::None),
            "{cut}"
        );
    }
    assert_eq!(
        decode_prefix(&bytes),
        text("a😀", TextEncoding::Utf16Le, LineEndings::None)
    );
}

#[test]
fn reads_gbk_and_gb18030_four_byte_sequences() {
    assert_eq!(
        decode(GBK_LINEAR_ALGEBRA),
        text("线性代数", TextEncoding::Gb18030, LineEndings::None)
    );
    assert_eq!(
        decode(&[&b"x "[..], GB18030_U20000, b"\r\n", GBK_LINEAR_ALGEBRA].concat()),
        text(
            "x \u{20000}\n线性代数",
            TextEncoding::Gb18030,
            LineEndings::Crlf
        )
    );
}

#[test]
fn reads_text_that_is_not_utf8_as_gb18030() {
    // Latin-1 "café au lait": the malformed sequence is replaced and the rest still reads.
    assert_eq!(
        decode(b"caf\xE9 au lait"),
        text(
            "caf\u{FFFD} au lait",
            TextEncoding::Gb18030,
            LineEndings::None
        )
    );
    // GB18030's own rules: 0x80 is the euro sign; a four-byte sequence that breaks off keeps
    // what follows the lead byte.
    assert_eq!(
        decode(&[0x80]),
        text("\u{20AC}", TextEncoding::Gb18030, LineEndings::None)
    );
    assert_eq!(
        decode(&[0x81, 0x30, 0x81, 0x41]),
        text(
            "\u{FFFD}0\u{4E04}",
            TextEncoding::Gb18030,
            LineEndings::None
        )
    );
    // The GB18030 byte order mark is text, not a mark.
    assert_eq!(
        decode(&[0x84, 0x31, 0x95, 0x33, 0x61]),
        text("\u{FEFF}a", TextEncoding::Gb18030, LineEndings::None)
    );
}

#[test]
fn a_nul_in_the_first_8_kib_means_binary() {
    assert_eq!(decode(b"\0"), Decoded::Binary);
    assert_eq!(decode(b"PK\x03\x04\0\0"), Decoded::Binary);
    let mut bytes = vec![b'a'; SNIFF_BYTES];
    bytes[SNIFF_BYTES - 1] = 0;
    assert_eq!(decode(&bytes), Decoded::Binary);
    assert_eq!(decode_prefix(&bytes), Decoded::Binary);
}

#[test]
fn a_nul_beyond_the_first_8_kib_is_text() {
    let mut bytes = vec![b'a'; SNIFF_BYTES];
    bytes.push(0);
    let Decoded::Text(file) = decode(&bytes) else {
        panic!("binary");
    };
    assert_eq!(file.encoding, TextEncoding::Utf8);
    assert!(file.text.ends_with("a\0"));
    // And in text that is not UTF-8.
    bytes.push(0xFF);
    let Decoded::Text(file) = decode(&bytes) else {
        panic!("binary");
    };
    assert_eq!(file.encoding, TextEncoding::Gb18030);
    assert!(file.text.ends_with("a\0\u{FFFD}"));
}

#[test]
fn a_file_with_a_byte_order_mark_is_text_whatever_it_holds() {
    assert_eq!(
        decode(&with(UTF8_BOM, b"a\0b")),
        text("a\0b", TextEncoding::Utf8Bom, LineEndings::None)
    );
    assert_eq!(
        decode(&utf16le("a\0b")),
        text("a\0b", TextEncoding::Utf16Le, LineEndings::None)
    );
    assert_eq!(
        decode(&utf16be("ab")),
        text("ab", TextEncoding::Utf16Be, LineEndings::None)
    );
}

#[test]
fn line_breaks_become_lf_and_are_reported() {
    let cases = [
        ("no break", "no break", LineEndings::None),
        ("a\nb\n", "a\nb\n", LineEndings::Lf),
        ("a\r\nb\r\n", "a\nb\n", LineEndings::Crlf),
        ("a\rb\r", "a\nb\n", LineEndings::Cr),
        ("a\r\nb\nc\rd", "a\nb\nc\nd", LineEndings::Mixed),
        ("a\r\r\nb\r", "a\n\nb\n", LineEndings::Mixed),
        ("\r\n\n", "\n\n", LineEndings::Mixed),
        ("线\r\n性", "线\n性", LineEndings::Crlf),
    ];
    for (bytes, expected, endings) in cases {
        assert_eq!(
            decode(bytes.as_bytes()),
            text(expected, TextEncoding::Utf8, endings),
            "{bytes:?}"
        );
    }
    assert_eq!(
        decode(&utf16le("a\rb")),
        text("a\nb", TextEncoding::Utf16Le, LineEndings::Cr)
    );
}

#[test]
fn a_prefix_drops_a_cut_utf8_character() {
    let bytes = "线性".as_bytes();
    for cut in 4..6 {
        assert_eq!(
            decode_prefix(&bytes[..cut]),
            text("线", TextEncoding::Utf8, LineEndings::None),
            "{cut}"
        );
    }
    assert_eq!(
        decode_prefix(bytes),
        text("线性", TextEncoding::Utf8, LineEndings::None)
    );
    // The same bytes as a whole file are not UTF-8, so they are GB18030, as in the preview.
    assert_eq!(
        decode(&bytes[..4]),
        text("\u{7EFE}\u{630E}", TextEncoding::Gb18030, LineEndings::None)
    );
}

#[test]
fn a_prefix_drops_a_cut_utf8_character_after_a_byte_order_mark() {
    assert_eq!(
        decode_prefix(&with(UTF8_BOM, &"a线".as_bytes()[..3])),
        text("a", TextEncoding::Utf8Bom, LineEndings::None)
    );
}

#[test]
fn a_prefix_drops_a_cut_gb18030_character() {
    // GBK: the lead byte of 代 after 线性.
    let gbk = &GBK_LINEAR_ALGEBRA[..5];
    assert_eq!(
        decode_prefix(gbk),
        text("线性", TextEncoding::Gb18030, LineEndings::None)
    );
    assert_eq!(
        decode(gbk),
        text("线性\u{FFFD}", TextEncoding::Gb18030, LineEndings::None)
    );
    // A four-byte sequence cut after one, two or three bytes.
    for cut in 1..4 {
        let bytes = with(b"a\xFF ", &GB18030_U20000[..cut]);
        assert_eq!(
            decode_prefix(&bytes),
            text("a\u{FFFD} ", TextEncoding::Gb18030, LineEndings::None),
            "{cut}"
        );
        assert_eq!(
            decode(&bytes),
            text(
                "a\u{FFFD} \u{FFFD}",
                TextEncoding::Gb18030,
                LineEndings::None
            ),
            "{cut}"
        );
    }
    assert_eq!(
        decode(&[0x61, 0x95, 0x32, 0x82]),
        text("a\u{FFFD}", TextEncoding::Gb18030, LineEndings::None)
    );
}

#[test]
fn a_prefix_ending_in_cr_counts_a_lone_cr() {
    assert_eq!(
        decode_prefix(b"a\r"),
        text("a\n", TextEncoding::Utf8, LineEndings::Cr)
    );
    assert_eq!(
        decode_prefix(b"a\r\nb\r"),
        text("a\nb\n", TextEncoding::Utf8, LineEndings::Mixed)
    );
}

#[test]
fn empty_input_is_empty_text() {
    for decoded in [decode(b""), decode_prefix(b"")] {
        assert_eq!(decoded, text("", TextEncoding::Utf8, LineEndings::None));
    }
    assert_eq!(
        decode(UTF8_BOM),
        text("", TextEncoding::Utf8Bom, LineEndings::None)
    );
    assert_eq!(
        decode(UTF16LE_BOM),
        text("", TextEncoding::Utf16Le, LineEndings::None)
    );
    assert_eq!(
        decode(UTF16BE_BOM),
        text("", TextEncoding::Utf16Be, LineEndings::None)
    );
    // Too short to be a mark: two GB18030 bytes.
    assert_eq!(
        decode(&UTF8_BOM[..2]),
        text("\u{9518}", TextEncoding::Gb18030, LineEndings::None)
    );
}

#[test]
fn decoding_is_pinned_to_extractor_version_one() {
    // Any change to the text these give changes search bodies: bump `extract::VERSION` and update
    // this test with it.
    assert_eq!(crate::extract::VERSION, 1);
    assert_eq!(
        decode(&[0xFE, 0xFE]),
        text("\u{E4C5}", TextEncoding::Gb18030, LineEndings::None)
    );
    assert_eq!(
        decode(b"\xEF\xBB\xBFa\r\n\xFF"),
        text("a\n\u{FFFD}", TextEncoding::Utf8Bom, LineEndings::Crlf)
    );
}

/// Bytes that reach every branch: marks, NUL, line breaks, lead and trail bytes of UTF-8, UTF-16
/// surrogates and GB18030's two- and four-byte sequences.
fn tricky_bytes(max: usize) -> impl Strategy<Value = Vec<u8>> {
    let byte = prop_oneof![
        3 => any::<u8>(),
        2 => prop::sample::select(vec![
            0x00, b'\n', b'\r', b'a', b'0', b'9', 0x80, 0x81, 0x95, 0xBB, 0xBF, 0xC2, 0xD8, 0xDC,
            0xE7, 0xEF, 0xF0, 0xFE, 0xFF,
        ]),
    ];
    let start = prop::sample::select(vec![&[][..], UTF8_BOM, UTF16LE_BOM, UTF16BE_BOM]);
    (start, prop::collection::vec(byte, 0..max)).prop_map(|(start, rest)| with(start, &rest))
}

/// Text that decodes to itself: valid UTF-8 without NUL or `\r`, not starting with U+FEFF.
fn plain_text() -> impl Strategy<Value = String> {
    any::<String>().prop_map(|text| {
        text.replace(['\0', '\r'], "")
            .trim_start_matches('\u{FEFF}')
            .to_owned()
    })
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(512))]

    #[test]
    fn never_panics_and_leaves_no_cr(bytes in tricky_bytes(48)) {
        for decoded in [decode(&bytes), decode_prefix(&bytes)] {
            if let Decoded::Text(file) = decoded {
                prop_assert!(!file.text.contains('\r'));
            }
        }
    }

    #[test]
    fn a_prefix_reads_as_the_start_of_the_whole(bytes in tricky_bytes(48), cut in any::<prop::sample::Index>()) {
        let prefix = &bytes[..cut.index(bytes.len() + 1)];
        if let (Decoded::Text(part), Decoded::Text(whole)) = (decode_prefix(prefix), decode(&bytes))
            && part.encoding == whole.encoding
        {
            prop_assert!(whole.text.starts_with(&part.text), "{part:?} {whole:?}");
        }
    }

    #[test]
    fn plain_utf8_reads_as_itself(text in plain_text()) {
        let endings = if text.contains('\n') { LineEndings::Lf } else { LineEndings::None };
        prop_assert_eq!(decode(text.as_bytes()), self::text(&text, TextEncoding::Utf8, endings));
    }

    #[test]
    fn a_prefix_of_utf8_reads_as_its_whole_characters(text in plain_text(), cut in any::<prop::sample::Index>()) {
        let cut = cut.index(text.len() + 1);
        let whole = (0..=cut).rev().find(|&at| text.is_char_boundary(at)).unwrap_or(0);
        let expected = &text[..whole];
        let endings = if expected.contains('\n') { LineEndings::Lf } else { LineEndings::None };
        prop_assert_eq!(
            decode_prefix(&text.as_bytes()[..cut]),
            self::text(expected, TextEncoding::Utf8, endings)
        );
    }
}
