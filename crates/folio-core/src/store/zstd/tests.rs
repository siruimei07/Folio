use proptest::prelude::*;

use super::*;
use crate::store::strategies::one_block_frame;

/// The shape of a frame made by hand from raw or RLE blocks, as generate.mjs's `handZstdFrame`
/// makes them for the pack vectors.
#[derive(Debug, Clone, Copy)]
struct Shape {
    /// The bytes of `Frame_Content_Size`: 0 (absent), 1 (a single-segment frame), 2, 4 or 8.
    content_size: u8,
    window_log: u8,
    /// A 2-byte `Dictionary_ID` when not 0.
    dictionary: u16,
    reserved: bool,
    /// One RLE block instead of raw blocks.
    rle: bool,
}

const SHAPE: Shape = Shape {
    content_size: 8,
    window_log: 21,
    dictionary: 0,
    reserved: false,
    rle: false,
};

const HELLO: &[u8] = b"hello\n";

/// `hello\n` with a checksum, made by Node 24.19.0's libzstd (generate.mjs's frozen
/// `blob hello with checksum`).
const HELLO_WITH_CHECKSUM: &str = "28b52ffd240631000068656c6c6f0a5388bd91";

fn unhex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap())
        .collect()
}

/// A block header (RFC 8878 §3.1.1.2): 3 bytes, little-endian.
fn block_header(size: usize, block_type: usize, last: bool) -> [u8; 3] {
    let header = (size << 3) | (block_type << 1) | usize::from(last);
    let bytes = header.to_le_bytes();
    [bytes[0], bytes[1], bytes[2]]
}

/// A frame of `content` in `shape`, byte for byte as `handZstdFrame` writes it.
fn hand_frame(content: &[u8], shape: Shape) -> Vec<u8> {
    let size_flag = match shape.content_size {
        0 | 1 => 0,
        2 => 1,
        4 => 2,
        8 => 3,
        other => panic!("no content size field of {other} bytes"),
    };
    let single = shape.content_size == 1;
    let descriptor = (size_flag << 6)
        | if single { 0x20 } else { 0 }
        | if shape.reserved { 0x08 } else { 0 }
        | if shape.dictionary != 0 { 0b10 } else { 0 };
    let mut frame = MAGIC.to_vec();
    frame.push(descriptor);
    if !single {
        frame.push((shape.window_log - 10) << 3);
    }
    if shape.dictionary != 0 {
        frame.extend_from_slice(&shape.dictionary.to_le_bytes());
    }
    let len = content.len();
    match shape.content_size {
        1 => frame.push(u8::try_from(len).unwrap()),
        2 => frame.extend_from_slice(&u16::try_from(len - 256).unwrap().to_le_bytes()),
        4 => frame.extend_from_slice(&u32::try_from(len).unwrap().to_le_bytes()),
        8 => frame.extend_from_slice(&(len as u64).to_le_bytes()),
        _ => {}
    }
    if shape.rle {
        frame.extend_from_slice(&block_header(len, 1, true));
        frame.push(content[0]);
        return frame;
    }
    let mut at = 0;
    loop {
        let size = (len - at).min(128 * 1024);
        let last = at + size == len;
        frame.extend_from_slice(&block_header(size, 0, last));
        frame.extend_from_slice(&content[at..at + size]);
        at += size;
        if last {
            return frame;
        }
    }
}

fn decoded(payload: &[u8], raw_length: u64) -> Result<Vec<u8>, ZstdProblem> {
    let mut out = Vec::new();
    decode_slice(payload, raw_length, |bytes| out.extend_from_slice(bytes))?;
    Ok(out)
}

