use std::cmp::Ordering;

use super::{EntryId, EntrySort, PageRequest, SortKey};
use crate::meta::EntryKind;

pub(super) struct Key {
    pub id: EntryId,
    path: String,
    name: String,
    extension: String,
    folder: bool,
}

impl Key {
    pub fn new(id: i64, path: String, path_key: String, kind: EntryKind, sort: SortKey) -> Self {
        // The stored key already uses the same simple uppercase mapping as name_key().
        let mut name = path_key;
        if let Some(slash) = name.rfind('/') {
            name.replace_range(..=slash, "");
        }
        let extension = if sort == SortKey::FileType && kind == EntryKind::File {
            name.rsplit_once('.')
                .filter(|(stem, _)| !stem.is_empty())
                .map_or("", |(_, extension)| extension)
                .to_owned()
        } else {
            String::new()
        };
        Self {
            id: EntryId(id),
            path,
            name,
            extension,
            folder: kind == EntryKind::Folder,
        }
    }

    fn compare(&self, other: &Self, sort: EntrySort, folders_first: bool) -> Ordering {
        let natural = if sort.key == SortKey::FileType {
            self.extension
                .cmp(&other.extension)
                .then_with(|| natural(&self.name, &other.name))
        } else {
            natural(&self.name, &other.name)
        };
        let directed = if sort.descending {
            natural.reverse()
        } else {
            natural
        };
        (if folders_first {
            other.folder.cmp(&self.folder)
        } else {
            Ordering::Equal
        })
        .then(directed)
        .then(self.path.cmp(&other.path))
    }
}

/// Select just the page before sorting; no full-catalog O(n log n) sort or row hydration.
pub(super) fn page(
    keys: &mut [Key],
    sort: EntrySort,
    page: PageRequest,
    folders_first: bool,
) -> &mut [Key] {
    let start = (page.offset as usize).min(keys.len());
    if start == keys.len() || page.limit == 0 {
        return &mut keys[0..0];
    }
    let compare = |a: &Key, b: &Key| a.compare(b, sort, folders_first);
    if start > 0 {
        keys.select_nth_unstable_by(start, compare);
    }
    let remaining = &mut keys[start..];
    let len = (page.limit as usize).min(remaining.len());
    if len < remaining.len() {
        remaining.select_nth_unstable_by(len, compare);
    }
    let selected = &mut remaining[..len];
    selected.sort_unstable_by(compare);
    selected
}

/// Case keys with ASCII digit runs compared by value, without integer overflow.
pub(super) fn natural(a: &str, b: &str) -> Ordering {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    let (mut i, mut j) = (0, 0);
    while i < a.len() && j < b.len() {
        if a[i].is_ascii_digit() && b[j].is_ascii_digit() {
            let (mut a_end, mut b_end) = (i, j);
            while a_end < a.len() && a[a_end].is_ascii_digit() {
                a_end += 1;
            }
            while b_end < b.len() && b[b_end].is_ascii_digit() {
                b_end += 1;
            }
            while i < a_end && a[i] == b'0' {
                i += 1;
            }
            while j < b_end && b[j] == b'0' {
                j += 1;
            }
            let order = (a_end - i)
                .cmp(&(b_end - j))
                .then(a[i..a_end].cmp(&b[j..b_end]));
            if order != Ordering::Equal {
                return order;
            }
            (i, j) = (a_end, b_end);
        } else {
            let order = a[i].cmp(&b[j]);
            if order != Ordering::Equal {
                return order;
            }
            i += 1;
            j += 1;
        }
    }
    (a.len() - i).cmp(&(b.len() - j))
}
