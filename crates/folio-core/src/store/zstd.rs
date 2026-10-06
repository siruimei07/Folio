//! zstd frames in packs (remote-format.md §9.3). A compressed record's payload is exactly one zstd
//! frame (RFC 8878) without a dictionary, with a window of at most 8 MiB and, if it states one, a
//! content size equal to the record's raw length; it decodes to exactly the raw length, and nothing
//! follows it.
//!
//! libzstd checks a frame's blocks and its checksum: its streaming decoder holds every block to
//! RFC 8878's Block_Maximum_Size, the smaller of the window and 128 KiB, both a block's size (an
//! RLE block's repeats) and what it decodes to (§3.1.1.2). Its single-pass shortcut, which a call
//! takes when it holds a whole frame that states its content size and room for that content, does
//! not check raw and RLE blocks, so [`FrameDecoder`] never gives zstd a whole frame in one call:
//! whether a frame is valid depends on its bytes alone, never on the room a caller reads into. The
//! rest zstd does not check, or not before it allocates, and zstd-safe offers no
//! `ZSTD_getFrameHeader` without its experimental feature: so the header is parsed here and checked
//! before zstd reads anything, and [`FrameDecoder`] enforces the frame's end and the raw length
//! while it streams.
//!
//! This module shares its name with the zstd crate, which is therefore written `::zstd` here.

use ::zstd::stream::raw::{DParameter, Decoder, InBuffer, Operation, OutBuffer};
use ::zstd::zstd_safe::CParameter;

/// The magic number that starts every zstd frame (RFC 8878 §3.1.1): 0xFD2FB528, little-endian.
const MAGIC: [u8; 4] = [0x28, 0xb5, 0x2f, 0xfd];

/// The longest frame header with its magic: magic 4, descriptor 1, window descriptor 1,
/// dictionary id 4 and content size 8 bytes.
const MAX_HEADER_LEN: usize = 18;

/// log2 of [`MAX_WINDOW`]: the window log Folio compresses with, and the largest its decoder
/// accepts (versioning.md §18).
const WINDOW_LOG: u32 = 23;

/// The largest window a frame may have (§9.3): 8 MiB, the size RFC 8878 asks every decoder to
/// support.
pub(super) const MAX_WINDOW: u64 = 1 << WINDOW_LOG;

/// The zstd level Folio compresses with (§9.5).
const LEVEL: i32 = 3;

/// Why a compressed payload breaks remote-format.md §9.3. The reasons are for logs and tests.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ZstdProblem {
    /// The payload does not start with a zstd frame's magic number (a skippable frame included).
    #[error("the payload is not a zstd frame")]
    Magic,
    #[error("the payload ends inside its zstd frame header")]
    TruncatedHeader,
    /// The frame header descriptor's reserved bit is set.
    #[error("the zstd frame header sets its reserved bit")]
    ReservedBit,
    #[error("the zstd frame needs dictionary {id}")]
    Dictionary { id: u64 },
    #[error("the zstd frame's window is {size} bytes, more than 8 MiB")]
    Window { size: u64 },
    #[error("the zstd frame states {stated} bytes of content, not the raw length {raw_length}")]
    ContentSize { stated: u64, raw_length: u64 },
    /// libzstd refused the frame: a corrupt block, a wrong checksum. The text is zstd's.
    #[error("zstd cannot decode the frame: {0}")]
    Data(String),
    #[error("the payload ends inside its zstd frame")]
    Truncated,
    #[error("bytes follow the zstd frame")]
    TrailingBytes,
    #[error("the zstd frame decodes to more than the raw length {raw_length}")]
    TooLong { raw_length: u64 },
    #[error("the zstd frame decodes to {decoded} bytes, not the raw length {raw_length}")]
    TooShort { decoded: u64, raw_length: u64 },
}

/// The facts of a frame header that §9.3 restricts (RFC 8878 §3.1.1.1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FrameHeader {
    /// `Window_Size`; in a single-segment frame, the content size.
    window: u64,
    /// `Dictionary_ID`, 0 when the frame has none.
    dictionary: u64,
    /// `Frame_Content_Size`, when the frame states it.
    content_size: Option<u64>,
}