/// Decodes as a caller that receives the payload `in_step` bytes at a time and decodes into a
/// buffer of `out_step` bytes, giving back what a call did not take.
fn decoded_in_pieces(
    payload: &[u8],
    raw_length: u64,
    in_step: usize,
    out_step: usize,
) -> Result<Vec<u8>, ZstdProblem> {
    let mut decoder = FrameDecoder::new(raw_length, payload.len() as u64);
    let mut out = Vec::new();
    let mut buffer = vec![0; out_step];
    let (mut start, mut available) = (0, in_step.min(payload.len()));
    loop {
        let progress = decoder.decode(&payload[start..available], &mut buffer)?;
        out.extend_from_slice(&buffer[..progress.produced]);
        start += progress.consumed;
        if progress == Progress::default() {
            if available == payload.len() {
                break;
            }
            available = (available + in_step).min(payload.len());
        }
    }
    decoder.finish()?;
    Ok(out)
}

/// Every way of cutting the input and output this test tries gives the same outcome.
fn decoded_every_way(payload: &[u8], raw_length: u64) -> Result<Vec<u8>, ZstdProblem> {
    let whole = decoded(payload, raw_length);
    for (in_step, out_step) in [(1, 1), (1, 1 << 20), (2, 3), (7, 5), (1 << 20, 1)] {
        assert_eq!(
            decoded_in_pieces(payload, raw_length, in_step, out_step),
            whole,
            "input in pieces of {in_step}, output in pieces of {out_step}"
        );
    }
    whole
}

/// The generator's hand-made frames (packs.json's variants) decode or are refused as the vectors
/// say: valid frames of every block and header kind, and one broken rule each.
#[test]
fn hand_made_frames_of_the_pack_vectors() {
    let frame = hand_frame(HELLO, SHAPE);
    let without_size = Shape {
        content_size: 0,
        ..SHAPE
    };
    let valid: [(&str, Vec<u8>, &[u8]); 7] = [
        ("raw blocks", frame.clone(), HELLO),
        ("no content size", hand_frame(HELLO, without_size), HELLO),
        (
            "single segment",
            hand_frame(
                HELLO,
                Shape {
                    content_size: 1,
                    ..SHAPE
                },
            ),
            HELLO,
        ),
        (
            "a window of 8 MiB",
            hand_frame(
                HELLO,
                Shape {
                    window_log: 23,
                    ..without_size
                },
            ),
            HELLO,
        ),
        (
            "an RLE block",
            hand_frame(b"aaaaaa", Shape { rle: true, ..SHAPE }),
            b"aaaaaa",
        ),
        ("empty content", hand_frame(b"", SHAPE), b""),
        ("a checksum", unhex(HELLO_WITH_CHECKSUM), HELLO),
    ];
    for (name, payload, content) in valid {
        assert_eq!(
            decoded_every_way(&payload, content.len() as u64).as_deref(),
            Ok(content),
            "{name}"
        );
    }
    let mut corrupt = frame.clone();
    corrupt[14] |= 0b100; // the block becomes "compressed", and its bytes are not
    let invalid: [(&str, Vec<u8>, u64, ZstdProblem); 9] = [
        (
            "content size mismatch",
            frame.clone(),
            5,
            ZstdProblem::ContentSize {
                stated: 6,
                raw_length: 5,
            },
        ),
        (
            "decoded size mismatch",
            hand_frame(HELLO, without_size),
            5,
            ZstdProblem::TooLong { raw_length: 5 },
        ),
        (
            "trailing bytes",
            [&frame[..], &[0]].concat(),
            6,
            ZstdProblem::TrailingBytes,
        ),
        (
            "dictionary",
            hand_frame(
                HELLO,
                Shape {
                    dictionary: 7,
                    ..SHAPE
                },
            ),
            6,
            ZstdProblem::Dictionary { id: 7 },
        ),
        (
            "window too large",
            hand_frame(
                HELLO,
                Shape {
                    window_log: 24,
                    ..without_size
                },
            ),
            6,
            ZstdProblem::Window { size: 1 << 24 },
        ),
        (
            "reserved bit",
            hand_frame(
                HELLO,
                Shape {
                    reserved: true,
                    ..SHAPE
                },
            ),
            6,
            ZstdProblem::ReservedBit,
        ),
        (
            "truncated header",
            frame[..9].to_vec(),
            6,
            ZstdProblem::TruncatedHeader,
        ),
        (
            "decoded size short",
            hand_frame(HELLO, without_size),
            7,
            ZstdProblem::TooShort {
                decoded: 6,
                raw_length: 7,
            },
        ),
        (
            "truncated block",
            frame[..frame.len() - 1].to_vec(),
            6,
            ZstdProblem::Truncated,
        ),
    ];
    for (name, payload, raw_length, problem) in invalid {
        assert_eq!(
            decoded_every_way(&payload, raw_length),
            Err(problem),
            "{name}"
        );
    }
    assert!(
        matches!(decoded(&corrupt, 6), Err(ZstdProblem::Data(_))),
        "corrupt block"
    );
}

