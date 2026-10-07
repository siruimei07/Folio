//! Keys and the fingerprint (versioning.md §6.3, §6.5; ipc-m2.md §4, §5.1).
//!
//! - A change's key is its code and its main path: `fa:`, `fd:`, `fm:`, `da:`, `dd:` and the path,
//!   or for a move `fv<h>:` and `dv<h>:`, where `<h>` is 16 hexadecimal digits of the BLAKE3 hash
//!   of the path it moved from, so a move from elsewhere to the same path is another change. `:`
//!   is never in a path. Keys are opaque to the UI (ipc-m2.md §4).
//! - A metadata change's key is its subject: `t:` and the path of the entry whose tags changed;
//!   `s:` or `c:` and the path of a semester or course folder on the disk whose settings changed,
//!   or `sg:` or `cg:` and `HEAD`'s path when that folder is gone (a folder renamed onto the
//!   place of a deleted one gives both); `T:`, `L:` and `I:` for the tag definitions, the library
//!   settings and the ignore rules.
//! - The fingerprint is the sum, modulo 2^128, of the first 16 bytes (little-endian) of the BLAKE3
//!   hash of each term: every change with whether its item is includable, `<key>\nrequired` for
//!   every required item, every metadata change's key, and the key of every tag change shown on
//!   an item (`t:` and the entry's path). A sum needs no sorting, so the order of the terms never
//!   matters; keys never hold a line feed, so terms never meet.

use std::fmt;

use super::changes::Code;
use crate::paths::RelPath;

/// The key of the tag definitions' change.
pub(super) const TAG_DEFINITIONS_KEY: &str = "T:";
/// The key of the library settings' change.
pub(super) const LIBRARY_KEY: &str = "L:";
/// The key of the ignore rules' change.
pub(super) const IGNORE_KEY: &str = "I:";

/// The key of a change of the tags of the entry at `path`.
pub(super) fn tags_key(path: &RelPath) -> String {
    format!("t:{path}")
}

/// The key of a change of the settings of the semester (`course` false) or course at `path`:
/// on the disk when `gone` is false, else `HEAD`'s path of a folder the disk no longer has.
pub(super) fn settings_key(course: bool, gone: bool, path: &RelPath) -> String {
    let letters = match (course, gone) {
        (false, false) => "s",
        (false, true) => "sg",
        (true, false) => "c",
        (true, true) => "cg",
    };
    format!("{letters}:{path}")
}

/// The most characters a key may have: `LIMITS.keyChars` (ipc-m2.md §4.1). A move's key, the
/// longest, has 19 characters and a path of at most 32,767 UTF-16 code units.
pub const MAX_KEY_CHARS: usize = 32_800;

/// Hexadecimal digits of the origin in a move's key.
const ORIGIN_DIGITS: usize = 16;

/// The key of a change of `code` whose main path is `path`; `from` is where a move came from.
pub(super) fn change_key(code: Code, path: &RelPath, from: Option<&RelPath>) -> String {
    let mut key = String::with_capacity(path.as_str().len() + 3 + ORIGIN_DIGITS);
    key.push_str(code.letters());
    if let Some(from) = from {
        let digest = blake3::hash(from.as_str().as_bytes());
        key.push_str(&digest.to_hex()[..ORIGIN_DIGITS]);
    }
    key.push(':');
    key.push_str(path.as_str());
    key
}

/// The fingerprint of a workspace: 128 bits, shown as 32 lowercase hexadecimal digits, 32 zeros
/// when it has no term.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Hash)]
pub struct Fingerprint(u128);

impl Fingerprint {
    /// Counts a change with its key and whether its item is includable (ipc-m2.md §5.1).
    pub(super) fn add_change(&mut self, key: &str, includable: bool) {
        let flag: &[u8] = if includable { b"\n1" } else { b"\n0" };
        self.add(&[key.as_bytes(), flag]);
    }

    /// Counts that the item whose key is `key` is required: a selection includes it whatever it
    /// says, so becoming required changes what a selection commits.
    pub(super) fn add_required(&mut self, key: &str) {
        self.add(&[key.as_bytes(), b"\nrequired"]);
    }

    /// Counts a metadata change, or a tag change shown on an item, by its key.
    pub(super) fn add_key(&mut self, key: &str) {
        self.add(&[key.as_bytes()]);
    }

    /// Counts the term made of `parts`, one after the other.
    fn add(&mut self, parts: &[&[u8]]) {
        let mut hasher = blake3::Hasher::new();
        for part in parts {
            hasher.update(part);
        }
        let mut first = [0; 16];
        first.copy_from_slice(&hasher.finalize().as_bytes()[..16]);
        self.0 = self.0.wrapping_add(u128::from_le_bytes(first));
    }
}

impl fmt::Display for Fingerprint {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:032x}", self.0)
    }
}
