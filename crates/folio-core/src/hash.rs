//! Content hashes (ADR-0003 §2).

use std::io::{self, Read};
use std::sync::atomic::{AtomicBool, Ordering};

/// How many bytes [`ContentHash::read`] hashes between checks for cancellation.
const CHUNK: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("a content hash must be `b3:` and 64 lower-case hexadecimal digits")]
pub struct InvalidHash;

validated_string!(
    /// A file's content hash with its algorithm: `b3:` and the 64 lower-case hexadecimal digits of
    /// the BLAKE3-256 hash of its bytes. Stored opaque, so another algorithm can follow.
    ContentHash,
    InvalidHash,
    |text| match text.strip_prefix("b3:") {
        Some(digits) if digits.len() == 64 && crate::is_lower_hex(digits) => Ok(()),
        _ => Err(InvalidHash),
    }
);

impl ContentHash {
    pub fn of(bytes: &[u8]) -> Self {
        Self::from_digest(blake3::hash(bytes))
    }

    /// The hash of everything `reader` yields, or `None` if `cancel` was set meanwhile.
    /// `buffer` is scratch space, kept between calls so that hashing many small files does
    /// not allocate for each.
    pub fn read(
        mut reader: impl Read,
        cancel: &AtomicBool,
        buffer: &mut Vec<u8>,
    ) -> io::Result<Option<Self>> {
        buffer.resize(CHUNK, 0);
        let mut hasher = blake3::Hasher::new();
        loop {
            if cancel.load(Ordering::Relaxed) {
                return Ok(None);
            }
            match reader.read(buffer) {
                Ok(0) => return Ok(Some(Self::from_digest(hasher.finalize()))),
                Ok(read) => {
                    hasher.update(&buffer[..read]);
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(error) => return Err(error),
            }
        }
    }

    fn from_digest(digest: blake3::Hash) -> Self {
        Self(format!("b3:{}", digest.to_hex()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hashes_bytes_with_blake3() {
        // The empty input's digest from the BLAKE3 test vectors.
        let empty = "b3:af1349b9f5f9a1a6a0404dea36dcc9499bcb25c9adc112b7cc9a93cae41f3262";
        assert_eq!(ContentHash::of(b"").as_str(), empty);
        let bytes = vec![7; 3 * CHUNK + 5];
        let mut buffer = Vec::new();
        let read = ContentHash::read(&bytes[..], &AtomicBool::new(false), &mut buffer);
        assert_eq!(read.unwrap(), Some(ContentHash::of(&bytes)));
        let cancelled = ContentHash::read(&bytes[..], &AtomicBool::new(true), &mut buffer);
        assert_eq!(cancelled.unwrap(), None);
    }

    #[test]
    fn accepts_only_prefixed_lower_case_blake3_digests() {
        let digits = "0123456789abcdef".repeat(4);
        assert!(ContentHash::parse(&format!("b3:{digits}")).is_ok());
        for text in [
            digits.clone(),
            format!("b3:{}", digits.to_uppercase()),
            format!("b3:{}", &digits[1..]),
            format!("sha256:{digits}"),
        ] {
            assert_eq!(ContentHash::parse(&text), Err(InvalidHash), "{text}");
        }
    }
}