#[test]
fn headers_state_window_dictionary_and_content_size() {
    let header = |shape: Shape| parse_header(&hand_frame(HELLO, shape)).unwrap();
    assert_eq!(
        header(SHAPE),
        FrameHeader {
            window: 1 << 21,
            dictionary: 0,
            content_size: Some(6),
        }
    );
    let single = header(Shape {
        content_size: 1,
        ..SHAPE
    });
    assert_eq!(single.window, 6, "a single segment's window is its content");
    assert_eq!(
        header(Shape {
            content_size: 0,
            ..SHAPE
        })
        .content_size,
        None
    );
    assert_eq!(
        header(Shape {
            dictionary: 0x1234,
            ..SHAPE
        })
        .dictionary,
        0x1234
    );
    // Content sizes in 2 bytes count from 256; 4 bytes as they are.
    let long = vec![b'x'; 300];
    for content_size in [2, 4] {
        let frame = hand_frame(
            &long,
            Shape {
                content_size,
                ..SHAPE
            },
        );
        assert_eq!(parse_header(&frame).unwrap().content_size, Some(300));
        assert_eq!(decoded_every_way(&frame, 300), Ok(long.clone()));
    }
    // A window descriptor's mantissa adds eighths of its base.
    let with_window = |descriptor: u8| {
        let mut frame = MAGIC.to_vec();
        frame.extend_from_slice(&[0x00, descriptor]);
        parse_header(&frame).unwrap().window
    };
    assert_eq!(with_window(13 << 3), MAX_WINDOW);
    assert_eq!(with_window((12 << 3) | 7), 7 * (1 << 20) + (1 << 19));
    assert_eq!(with_window((13 << 3) | 1), MAX_WINDOW + (1 << 20));
    assert_eq!(with_window(31 << 3), 1 << 41);
}

#[test]
fn headers_are_refused_before_zstd_reads_them() {
    let frame = hand_frame(HELLO, SHAPE);
    // Cut anywhere inside its 14 bytes, the header is truncated.
    for len in 0..14 {
        assert_eq!(
            decoded(&frame[..len], 6),
            Err(ZstdProblem::TruncatedHeader),
            "{len} bytes"
        );
    }
    assert_eq!(decoded(b"hello\n", 6), Err(ZstdProblem::Magic));
    assert_eq!(decoded(&[0x28, 0xb5, 0x00], 6), Err(ZstdProblem::Magic));
    // A skippable frame is not the one frame a payload must be.
    let skippable = [
        0x50, 0x2a, 0x4d, 0x18, 6, 0, 0, 0, b'h', b'e', b'l', b'l', b'o', b'\n',
    ];
    assert_eq!(decoded(&skippable, 6), Err(ZstdProblem::Magic));
    // A single-segment frame's window is its content: more than 8 MiB is refused unread.
    let single = |content: u32| {
        let mut frame = MAGIC.to_vec();
        frame.push(0b1010_0000); // 4-byte content size, single segment
        frame.extend_from_slice(&content.to_le_bytes());
        frame
    };
    let limit = u32::try_from(MAX_WINDOW).unwrap();
    assert_eq!(
        decoded(&single(limit + 1), u64::from(limit) + 1),
        Err(ZstdProblem::Window {
            size: MAX_WINDOW + 1
        })
    );
    // At 8 MiB the header passes; the frame then ends too soon.
    assert_eq!(
        decoded(&single(limit), MAX_WINDOW),
        Err(ZstdProblem::Truncated)
    );
    // The dictionary is checked before the window, the window before the content size.
    let all_wrong = hand_frame(
        HELLO,
        Shape {
            dictionary: 1,
            window_log: 24,
            ..SHAPE
        },
    );
    assert_eq!(
        decoded(&all_wrong, 5),
        Err(ZstdProblem::Dictionary { id: 1 })
    );
}

