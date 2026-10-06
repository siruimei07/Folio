//! Object ids (remote-format.md §4): BLAKE3 over an object's exact bytes, in hash mode for blobs
//! and in derive_key mode, with a context per kind, for trees and commits.

use std::fmt;
use std::io;
use std::str::FromStr;

use crate::hash::ContentHash;

use super::values::ValueError;

/// The derive_key context of tree ids, exactly as remote-format.md §4 writes it.
const TREE_CONTEXT: &str = "folio tree v1";

/// The derive_key context of commit ids.
const COMMIT_CONTEXT: &str = "folio commit v1";

/// The kind of an object, which is also its record type in a pack (remote-format.md §9.2).
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum ObjectKind {
    /// The raw bytes of one stored file version.
    Blob,
    /// One folder, as canonical JSON.
    Tree,
    /// One commit, as canonical JSON.
    Commit,
}

impl ObjectKind {
    pub const ALL: [Self; 3] = [Self::Blob, Self::Tree, Self::Commit];

    /// The kind's record type in a pack: 1 blob, 2 tree, 3 commit.
    pub const fn code(self) -> u8 {
        match self {
            Self::Blob => 1,
            Self::Tree => 2,
            Self::Commit => 3,
        }
    }

    /// The kind with this record type, or `None` for a type history format 1 does not know.
    pub const fn from_code(code: u8) -> Option<Self> {
        match code {
            1 => Some(Self::Blob),
            2 => Some(Self::Tree),
            3 => Some(Self::Commit),
            _ => None,
        }
    }

    /// The derive_key context of the kind's ids, or `None` for blobs, whose id is the plain
    /// BLAKE3 hash of their bytes: the file's content hash.
    pub const fn context(self) -> Option<&'static str> {
        match self {
            Self::Blob => None,
            Self::Tree => Some(TREE_CONTEXT),
            Self::Commit => Some(COMMIT_CONTEXT),
        }
    }

    /// The kind's name, for messages.
    pub const fn name(self) -> &'static str {
        match self {
            Self::Blob => "blob",
            Self::Tree => "tree",
            Self::Commit => "commit",
        }
    }
}

impl fmt::Display for ObjectKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.name())
    }
}

/// An object's id (remote-format.md §4): 32 bytes, written `b3:` and 64 lower-case hexadecimal
/// digits. Ids compare by their bytes, the order of a pack's index (§9.4); their text forms sort
/// the same way.
///
/// The same bytes as a blob, a tree and a commit have three different ids, so an id is only
/// meaningful with the kind of object it names.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct ObjectId([u8; ObjectId::LEN]);

impl ObjectId {
    /// The length of the binary form, as packs store it.
    pub const LEN: usize = 32;

    pub const fn from_bytes(bytes: [u8; Self::LEN]) -> Self {
        Self(bytes)
    }

    pub const fn as_bytes(&self) -> &[u8; Self::LEN] {
        &self.0
    }

    /// The id of an object of `kind` whose exact bytes are `bytes`.
    pub fn of(kind: ObjectKind, bytes: &[u8]) -> Self {
        match kind.context() {
            None => Self(*blake3::hash(bytes).as_bytes()),
            Some(context) => Self(blake3::derive_key(context, bytes)),
        }
    }

    /// Reads the text form: `b3:` and exactly 64 lower-case hexadecimal digits.
    pub fn parse(text: &str) -> Result<Self, ValueError> {
        let digits = text.strip_prefix("b3:").ok_or(ValueError::ObjectId)?;
        hex_32(digits).map(Self).ok_or(ValueError::ObjectId)
    }
}

/// The 32 bytes `digits` write: exactly 64 lower-case hexadecimal digits, as ids and pack names
/// are written.
pub(super) fn hex_32(digits: &str) -> Option<[u8; 32]> {
    if digits.len() != 64 {
        return None;
    }
    let mut bytes = [0; 32];
    for (byte, pair) in bytes.iter_mut().zip(digits.as_bytes().chunks_exact(2)) {
        *byte = (hex_digit(pair[0])? << 4) | hex_digit(pair[1])?;
    }
    Some(bytes)
}