/// Reads the frame header at the start of `bytes`, which may go on past it.
fn parse_header(bytes: &[u8]) -> Result<FrameHeader, ZstdProblem> {
    match bytes.get(..MAGIC.len()) {
        Some(magic) if magic == MAGIC => {}
        Some(_) => return Err(ZstdProblem::Magic),
        None if MAGIC.starts_with(bytes) => return Err(ZstdProblem::TruncatedHeader),
        None => return Err(ZstdProblem::Magic),
    }
    let mut at = MAGIC.len();
    // The next `count` bytes as a little-endian number.
    let mut next = |count: usize| -> Result<u64, ZstdProblem> {
        let field = bytes
            .get(at..at + count)
            .ok_or(ZstdProblem::TruncatedHeader)?;
        at += count;
        Ok(field
            .iter()
            .rev()
            .fold(0, |value, &byte| (value << 8) | u64::from(byte)))
    };
    let descriptor = next(1)?;
    if descriptor & 0x08 != 0 {
        return Err(ZstdProblem::ReservedBit);
    }
    // Bit 4 is unused: RFC 8878 says a decoder must not interpret it, so it is ignored.
    let single_segment = descriptor & 0x20 != 0;
    let window_descriptor = if single_segment { None } else { Some(next(1)?) };
    let dictionary = next([0, 1, 2, 4][(descriptor & 0b11) as usize])?;
    let content_size = match descriptor >> 6 {
        0 if single_segment => Some(next(1)?),
        0 => None,
        1 => Some(next(2)? + 256),
        2 => Some(next(4)?),
        _ => Some(next(8)?),
    };
    let window = match window_descriptor {
        Some(descriptor) => {
            let base = 1_u64 << (10 + (descriptor >> 3));
            base + base / 8 * (descriptor & 0b111)
        }
        // A single-segment frame always states its content size, which is its window.
        None => content_size.unwrap_or_default(),
    };
    Ok(FrameHeader {
        window,
        dictionary,
        content_size,
    })
}

/// The rules of §9.3 a header must meet before zstd reads the frame, in generate.mjs's order.
fn check_header(header: &FrameHeader, raw_length: u64) -> Result<(), ZstdProblem> {
    if header.dictionary != 0 {
        return Err(ZstdProblem::Dictionary {
            id: header.dictionary,
        });
    }
    if header.window > MAX_WINDOW {
        return Err(ZstdProblem::Window {
            size: header.window,
        });
    }
    if let Some(stated) = header.content_size
        && stated != raw_length
    {
        return Err(ZstdProblem::ContentSize { stated, raw_length });
    }
    Ok(())
}

/// How far one [`FrameDecoder::decode`] call went.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub(super) struct Progress {
    /// Payload bytes taken from the input; the rest must be given again.
    pub(super) consumed: usize,
    /// Decoded bytes written to the start of the output.
    pub(super) produced: usize,
}

/// Decodes the zstd frame that is one record's payload (remote-format.md §9.3, §11 step 9) as it
/// streams by, in memory bounded by the 8 MiB window whatever the raw length.
///
/// Give it the payload's bytes in order with [`FrameDecoder::decode`], each call the bytes the
/// previous one did not take and then new ones, and call [`FrameDecoder::finish`] at the end: only
/// a finish that succeeds has checked the whole frame. The header is checked before zstd reads
/// anything; bytes after the frame's end and output beyond the raw length are refused as they
/// come, output short of it at the end. zstd never gets the whole frame in one call, so its
/// streaming checks apply to every frame (see the module's docs): the outcome is the same however
/// the payload arrives and whatever room the output has.
pub(super) struct FrameDecoder {
    zstd: Decoder<'static>,
    raw_length: u64,
    stored_length: u64,
    /// The payload's first bytes, held until the frame header in them is checked.
    head: [u8; MAX_HEADER_LEN],
    head_len: usize,
    /// How many of `head`'s bytes zstd has taken.
    head_fed: usize,
    checked: bool,
    /// Payload bytes taken from callers, `head` included.
    taken: u64,
    produced: u64,
    /// zstd reached the frame's end and handed over all of its output.
    finished: bool,
}

