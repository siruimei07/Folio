//! Directory listings as `GetFileInformationByHandleEx` returns them (`FILE_ID_EXTD_DIR_INFO`),
//! and the rules that turn Windows attributes into [`Metadata`] (docs/specs/windows-adapter.md
//! §3.1–§3.3). Safe code over bytes: a record that does not fit its buffer is an error.

use std::ffi::OsString;
use std::fmt::Write;
use std::io;
use std::mem::offset_of;
use std::os::windows::ffi::OsStringExt;

use windows_sys::Win32::Storage::FileSystem::{
    FILE_ATTRIBUTE_DIRECTORY, FILE_ATTRIBUTE_REPARSE_POINT, FILE_ID_EXTD_DIR_INFO,
};
use windows_sys::Win32::System::SystemServices::IO_REPARSE_TAG_AF_UNIX;

use crate::fs::{DirEntry, FileKind, Metadata, Presence};

/// Where the name starts: every fixed field comes before it.
const NAME: usize = offset_of!(FILE_ID_EXTD_DIR_INFO, FileName);

/// The bit that marks a reparse tag as naming another file, as symbolic links and junctions do
/// (`IsReparseTagNameSurrogate`).
const NAME_SURROGATE: u32 = 0x2000_0000;

/// The Unix epoch as a FILETIME: 100-nanosecond intervals since 1601.
const UNIX_EPOCH: i64 = 116_444_736_000_000_000;

/// Appends the entries of one listing buffer to `entries`, without `.` and `..`. `serial` is the
/// volume's serial number, part of every file id.
pub(super) fn entries(buffer: &[u8], serial: u64, entries: &mut Vec<DirEntry>) -> io::Result<()> {
    let mut start = 0;
    let mut units = Vec::new();
    loop {
        let record = buffer
            .get(start..)
            .filter(|record| record.len() >= NAME)
            .ok_or_else(|| malformed("a record runs past the buffer"))?;
        let field = |offset: usize, length: usize| &record[offset..offset + length];
        let u32_at = |offset| u32::from_le_bytes(field(offset, 4).try_into().expect("4 bytes"));
        let i64_at = |offset| i64::from_le_bytes(field(offset, 8).try_into().expect("8 bytes"));

        let next = u32_at(offset_of!(FILE_ID_EXTD_DIR_INFO, NextEntryOffset)) as usize;
        let name_length = u32_at(offset_of!(FILE_ID_EXTD_DIR_INFO, FileNameLength)) as usize;
        let name = record
            .get(NAME..NAME + name_length)
            .filter(|name| name.len().is_multiple_of(2))
            .ok_or_else(|| malformed("a name runs past its record"))?;
        if next != 0 && next < NAME + name_length {
            return Err(malformed("records overlap"));
        }
        units.clear();
        units.extend(
            name.chunks_exact(2)
                .map(|unit| u16::from_le_bytes([unit[0], unit[1]])),
        );
        let name = OsString::from_wide(&units);
        if name != "." && name != ".." {
            let size = u64::try_from(i64_at(offset_of!(FILE_ID_EXTD_DIR_INFO, EndOfFile)))
                .map_err(|_| malformed("a negative size"))?;
            let file_id = u128::from_le_bytes(
                field(offset_of!(FILE_ID_EXTD_DIR_INFO, FileId), 16)
                    .try_into()
                    .expect("16 bytes"),
            );
            entries.push(DirEntry {
                name,
                metadata: metadata(
                    u32_at(offset_of!(FILE_ID_EXTD_DIR_INFO, FileAttributes)),
                    u32_at(offset_of!(FILE_ID_EXTD_DIR_INFO, ReparsePointTag)),
                    size,
                    i64_at(offset_of!(FILE_ID_EXTD_DIR_INFO, LastWriteTime)),
                    i64_at(offset_of!(FILE_ID_EXTD_DIR_INFO, CreationTime)),
                    file_id_text(serial, file_id),
                ),
            });
        }
        if next == 0 {
            return Ok(());
        }
        start += next;
    }
}

fn malformed(what: &str) -> io::Error {
    io::Error::new(
        io::ErrorKind::InvalidData,
        format!("malformed directory listing: {what}"),
    )
}

/// What a file's attributes, reparse tag, size, times (FILETIMEs) and id say, the same way for
/// listings and open files.
pub(super) fn metadata(
    attributes: u32,
    reparse_tag: u32,
    size: u64,
    modified: i64,
    created: i64,
    file_id: String,
) -> Metadata {
    Metadata::new(
        kind(attributes, reparse_tag),
        size,
        unix_ns(modified),
        unix_ns(created),
        Some(file_id),
        Presence::of_attributes(attributes),
    )
}