#[test]
fn unused_bits_and_a_zero_dictionary_are_accepted() {
    // Bit 4 of the descriptor is unused: a decoder must not interpret it.
    let mut frame = hand_frame(HELLO, SHAPE);
    frame[4] |= 0x10;
    assert_eq!(decoded_every_way(&frame, 6).as_deref(), Ok(HELLO));
    // A dictionary id of 0 means no dictionary (§9.3: absent or 0).
    let mut frame = MAGIC.to_vec();
    frame.extend_from_slice(&[0x21, 0x00, 6]); // 1-byte dictionary id, single segment
    frame.extend_from_slice(&block_header(6, 0, true));
    frame.extend_from_slice(HELLO);
    assert_eq!(parse_header(&frame).unwrap().dictionary, 0);
    assert_eq!(decoded_every_way(&frame, 6).as_deref(), Ok(HELLO));
}

/// A 4-byte dictionary id beside an 8-byte content size makes the longest header, 18 bytes: all
/// that the decoder holds before zstd reads anything.
#[test]
fn the_longest_header_has_a_four_byte_dictionary_id() {
    // Descriptor 0xc3: an 8-byte content size, a window descriptor, a 4-byte dictionary id.
    let header = |dictionary: u32| {
        let mut frame = MAGIC.to_vec();
        frame.extend_from_slice(&[0xc3, (21 - 10) << 3]);
        frame.extend_from_slice(&dictionary.to_le_bytes());
        frame.extend_from_slice(&(HELLO.len() as u64).to_le_bytes());
        frame
    };
    let blocks = [&block_header(HELLO.len(), 0, true)[..], HELLO].concat();
    let frame = [header(0), blocks.clone()].concat();
    assert_eq!(header(0).len(), MAX_HEADER_LEN);
    assert_eq!(
        parse_header(&frame).unwrap(),
        FrameHeader {
            window: 1 << 21,
            dictionary: 0,
            content_size: Some(6),
        }
    );
    assert_eq!(decoded_every_way(&frame, 6).as_deref(), Ok(HELLO));
    for len in 0..MAX_HEADER_LEN {
        assert_eq!(
            parse_header(&frame[..len]),
            Err(ZstdProblem::TruncatedHeader),
            "{len} bytes"
        );
    }
    // Each of the id's four bytes counts.
    let needs = [header(0x89ab_cdef), blocks].concat();
    assert_eq!(parse_header(&needs).unwrap().dictionary, 0x89ab_cdef);
    assert_eq!(
        decoded(&needs, 6),
        Err(ZstdProblem::Dictionary { id: 0x89ab_cdef })
    );
}