impl FrameDecoder {
    /// A decoder for a payload of `stored_length` bytes that must decode to `raw_length`, with a
    /// zstd context of its own.
    pub(super) fn new(raw_length: u64, stored_length: u64) -> Self {
        // Setting up fails only when zstd cannot allocate its context, which Rust treats as fatal
        // for its own allocations as well; the window log is within zstd's bounds.
        let mut zstd = Decoder::new().expect("zstd allocates a decoder");
        zstd.set_parameter(DParameter::WindowLogMax(WINDOW_LOG))
            .expect("zstd accepts a window log of 23");
        #[cfg(test)]
        CONTEXTS.set(CONTEXTS.get() + 1);
        Self::with_context(zstd, raw_length, stored_length)
    }

    /// The decoder for the next payload of `stored_length` bytes that must decode to
    /// `raw_length`, on this decoder's zstd context: reset, it keeps its parameters and the room
    /// it took for a window, so frames decoded one after another, as a pack's full check decodes
    /// them, pay for that room once (8 MiB for a frame that states no content size).
    pub(super) fn restart(mut self, raw_length: u64, stored_length: u64) -> Self {
        match self.zstd.reinit() {
            Ok(()) => Self::with_context(self.zstd, raw_length, stored_length),
            // A context that cannot be reset is not used again.
            Err(_) => Self::new(raw_length, stored_length),
        }
    }

    fn with_context(zstd: Decoder<'static>, raw_length: u64, stored_length: u64) -> Self {
        Self {
            zstd,
            raw_length,
            stored_length,
            head: [0; MAX_HEADER_LEN],
            head_len: 0,
            head_fed: 0,
            checked: false,
            taken: 0,
            produced: 0,
            finished: false,
        }
    }

    #[cfg(test)]
    pub(super) fn is_finished(&self) -> bool {
        self.finished
    }

    /// Decodes from the next payload bytes, `input`, into `output`. Input past the payload's
    /// length is not taken. A call that takes and writes nothing needs more input, or more output
    /// room if `output` was full.
    pub(super) fn decode(
        &mut self,
        input: &[u8],
        output: &mut [u8],
    ) -> Result<Progress, ZstdProblem> {
        let left = self.stored_length - self.taken;
        let input = &input[..input.len().min(usize::try_from(left).unwrap_or(usize::MAX))];
        let mut progress = Progress::default();
        if !self.checked {
            let needed = usize::try_from(self.stored_length)
                .map_or(MAX_HEADER_LEN, |stored| stored.min(MAX_HEADER_LEN));
            let take = (needed - self.head_len).min(input.len());
            self.head[self.head_len..self.head_len + take].copy_from_slice(&input[..take]);
            self.head_len += take;
            self.taken += take as u64;
            progress.consumed = take;
            if self.head_len < needed {
                return Ok(progress);
            }
            check_header(&parse_header(&self.head[..self.head_len])?, self.raw_length)?;
            self.checked = true;
        }
        loop {
            if self.finished {
                if self.head_fed < self.head_len || progress.consumed < input.len() {
                    return Err(ZstdProblem::TrailingBytes);
                }
                return Ok(progress);
            }
            if progress.produced == output.len() && self.produced < self.raw_length {
                return Ok(progress);
            }
            // The held header bytes go to zstd first, then the input. The first byte goes alone, so
            // that no call holds a whole frame, however short (see the module's docs).
            let head = self.head;
            let from_head = self.head_fed < self.head_len;
            let source = if from_head {
                let end = if self.head_fed == 0 { 1 } else { self.head_len };
                &head[self.head_fed..end]
            } else {
                &input[progress.consumed..]
            };
            let (consumed, produced, ended) =
                self.step(source, &mut output[progress.produced..])?;
            if from_head {
                self.head_fed += consumed;
            } else {
                progress.consumed += consumed;
                self.taken += consumed as u64;
            }
            progress.produced += produced;
            if ended {
                self.finished = true;
            } else if consumed == 0 && produced == 0 {
                return Ok(progress);
            }
        }
    }

