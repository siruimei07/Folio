//! Content hashes (ADR-0003 §2).

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

#[cfg(test)]
mod tests {
    use super::*;

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