#[test]
fn nothing_may_follow_the_frame() {
    // A whole frame within the 18 bytes held for its header, then bytes after it.
    let single = hand_frame(
        HELLO,
        Shape {
            content_size: 1,
            ..SHAPE
        },
    );
    assert_eq!(single.len(), 15);
    for extra in [1, 3, 10] {
        let payload = [&single[..], &vec![0; extra]].concat();
        assert_eq!(
            decoded_every_way(&payload, 6),
            Err(ZstdProblem::TrailingBytes),
            "{extra} bytes after"
        );
    }
    let twice = [&single[..], &single[..]].concat();
    assert_eq!(decoded(&twice, 6), Err(ZstdProblem::TrailingBytes));
    assert_eq!(
        decoded(&twice, 12),
        Err(ZstdProblem::ContentSize {
            stated: 6,
            raw_length: 12
        })
    );
}

#[test]
fn checksums_and_blocks_are_zstd_s_to_check() {
    let mut frame = unhex(HELLO_WITH_CHECKSUM);
    let last = frame.len() - 1;
    frame[last] ^= 1;
    assert!(matches!(decoded(&frame, 6), Err(ZstdProblem::Data(_))));
    // Blocks of 128 KiB and more, raw.
    let content: Vec<u8> = (0..300 * 1024).map(|i| (i % 251) as u8).collect();
    let frame = hand_frame(&content, SHAPE);
    assert_eq!(decoded(&frame, content.len() as u64), Ok(content.clone()));
    assert_eq!(
        decoded_in_pieces(&frame, content.len() as u64, 4096, 1000),
        Ok(content)
    );
}

/// Decodes `frame` whole and in pieces of input and output of many sizes, room for the whole
/// content and more among them, and returns the one outcome every way gives.
fn decoded_with_any_room(frame: &[u8], raw_length: usize) -> Result<Vec<u8>, ZstdProblem> {
    let whole = decoded(frame, raw_length as u64);
    let mut rooms = vec![7, 4096, 64 * 1024, raw_length, raw_length + 1, 1 << 20];
    if raw_length <= 5_000 {
        rooms.push(1);
    }
    for in_step in [1, 7, frame.len(), 1 << 20] {
        for &room in &rooms {
            assert_eq!(
                decoded_in_pieces(frame, raw_length as u64, in_step, room),
                whole,
                "input in pieces of {in_step}, output in pieces of {room}"
            );
        }
    }
    whole
}

/// RFC 8878 holds every block to Block_Maximum_Size, the smaller of the window and 128 KiB: a raw
/// block's bytes and an RLE block's repeats (§3.1.1.2). A frame whose block breaks it is refused
/// however its bytes arrive and whatever room the output has: room for its whole content too, with
/// which libzstd's single-pass shortcut would take a frame held whole in one call and leave its
/// raw and RLE blocks unchecked (the audit's frame of 14 bytes, 5,000 repeats in a window of
/// 1 KiB). A block within the limit decodes every way.
#[test]
fn every_block_is_held_to_its_maximum_size_however_the_bytes_arrive() {
    assert_eq!(
        one_block_frame(5_000, 10, true),
        unhex("28b52ffd800088130000439c0061")
    );
    // The bytes of `a`, the window log (0: a single segment, whose window is its content), an
    // RLE block or a raw one, and whether the block is within its limit.
    let cases = [
        (1_024, 10, true, true),
        (1_025, 10, true, false),
        (5_000, 10, true, false),
        (16 * 1024, 14, true, true),
        (20_000, 14, true, false),
        (100_000, 0, true, true),
        (128 * 1024, 0, true, true),
        (128 * 1024 + 1, 0, true, false),
        (200_000, 0, true, false),
        (128 * 1024, 20, true, true),
        (128 * 1024 + 1, 20, true, false),
        (1_024, 10, false, true),
        (1_025, 10, false, false),
        (2_000, 10, false, false),
        (128 * 1024, 20, false, true),
        (128 * 1024 + 1, 20, false, false),
    ];
    for (count, window_log, rle, within) in cases {
        let frame = one_block_frame(count, window_log, rle);
        let outcome = decoded_with_any_room(&frame, count);
        let case = format!("{count} bytes, window log {window_log}, RLE {rle}");
        if within {
            assert_eq!(outcome, Ok(vec![b'a'; count]), "{case}");
        } else {
            assert!(
                matches!(outcome, Err(ZstdProblem::Data(_))),
                "{case}: {outcome:?}"
            );
        }
    }
}