/// As std decides it, except that an `AF_UNIX` socket, which std calls a file, is `Other`:
/// reading it would fail on every hashing run.
fn kind(attributes: u32, reparse_tag: u32) -> FileKind {
    // The tag means something only on a reparse point.
    if attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
        if reparse_tag & NAME_SURROGATE != 0 {
            return FileKind::Link;
        }
        if reparse_tag == IO_REPARSE_TAG_AF_UNIX {
            return FileKind::Other;
        }
    }
    if attributes & FILE_ATTRIBUTE_DIRECTORY != 0 {
        FileKind::Folder
    } else {
        FileKind::File
    }
}

/// Nanoseconds since the Unix epoch, exactly as `fs::unix_ns` gives them for the `SystemTime`
/// std makes of the same FILETIME: `None` outside the range of `i64`.
fn unix_ns(filetime: i64) -> Option<i64> {
    filetime.checked_sub(UNIX_EPOCH)?.checked_mul(100)
}

/// The text of a file id: the volume's serial number and the file's id, in hexadecimal
/// (docs/specs/windows-adapter.md §3.3).
pub(super) fn file_id_text(serial: u64, file_id: u128) -> String {
    let mut text = String::with_capacity(49);
    write!(text, "{serial:x}-{file_id:x}").expect("writing to a String cannot fail");
    text
}

#[cfg(test)]
mod tests {
    use std::time::{Duration, SystemTime};

    use windows_sys::Win32::Storage::FileSystem::FILE_ATTRIBUTE_ARCHIVE;
    use windows_sys::Win32::System::SystemServices::{
        IO_REPARSE_TAG_CLOUD_6, IO_REPARSE_TAG_MOUNT_POINT, IO_REPARSE_TAG_SYMLINK,
    };

    use super::*;

    /// A WSL symbolic link, which windows-sys does not name.
    const IO_REPARSE_TAG_LX_SYMLINK: u32 = 0xA000_001D;

    /// A record to lay out as Windows does.
    struct Record {
        name: Vec<u16>,
        attributes: u32,
        size: i64,
        file_id: u128,
    }

    impl Record {
        fn new(name: &str, attributes: u32, size: i64, file_id: u128) -> Self {
            Self {
                name: name.encode_utf16().collect(),
                attributes,
                size,
                file_id,
            }
        }
    }

    /// The records in one buffer, each padded to 8 bytes as Windows pads them.
    fn buffer(records: &[Record]) -> Vec<u8> {
        let mut buffer = Vec::new();
        for (index, record) in records.iter().enumerate() {
            let start = buffer.len();
            buffer.resize(start + NAME, 0);
            let name_bytes = record.name.len() as u32 * 2;
            let fields: [(usize, &[u8]); 6] = [
                (
                    offset_of!(FILE_ID_EXTD_DIR_INFO, FileAttributes),
                    &record.attributes.to_le_bytes(),
                ),
                (
                    offset_of!(FILE_ID_EXTD_DIR_INFO, EndOfFile),
                    &record.size.to_le_bytes(),
                ),
                (
                    offset_of!(FILE_ID_EXTD_DIR_INFO, LastWriteTime),
                    &(UNIX_EPOCH + 20).to_le_bytes(),
                ),
                (
                    offset_of!(FILE_ID_EXTD_DIR_INFO, CreationTime),
                    &(UNIX_EPOCH + 10).to_le_bytes(),
                ),
                (
                    offset_of!(FILE_ID_EXTD_DIR_INFO, FileId),
                    &record.file_id.to_le_bytes(),
                ),
                (
                    offset_of!(FILE_ID_EXTD_DIR_INFO, FileNameLength),
                    &name_bytes.to_le_bytes(),
                ),
            ];
            for (offset, bytes) in fields {
                buffer[start + offset..start + offset + bytes.len()].copy_from_slice(bytes);
            }
            buffer.extend(record.name.iter().flat_map(|unit| unit.to_le_bytes()));
            buffer.resize(buffer.len().next_multiple_of(8), 0);
            if index + 1 < records.len() {
                let next = (buffer.len() - start) as u32;
                buffer[start..start + 4].copy_from_slice(&next.to_le_bytes());
            }
        }
        buffer
    }

    fn parse(buffer: &[u8]) -> io::Result<Vec<DirEntry>> {
        let mut out = Vec::new();
        entries(buffer, 0x141e_bf09_1ebe_e2c2, &mut out)?;
        Ok(out)
    }

