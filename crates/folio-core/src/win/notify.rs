//! Change records as `ReadDirectoryChangesExW` returns them: `FILE_NOTIFY_EXTENDED_INFORMATION`
//! with file ids, or plain `FILE_NOTIFY_INFORMATION` (docs/specs/windows-adapter.md §5.1). Safe
//! code over bytes: a record that does not fit its buffer is an error.

use std::ffi::OsString;
use std::io;
use std::mem::offset_of;
use std::os::windows::ffi::OsStringExt;

use windows_sys::Win32::Storage::FileSystem::{
    FILE_ACTION_ADDED, FILE_ACTION_REMOVED, FILE_ACTION_RENAMED_NEW_NAME,
    FILE_ACTION_RENAMED_OLD_NAME, FILE_ATTRIBUTE_DIRECTORY, FILE_NOTIFY_EXTENDED_INFORMATION,
    FILE_NOTIFY_INFORMATION,
};

use super::chain::Chain;
use crate::watch::{Action, Record};

/// Where the fields of one kind of record are.
struct Layout {
    chain: Chain,
    action: usize,
    file_id: Option<usize>,
    attributes: Option<usize>,
}

const EXTENDED: Layout = Layout {
    chain: Chain {
        next: offset_of!(FILE_NOTIFY_EXTENDED_INFORMATION, NextEntryOffset),
        name_length: offset_of!(FILE_NOTIFY_EXTENDED_INFORMATION, FileNameLength),
        name: offset_of!(FILE_NOTIFY_EXTENDED_INFORMATION, FileName),
        what: "change records",
    },
    action: offset_of!(FILE_NOTIFY_EXTENDED_INFORMATION, Action),
    file_id: Some(offset_of!(FILE_NOTIFY_EXTENDED_INFORMATION, FileId)),
    attributes: Some(offset_of!(FILE_NOTIFY_EXTENDED_INFORMATION, FileAttributes)),
};

const PLAIN: Layout = Layout {
    chain: Chain {
        next: offset_of!(FILE_NOTIFY_INFORMATION, NextEntryOffset),
        name_length: offset_of!(FILE_NOTIFY_INFORMATION, FileNameLength),
        name: offset_of!(FILE_NOTIFY_INFORMATION, FileName),
        what: "change records",
    },
    action: offset_of!(FILE_NOTIFY_INFORMATION, Action),
    file_id: None,
    attributes: None,
};

/// The records in the bytes a read returned, extended ones with file ids or plain ones.
///
/// An extended record of a folder's modification is left out. NTFS sends one for a folder and
/// every folder above it whenever an entry in the folder changes, and the entry's own record says
/// what changed; scoping them would widen every change to its top-level folder. The folder's time
/// is caught up by the next scan that covers it. Plain records do not say what is a folder.
pub(super) fn records(buffer: &[u8], extended: bool) -> io::Result<Vec<Record>> {
    let layout = if extended { &EXTENDED } else { &PLAIN };
    let mut records = Vec::new();
    layout.chain.walk(buffer, |record| {
        let u32_at = |offset| u32::from_le_bytes(record.field(offset));
        let action = action(u32_at(layout.action));
        let folder = layout
            .attributes
            .is_some_and(|offset| u32_at(offset) & FILE_ATTRIBUTE_DIRECTORY != 0);
        if folder && action == Action::Modified {
            return Ok(());
        }
        let units: Vec<u16> = record.name().collect();
        records.push(Record {
            action,
            // A name cannot hold a backslash, so each one separates two names.
            path: units
                .split(|&unit| unit == u16::from(b'\\'))
                .map(OsString::from_wide)
                .collect(),
            file_id: layout
                .file_id
                .map(|offset| u64::from_le_bytes(record.field(offset))),
        });
        Ok(())
    })?;
    Ok(records)
}

/// `FILE_ACTION_MODIFIED`, and any action a later Windows adds, is scanned as a modification.
fn action(code: u32) -> Action {
    match code {
        FILE_ACTION_ADDED => Action::Added,
        FILE_ACTION_REMOVED => Action::Removed,
        FILE_ACTION_RENAMED_OLD_NAME => Action::RenamedFrom,
        FILE_ACTION_RENAMED_NEW_NAME => Action::RenamedTo,
        _ => Action::Modified,
    }
}