#[test]
fn a_raw_length_is_never_an_allocation_size() {
    let frame = hand_frame(
        HELLO,
        Shape {
            content_size: 0,
            ..SHAPE
        },
    );
    let huge = (1 << 53) - 1;
    assert_eq!(
        decoded(&frame, huge),
        Err(ZstdProblem::TooShort {
            decoded: 6,
            raw_length: huge
        })
    );
}

/// Bytes that hardly compress: BLAKE3's extendable output.
fn noise(len: usize) -> Vec<u8> {
    let mut bytes = vec![0; len];
    blake3::Hasher::new()
        .update(b"noise")
        .finalize_xof()
        .fill(&mut bytes);
    bytes
}

/// Text that compresses: lines of a lecture.
fn text(len: usize) -> Vec<u8> {
    "# 第3讲 特征值\n特征值 λ 满足 det(A − λI) = 0。\n"
        .bytes()
        .cycle()
        .take(len)
        .collect()
}

/// A frame the compressor wrote meets §9.3: no dictionary, at most 8 MiB of window, the content
/// size stated and no checksum; and it decodes to its object.
fn check_compressed(raw: &[u8], frame: &[u8]) {
    let header = parse_header(frame).unwrap();
    assert_eq!(header.content_size, Some(raw.len() as u64));
    assert_eq!(check_header(&header, raw.len() as u64), Ok(()));
    assert_eq!(frame[4] & 0b100, 0, "no checksum");
    assert_eq!(decoded(frame, raw.len() as u64).as_deref(), Ok(raw));
}

#[test]
fn compressed_frames_meet_section_9_3() {
    let mut compressor = Compressor::new();
    for len in [1000, 4096, 200 * 1024] {
        let raw = text(len);
        let frame = compressor.compress(&raw).expect("text compresses");
        assert!(frame.len() < raw.len());
        check_compressed(&raw, &frame);
        assert_eq!(decoded_in_pieces(&frame, len as u64, 100, 333), Ok(raw));
    }
}

/// Around 8 MiB a frame stops being one segment, whose window is its content, and gets the window
/// of 8 MiB instead.
#[test]
fn windows_stay_within_8_mib_at_the_limit() {
    let mut compressor = Compressor::new();
    let limit = MAX_WINDOW as usize;
    for len in [limit - 1, limit, limit + 1] {
        let raw = text(len);
        let frame = compressor.compress(&raw).expect("text compresses");
        check_compressed(&raw, &frame);
        let window = parse_header(&frame).unwrap().window;
        if len > limit {
            assert_eq!(window, MAX_WINDOW, "{len} bytes");
        } else {
            assert!(window >= len as u64 && window <= MAX_WINDOW, "{len} bytes");
        }
    }
}

#[test]
fn objects_that_do_not_shrink_stay_raw() {
    let mut compressor = Compressor::new();
    assert_eq!(compressor.compress(b""), None);
    assert_eq!(compressor.compress(b"a"), None);
    assert_eq!(compressor.compress(&noise(4096)), None);
}

#[test]
fn a_frame_depends_only_on_its_object() {
    let (a, b) = (text(10_000), text(70_000));
    let alone = Compressor::new().compress(&a);
    let mut compressor = Compressor::new();
    let _ = compressor.compress(&b);
    assert_eq!(compressor.compress(&a), alone);
}