    /// One call into zstd: the input it took, the output it wrote, and whether the frame ended.
    fn step(
        &mut self,
        source: &[u8],
        output: &mut [u8],
    ) -> Result<(usize, usize, bool), ZstdProblem> {
        let remaining = self.raw_length - self.produced;
        let mut input = InBuffer::around(source);
        // With the whole raw length decoded zstd may only end the frame: a byte it writes into
        // the probe is one too many.
        let mut probe = [0_u8; 1];
        let target: &mut [u8] = if remaining == 0 {
            &mut probe
        } else {
            let room = usize::try_from(remaining).map_or(output.len(), |r| r.min(output.len()));
            &mut output[..room]
        };
        let mut out = OutBuffer::around(target);
        // zstd reports a failed allocation the same way as bad data; with the window capped at
        // 8 MiB it needs little memory, so its errors are taken as the frame's.
        let hint = self
            .zstd
            .run(&mut input, &mut out)
            .map_err(|error| ZstdProblem::Data(error.to_string()))?;
        let written = out.pos();
        if remaining == 0 && written > 0 {
            return Err(ZstdProblem::TooLong {
                raw_length: self.raw_length,
            });
        }
        self.produced += written as u64;
        Ok((input.pos(), written, hint == 0))
    }

    /// Checks the end: the frame is complete, nothing follows it, and it decoded to exactly the
    /// raw length.
    pub(super) fn finish(&self) -> Result<(), ZstdProblem> {
        if !self.checked {
            return Err(ZstdProblem::TruncatedHeader);
        }
        if !self.finished {
            return Err(ZstdProblem::Truncated);
        }
        if self.head_fed < self.head_len || self.taken < self.stored_length {
            return Err(ZstdProblem::TrailingBytes);
        }
        if self.produced != self.raw_length {
            return Err(ZstdProblem::TooShort {
                decoded: self.produced,
                raw_length: self.raw_length,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
thread_local! {
    /// The zstd contexts [`FrameDecoder::new`] made on this thread.
    static CONTEXTS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// In tests, the zstd contexts made on this thread so far ([`FrameDecoder::new`]).
#[cfg(test)]
pub(super) fn contexts_made() -> usize {
    CONTEXTS.get()
}

/// Decodes `payload`, one record's whole compressed payload in memory, handing `out` the decoded
/// bytes in order, at most 64 KiB at a time whatever the raw length. For tests: packs are read
/// through `pack::ObjectReader`.
#[cfg(test)]
pub(super) fn decode_slice(
    payload: &[u8],
    raw_length: u64,
    mut out: impl FnMut(&[u8]),
) -> Result<(), ZstdProblem> {
    const CHUNK: usize = 64 * 1024;
    let mut decoder = FrameDecoder::new(raw_length, payload.len() as u64);
    let mut buffer = vec![0; usize::try_from(raw_length).map_or(CHUNK, |raw| raw.min(CHUNK))];
    let mut rest = payload;
    while !decoder.is_finished() {
        let progress = decoder.decode(rest, &mut buffer)?;
        out(&buffer[..progress.produced]);
        rest = &rest[progress.consumed..];
        if progress == Progress::default() {
            break;
        }
    }
    decoder.finish()
}

/// Compresses objects as Folio writes them (remote-format.md §9.5): zstd level 3, a window of at
/// most 8 MiB, the content size in the header and no checksum, so that every frame meets §9.3. One
/// compressor serves many objects; each frame depends only on its object.
pub(super) struct Compressor(::zstd::bulk::Compressor<'static>);

impl Compressor {
    pub(super) fn new() -> Self {
        // Setting up fails only when zstd cannot allocate, which Rust treats as fatal for its own
        // allocations as well; the parameters are within zstd's bounds.
        let mut inner = ::zstd::bulk::Compressor::new(LEVEL).expect("zstd allocates a compressor");
        for parameter in [
            CParameter::WindowLog(WINDOW_LOG),
            CParameter::ContentSizeFlag(true),
            CParameter::ChecksumFlag(false),
        ] {
            inner
                .set_parameter(parameter)
                .expect("the parameters are within zstd's bounds");
        }
        Self(inner)
    }

    /// The zstd frame of `raw`, or `None` when it would not be smaller: such an object is stored
    /// raw (§9.5).
    pub(super) fn compress(&mut self, raw: &[u8]) -> Option<Vec<u8>> {
        // The output buffer holds zstd's bound for the input, so only an allocation can fail.
        let frame = self
            .0
            .compress(raw)
            .expect("zstd compresses into a buffer of its bound");
        (frame.len() < raw.len()).then_some(frame)
    }
}

#[cfg(test)]
mod tests;