/// The value of one lower-case hexadecimal digit.
fn hex_digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

impl fmt::Display for ObjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "b3:{}", blake3::Hash::from_bytes(self.0).to_hex())
    }
}

impl fmt::Debug for ObjectId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl FromStr for ObjectId {
    type Err = ValueError;

    fn from_str(text: &str) -> Result<Self, ValueError> {
        Self::parse(text)
    }
}

/// A blob's id is its content hash (remote-format.md §4), which the catalog keeps as text.
impl From<&ContentHash> for ObjectId {
    fn from(hash: &ContentHash) -> Self {
        // A ContentHash is always `b3:` and 64 lower-case hexadecimal digits; if it ever admits
        // another algorithm, this conversion must become fallible.
        Self::parse(hash.as_str()).expect("a content hash is the text form of a blob id")
    }
}

impl From<ObjectId> for ContentHash {
    fn from(id: ObjectId) -> Self {
        Self::try_from(id.to_string()).expect("an object id's text form is a content hash")
    }
}

/// Computes an object's id from its bytes as they stream by (remote-format.md §4, §9.5). A clone
/// keeps what the hasher has seen, so a writer can return to an earlier point.
#[derive(Clone)]
pub struct ObjectHasher {
    kind: ObjectKind,
    inner: blake3::Hasher,
}

impl ObjectHasher {
    pub fn new(kind: ObjectKind) -> Self {
        let inner = match kind.context() {
            None => blake3::Hasher::new(),
            Some(context) => blake3::Hasher::new_derive_key(context),
        };
        Self { kind, inner }
    }

    pub fn kind(&self) -> ObjectKind {
        self.kind
    }

    pub fn update(&mut self, bytes: &[u8]) -> &mut Self {
        self.inner.update(bytes);
        self
    }

    /// The id of the bytes seen so far. The hasher can go on: this does not consume it.
    pub fn finalize(&self) -> ObjectId {
        ObjectId(*self.inner.finalize().as_bytes())
    }
}

impl io::Write for ObjectHasher {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl fmt::Debug for ObjectHasher {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ObjectHasher")
            .field("kind", &self.kind)
            .finish_non_exhaustive()
    }
}

#[cfg(test)]
mod tests {
    use proptest::prelude::*;

    use super::*;

    /// The canonical bytes of the empty tree, `{"entries":[]}`, and their three ids
    /// (remote-format-vectors/v1/hashes.json, domain_separation).
    const EMPTY_TREE: &[u8] = br#"{"entries":[]}"#;
    const AS_BLOB: &str = "b3:17e235e6291b29a843c8ac8962bec2b1923e9d4ea624888548725e13141e8439";
    const AS_TREE: &str = "b3:9b8b2fc76f6386c5507b9f545e0c960472b47ae5c4a4a906b952377ff33460d3";
    const AS_COMMIT: &str = "b3:afd3360dd4bc0385163e79d92e47edc96c4521537c3822e3eb1c3e8c6709ed55";

    #[test]
    fn kinds_have_record_types_contexts_and_names() {
        let codes: Vec<_> = ObjectKind::ALL.iter().map(|kind| kind.code()).collect();
        assert_eq!(codes, [1, 2, 3]);
        for kind in ObjectKind::ALL {
            assert_eq!(ObjectKind::from_code(kind.code()), Some(kind));
        }
        for code in [0, 4, 0x81, 0xff] {
            assert_eq!(ObjectKind::from_code(code), None, "{code}");
        }
        assert_eq!(ObjectKind::Blob.context(), None);
        assert_eq!(ObjectKind::Tree.context(), Some("folio tree v1"));
        assert_eq!(ObjectKind::Commit.context(), Some("folio commit v1"));
        assert_eq!(ObjectKind::Commit.to_string(), "commit");
    }

    #[test]
    fn the_same_bytes_have_one_id_per_kind() {
        let ids = ObjectKind::ALL.map(|kind| ObjectId::of(kind, EMPTY_TREE).to_string());
        assert_eq!(ids, [AS_BLOB, AS_TREE, AS_COMMIT]);
    }