#[test]
fn problems_read_as_reasons() {
    assert_eq!(
        ZstdProblem::Window { size: 1 << 24 }.to_string(),
        "the zstd frame's window is 16777216 bytes, more than 8 MiB"
    );
    assert_eq!(
        ZstdProblem::TooShort {
            decoded: 6,
            raw_length: 7
        }
        .to_string(),
        "the zstd frame decodes to 6 bytes, not the raw length 7"
    );
    assert_eq!(
        ZstdProblem::Data("Data corruption detected".into()).to_string(),
        "zstd cannot decode the frame: Data corruption detected"
    );
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(48))]

    /// What the compressor writes decodes back however the bytes arrive.
    #[test]
    fn compressed_objects_round_trip(
        pieces in prop::collection::vec(
            prop::sample::select(vec!["a", "台", "\n", "λ", "0", " ", "😀"]),
            0..400,
        ),
        noise_len in 0..64_usize,
        steps in (1..40_usize, 1..40_usize),
    ) {
        let mut raw = pieces.concat().into_bytes().repeat(3);
        raw.extend_from_slice(&noise(noise_len));
        if let Some(frame) = Compressor::new().compress(&raw) {
            check_compressed(&raw, &frame);
            let pieces = decoded_in_pieces(&frame, raw.len() as u64, steps.0, steps.1);
            prop_assert_eq!(pieces.as_deref(), Ok(&raw[..]));
        }
    }

    /// Hand-made frames of any content and shape decode to their content.
    #[test]
    fn hand_made_frames_round_trip(
        content in prop::collection::vec(any::<u8>(), 1..600),
        content_size in prop::sample::select(vec![0_u8, 2, 4, 8]),
        window_log in 10..=23_u8,
        steps in (1..20_usize, 1..20_usize),
    ) {
        let content_size = if content_size == 2 && content.len() < 256 { 8 } else { content_size };
        let frame = hand_frame(&content, Shape { content_size, window_log, ..SHAPE });
        prop_assert_eq!(
            decoded_in_pieces(&frame, content.len() as u64, steps.0, steps.1),
            Ok(content.clone())
        );
    }

    /// A frame of one raw or RLE block decodes exactly when its block is within the smaller of its
    /// window and 128 KiB, and the same way whole and in pieces, with output room short of its
    /// content or beyond it.
    #[test]
    fn a_block_decodes_exactly_when_within_its_maximum_size(
        window_log in prop_oneof![Just(0_u8), 10..=17_u8],
        around in -2..=2_i64,
        rle in any::<bool>(),
        in_step in 1..64_usize,
        room in prop_oneof![Just(None), (64..8192_usize).prop_map(Some)],
    ) {
        const BLOCK_MAX: usize = 128 * 1024;
        let limit = if window_log == 0 { BLOCK_MAX } else { (1 << window_log).min(BLOCK_MAX) };
        let count = limit.checked_add_signed(isize::try_from(around).unwrap()).unwrap();
        let frame = one_block_frame(count, window_log, rle);
        let whole = decoded(&frame, count as u64);
        let room = room.unwrap_or(count + 1);
        prop_assert_eq!(&decoded_in_pieces(&frame, count as u64, in_step, room), &whole);
        if count <= limit {
            prop_assert_eq!(whole, Ok(vec![b'a'; count]));
        } else {
            prop_assert!(matches!(whole, Err(ZstdProblem::Data(_))), "{:?}", whole);
        }
    }

    /// Bytes after a frame's magic number never make the decoder panic, whatever the raw length.
    #[test]
    fn any_payload_is_decoded_or_refused(
        tail in prop::collection::vec(any::<u8>(), 0..64),
        raw_length in prop_oneof![0..64_u64, Just((1 << 53) - 1)],
        steps in (1..8_usize, 1..8_usize),
    ) {
        let payload = [&MAGIC[..], &tail].concat();
        let whole = decoded(&payload, raw_length);
        let pieces = decoded_in_pieces(&payload, raw_length, steps.0, steps.1);
        prop_assert_eq!(whole.is_ok(), pieces.is_ok());
        if let Ok(bytes) = whole {
            prop_assert_eq!(bytes.len() as u64, raw_length);
        }
    }
}