#[cfg(test)]
mod tests {
    use windows_sys::Win32::Storage::FileSystem::{FILE_ACTION_MODIFIED, FILE_ATTRIBUTE_ARCHIVE};

    use super::*;

    const FILE: u32 = FILE_ATTRIBUTE_ARCHIVE;
    const FOLDER: u32 = FILE_ATTRIBUTE_DIRECTORY;

    /// Records laid out as Windows lays them out: action, name, file id and attributes.
    fn buffer(layout: &Layout, records: &[(u32, &str, u64, u32)]) -> Vec<u8> {
        layout
            .chain
            .lay_out(records.iter().map(|&(action, name, file_id, attributes)| {
                let mut fields = vec![(layout.action, action.to_le_bytes().to_vec())];
                fields.extend(
                    layout
                        .file_id
                        .map(|offset| (offset, file_id.to_le_bytes().to_vec())),
                );
                fields.extend(
                    layout
                        .attributes
                        .map(|offset| (offset, attributes.to_le_bytes().to_vec())),
                );
                (name.encode_utf16().collect(), fields)
            }))
    }

    #[test]
    fn parses_extended_records_with_file_ids() {
        let records = records(
            &buffer(
                &EXTENDED,
                &[
                    // As NTFS reports a move from 秋\线代 to 秋\概率.
                    (FILE_ACTION_MODIFIED, r"秋\线代", 2, FOLDER),
                    (FILE_ACTION_MODIFIED, "秋", 1, FOLDER),
                    (
                        FILE_ACTION_REMOVED,
                        r"秋\线代\x.md",
                        0x25_0000_0007_7865,
                        FILE,
                    ),
                    (
                        FILE_ACTION_ADDED,
                        r"秋\概率\x.md",
                        0x25_0000_0007_7865,
                        FILE,
                    ),
                    (FILE_ACTION_MODIFIED, r"秋\概率", 3, FOLDER),
                    (FILE_ACTION_ADDED, r"秋\新", 4, FOLDER),
                    (FILE_ACTION_MODIFIED, r"秋\新\a.md", 5, FILE),
                    (9, "a new action", 6, FILE),
                ],
            ),
            true,
        )
        .unwrap();
        assert_eq!(
            records,
            [
                Record::at(Action::Removed, "秋/线代/x.md", Some(0x25_0000_0007_7865)),
                Record::at(Action::Added, "秋/概率/x.md", Some(0x25_0000_0007_7865)),
                Record::at(Action::Added, "秋/新", Some(4)),
                Record::at(Action::Modified, "秋/新/a.md", Some(5)),
                Record::at(Action::Modified, "a new action", Some(6)),
            ]
        );
    }

    #[test]
    fn parses_plain_records_without_ids() {
        let records = records(
            &buffer(
                &PLAIN,
                &[
                    (FILE_ACTION_RENAMED_OLD_NAME, r"a\x.txt", 0, 0),
                    (FILE_ACTION_RENAMED_NEW_NAME, r"a\y.txt", 0, 0),
                    (FILE_ACTION_MODIFIED, "a", 0, 0),
                ],
            ),
            false,
        )
        .unwrap();
        assert_eq!(
            records,
            [
                Record::at(Action::RenamedFrom, "a/x.txt", None),
                Record::at(Action::RenamedTo, "a/y.txt", None),
                // Plain records do not say what is a folder.
                Record::at(Action::Modified, "a", None),
            ]
        );
    }

    #[test]
    fn records_that_do_not_fit_are_errors() {
        let whole = buffer(
            &EXTENDED,
            &[
                (FILE_ACTION_ADDED, "a.txt", 1, FILE),
                (FILE_ACTION_ADDED, "b.txt", 2, FILE),
            ],
        );
        let invalid =
            |buffer: &[u8]| records(buffer, true).unwrap_err().kind() == io::ErrorKind::InvalidData;
        assert!(invalid(&whole[..whole.len() - 40]));
        assert!(invalid(&whole[..EXTENDED.chain.name + 3]));
        let mut overlapping = whole;
        overlapping[..4].copy_from_slice(&8u32.to_le_bytes());
        assert!(invalid(&overlapping));
    }
}