    #[test]
    fn reads_and_writes_only_the_exact_text_form() {
        let id = ObjectId::parse(AS_TREE).unwrap();
        assert_eq!(id, ObjectId::of(ObjectKind::Tree, EMPTY_TREE));
        assert_eq!(id.to_string(), AS_TREE);
        assert_eq!(format!("{id:?}"), AS_TREE);
        assert_eq!(AS_TREE.parse::<ObjectId>(), Ok(id));
        let digits = &AS_TREE[3..];
        for text in [
            digits.to_owned(),
            format!("B3:{digits}"),
            format!("b3:{}", digits.to_uppercase()),
            format!("b3:{}", &digits[1..]),
            format!("b3:{digits}0"),
            format!("b3:{}g", &digits[1..]),
            format!("b3: {}", &digits[1..]),
            format!("b3:{}é", &digits[2..]),
            String::new(),
        ] {
            assert_eq!(
                ObjectId::parse(&text),
                Err(ValueError::ObjectId),
                "{text:?}"
            );
        }
    }

    #[test]
    fn ids_sort_by_their_bytes_like_their_text() {
        let low = ObjectId::from_bytes([0; 32]);
        let mut bytes = [0; 32];
        bytes[31] = 1;
        let next = ObjectId::from_bytes(bytes);
        bytes[0] = 0xff;
        let high = ObjectId::from_bytes(bytes);
        assert!(low < next && next < high);
        assert!(low.to_string() < next.to_string() && next.to_string() < high.to_string());
        assert_eq!(high.as_bytes()[0], 0xff);
    }

    #[test]
    fn blob_ids_are_content_hashes() {
        let bytes = "# 第3讲 特征值\n".as_bytes();
        let hash = ContentHash::of(bytes);
        let id = ObjectId::of(ObjectKind::Blob, bytes);
        assert_eq!(ObjectId::from(&hash), id);
        assert_eq!(ContentHash::from(id), hash);
    }

    #[test]
    fn a_hasher_clone_keeps_what_it_has_seen() {
        let mut hasher = ObjectHasher::new(ObjectKind::Tree);
        hasher.update(&EMPTY_TREE[..5]);
        let checkpoint = hasher.clone();
        hasher.update(b"something else");
        let mut resumed = checkpoint;
        resumed.update(&EMPTY_TREE[5..]);
        assert_eq!(resumed.finalize().to_string(), AS_TREE);
        assert_eq!(resumed.kind(), ObjectKind::Tree);
        // Finalizing does not consume the hasher.
        assert_eq!(resumed.finalize(), resumed.finalize());
    }

    #[test]
    fn a_hasher_is_a_writer() {
        let mut hasher = ObjectHasher::new(ObjectKind::Commit);
        std::io::copy(&mut &EMPTY_TREE[..], &mut hasher).unwrap();
        assert_eq!(hasher.finalize().to_string(), AS_COMMIT);
    }

    proptest! {
        #[test]
        fn text_forms_round_trip(bytes in any::<[u8; 32]>()) {
            let id = ObjectId::from_bytes(bytes);
            prop_assert_eq!(ObjectId::parse(&id.to_string()), Ok(id));
        }

        /// Hashing in pieces gives the id of the whole, for every kind.
        #[test]
        fn streaming_ids_equal_whole_ids(
            bytes in prop::collection::vec(any::<u8>(), 0..3000),
            cuts in prop::collection::vec(any::<prop::sample::Index>(), 0..6),
        ) {
            let mut cuts: Vec<usize> = cuts.iter().map(|cut| cut.index(bytes.len() + 1)).collect();
            cuts.sort_unstable();
            cuts.push(bytes.len());
            for kind in ObjectKind::ALL {
                let mut hasher = ObjectHasher::new(kind);
                let mut start = 0;
                for &cut in &cuts {
                    hasher.update(&bytes[start..cut]);
                    start = cut;
                }
                prop_assert_eq!(hasher.finalize(), ObjectId::of(kind, &bytes));
            }
        }
    }
}