    #[test]
    fn parses_records_and_skips_the_dot_entries() {
        let entries = parse(&buffer(&[
            Record::new(".", FILE_ATTRIBUTE_DIRECTORY, 0, 1),
            Record::new("..", FILE_ATTRIBUTE_DIRECTORY, 0, 2),
            Record::new("笔记.md", FILE_ATTRIBUTE_ARCHIVE, 12, 0x70_0000_0002_73ee),
            Record::new("作业", FILE_ATTRIBUTE_DIRECTORY, 4096, 3),
        ]))
        .unwrap();

        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "笔记.md");
        assert_eq!(
            entries[0].metadata,
            Metadata {
                kind: FileKind::File,
                size: 12,
                modified_ns: Some(2_000),
                created_ns: Some(1_000),
                file_id: Some("141ebf091ebee2c2-700000000273ee".to_owned()),
                presence: Presence::Local,
            }
        );
        assert_eq!(entries[1].name, "作业");
        assert_eq!(
            (entries[1].metadata.kind, entries[1].metadata.size),
            (FileKind::Folder, 0)
        );
    }

    #[test]
    fn keeps_names_that_are_not_unicode() {
        let mut record = Record::new("", FILE_ATTRIBUTE_ARCHIVE, 1, 9);
        record.name = vec![0x66, 0xD800];
        let entries = parse(&buffer(&[record])).unwrap();
        assert_eq!(entries[0].name, OsString::from_wide(&[0x66, 0xD800]));
        assert_eq!(entries[0].name.to_str(), None);
    }

    #[test]
    fn records_that_do_not_fit_are_errors() {
        let whole = buffer(&[
            Record::new("a.txt", FILE_ATTRIBUTE_ARCHIVE, 1, 1),
            Record::new("b.txt", FILE_ATTRIBUTE_ARCHIVE, 1, 2),
        ]);
        let invalid =
            |buffer: &[u8]| parse(buffer).unwrap_err().kind() == io::ErrorKind::InvalidData;

        // Cut inside the second record's fixed fields, then inside the first record's name.
        assert!(invalid(&whole[..whole.len() - 40]));
        assert!(invalid(&whole[..NAME + 3]));
        // The next record starts inside this one.
        let mut overlapping = whole.clone();
        overlapping[..4].copy_from_slice(&8u32.to_le_bytes());
        assert!(invalid(&overlapping));
        // A name of an odd number of bytes.
        let mut odd = whole.clone();
        let length = offset_of!(FILE_ID_EXTD_DIR_INFO, FileNameLength);
        odd[length..length + 4].copy_from_slice(&3u32.to_le_bytes());
        assert!(invalid(&odd));
        // A negative size.
        let mut negative = whole;
        let size = offset_of!(FILE_ID_EXTD_DIR_INFO, EndOfFile);
        negative[size..size + 8].copy_from_slice(&(-1i64).to_le_bytes());
        assert!(invalid(&negative));
    }

    #[test]
    fn kinds_follow_attributes_and_tags() {
        let reparse = FILE_ATTRIBUTE_REPARSE_POINT;
        let directory = FILE_ATTRIBUTE_DIRECTORY;
        for (attributes, tag, expected) in [
            (FILE_ATTRIBUTE_ARCHIVE, 0, FileKind::File),
            (directory, 0, FileKind::Folder),
            (
                directory | reparse,
                IO_REPARSE_TAG_MOUNT_POINT,
                FileKind::Link,
            ),
            (reparse, IO_REPARSE_TAG_SYMLINK, FileKind::Link),
            (reparse, IO_REPARSE_TAG_LX_SYMLINK, FileKind::Link),
            (reparse, IO_REPARSE_TAG_AF_UNIX, FileKind::Other),
            // Cloud placeholders, once their reparse points are exposed.
            (reparse, IO_REPARSE_TAG_CLOUD_6, FileKind::File),
            (
                directory | reparse,
                IO_REPARSE_TAG_CLOUD_6,
                FileKind::Folder,
            ),
            // Without the reparse attribute the tag field means nothing.
            (
                FILE_ATTRIBUTE_ARCHIVE,
                IO_REPARSE_TAG_SYMLINK,
                FileKind::File,
            ),
        ] {
            assert_eq!(kind(attributes, tag), expected, "{attributes:#x} {tag:#x}");
        }
    }

    #[test]
    fn converts_filetimes_as_std_does() {
        let year_1601 = SystemTime::UNIX_EPOCH - Duration::from_secs(11_644_473_600);
        let std_ns = |filetime: i64| {
            let since_1601 = u64::try_from(filetime).unwrap() * 100;
            crate::fs::unix_ns(year_1601 + Duration::from_nanos(since_1601))
        };
        // Around the epoch, a time from a real listing, and both sides of where `i64`
        // nanoseconds before the epoch end.
        for filetime in [
            UNIX_EPOCH,
            UNIX_EPOCH + 1,
            UNIX_EPOCH - 1,
            134_350_389_387_077_083,
            UNIX_EPOCH - 92_233_720_368_547_758,
            UNIX_EPOCH - 92_233_720_368_547_759,
        ] {
            assert_eq!(unix_ns(filetime), std_ns(filetime), "{filetime}");
        }
        assert_eq!(unix_ns(0), None);
        assert_eq!(unix_ns(i64::MAX), None);
        assert_eq!(unix_ns(-1), None);
    }

    #[test]
    fn file_ids_join_the_serial_and_the_id() {
        assert_eq!(
            file_id_text(0x141e_bf09_1ebe_e2c2, 0x70_0000_0002_73ee),
            "141ebf091ebee2c2-700000000273ee"
        );
        assert_eq!(file_id_text(1, u128::MAX), format!("1-{}", "f".repeat(32)));
    }
}
