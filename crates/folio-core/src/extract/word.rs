//! Word documents read as paragraphs of text (versioning.md §10.3), without trusting the file:
//! nothing in it runs, every byte read from it and every byte its parts expand to is counted, and
//! its XML may have neither a DTD nor an entity beyond XML's own.
//!
//! 1. The ZIP's end record is read first, and an archive of more than `max_entries` entries is
//!    refused before the directory it describes is loaded, as is a file in which zip could take
//!    another zip64 end record or go back to an earlier end record without stopping there: so zip
//!    never reserves memory for more entries than the cap, and loads one directory at most. zip
//!    then loads it from the bytes the check read, from the directory's start to the file's end,
//!    and may read nothing before them: so a damaged end record cannot send it elsewhere, and a
//!    file that changes meanwhile cannot show it other bytes.
//! 2. The main part is the package's officeDocument relationship (`_rels/.rels`, transitional or
//!    strict), else `word/document.xml`; footnotes and endnotes are the main part's relationships.
//! 3. Every read of the file is counted against `max_read`, and every part's expanded bytes against
//!    `max_expanded`; each read also checks the deadline and the cancel flag. The caps bound the
//!    work, which grows with the bytes read and expanded (attribute lookups included): the slowest
//!    crafted documents measured within the default caps take under 2 s and about 200 MiB
//!    (versioning.md §13.3), a sixth of [`TIME_LIMIT`](super::TIME_LIMIT), which is a backstop.
//! 4. The paragraphs are collected from the XML ([`xml`]).

use std::cell::{Cell, RefCell};
use std::io::{self, BufRead, BufReader, Read, Seek, SeekFrom};
use std::sync::atomic::Ordering;
use std::time::Instant;

use zip::ZipArchive;
use zip::result::ZipError;

use super::Control;

mod xml;

/// The most bytes the parts of one document may expand to, all parts together.
pub const MAX_EXPANDED: u64 = 64 << 20;

/// The most entries one document's archive may have.
pub const MAX_ENTRIES: usize = 10_000;

/// The most bytes one document may read from its file, all reads together: what its parts may
/// expand to (deflate makes no part read much more than that), and 16 MiB for its directory and
/// headers. It bounds the work on a part whose bytes expand to little or nothing.
pub const MAX_READ: u64 = MAX_EXPANDED + (16 << 20);

/// Bytes of central directory allowed for each entry `max_entries` allows. A Word entry's
/// directory header takes about 80 bytes.
const DIRECTORY_BYTES_PER_ENTRY: u64 = 1024;

/// zip looks for the end record in windows of this many bytes, so the window that finds it may
/// begin up to this far before the directory.
const FINDER_WINDOW: u64 = 1024;

const END_SIGNATURE: [u8; 4] = *b"PK\x05\x06";
const END_LEN: usize = 22;
const MAX_COMMENT_LEN: usize = 0xFFFF;
const LOCATOR_SIGNATURE: [u8; 4] = *b"PK\x06\x07";
const LOCATOR_LEN: usize = 20;
const ZIP64_END_SIGNATURE: [u8; 4] = *b"PK\x06\x06";
const ZIP64_END_LEN: usize = 56;
/// The smallest size a zip64 end record may give itself (its length after the size field).
const ZIP64_MIN_RECORD_SIZE: u64 = 40;
/// The bytes of a zip64 end record before its size field ends.
const ZIP64_SIZE_END: u64 = 12;
/// The fixed part of a central directory header: the least each entry takes.
const CENTRAL_HEADER_LEN: u64 = 46;

/// Why [`check_end_record`] refuses a locator naming a zip64 end record that cannot be before it.
const LOCATOR_REFUSED: &str = "the zip64 end record locator is inconsistent";
/// Why [`check_end_record`] refuses a locator without a zip64 end record where it says: zip would
/// look for one after that point, which the check has not read.
const ZIP64_RECORD_MISSING: &str = "the zip64 end record is not where its locator says";
/// Why [`check_end_record`] refuses a zip64 end record zip would not take as it is.
const ZIP64_RECORD_REFUSED: &str = "the zip64 end record is inconsistent";
/// Why [`check_end_record`] refuses an end record whose directory would start after it.
const DIRECTORY_AFTER_END: &str = "the directory starts after the end record";
/// Why [`check_end_record`] refuses an earlier end record zip would go back to without stopping.
const EARLIER_END_RECORD: &str = "an earlier end record would keep zip searching";
/// Why a read before the window is refused while zip loads the directory.
const NO_DIRECTORY: &str = "the end record does not lead to a directory";

/// The most bytes of the detail of a [`WordError`]: part names and XML errors come from the file
/// (a mismatched end tag names both tags in full).
const MAX_DETAIL: usize = 300;

/// The main part when the package names none.
const DEFAULT_MAIN_PART: &str = "word/document.xml";

/// How much of a document [`read_word`] may read.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WordLimits {
    /// The most text to collect, in UTF-8 bytes plus one for each paragraph. Reading stops there
    /// and the result is marked incomplete.
    pub max_text: usize,
    /// The most bytes the parts read may expand to, all together; beyond it the document is
    /// [`WordError::TooLarge`].
    pub max_expanded: u64,
    /// The most entries the archive may have; beyond it the document is [`WordError::TooLarge`].
    pub max_entries: usize,
    /// The most bytes to read from the file, all reads together; beyond it the document is
    /// [`WordError::TooLarge`].
    pub max_read: u64,
}

impl WordLimits {
    /// [`MAX_EXPANDED`], [`MAX_ENTRIES`] and [`MAX_READ`], collecting at most `max_text`.
    pub const fn with_max_text(max_text: usize) -> Self {
        Self {
            max_text,
            max_expanded: MAX_EXPANDED,
            max_entries: MAX_ENTRIES,
            max_read: MAX_READ,
        }
    }
}

/// The text of a Word document.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WordText {
    /// Paragraphs in reading order: the body's, table cells row by row, a text box's before the
    /// paragraph that anchors it; then the footnotes'; then the endnotes'. Inserted text counts
    /// and deleted text does not. A paragraph may contain `\t` and `\n`, and may be empty.
    pub paragraphs: Vec<String>,
    /// False when [`WordLimits::max_text`] stopped the reading; `paragraphs` then hold the text
    /// before that point.
    pub complete: bool,
}

/// Why a Word document gave no text.
#[derive(Debug, thiserror::Error)]
pub enum WordError {
    /// Not a ZIP, no main part, malformed XML, a DTD, an undeclared entity, or an encrypted or
    /// unsupported entry. The detail is for logs, at most 300 bytes and an ellipsis.
    #[error("not a Word document Folio can read: {0}")]
    Invalid(String),
    /// Over [`WordLimits::max_expanded`], [`WordLimits::max_entries`] or
    /// [`WordLimits::max_read`], or XML nested too deep. The detail is for logs, at most 300
    /// bytes and an ellipsis.
    #[error("too large to read: {0}")]
    TooLarge(String),
    /// [`Control::deadline`] passed.
    #[error("reading took longer than allowed")]
    TimedOut,
    /// [`Control::cancel`] was set.
    #[error("reading was cancelled")]
    Cancelled,
    /// The file could not be read; reading it again may work.
    #[error("could not read the file: {0}")]
    Io(#[source] io::Error),
}

impl WordError {
    /// This error with its detail cut to [`MAX_DETAIL`] bytes, so that a crafted file cannot
    /// make a caller keep, store or send megabytes of it.
    fn bounded(self) -> Self {
        fn cut(mut detail: String) -> String {
            if detail.len() > MAX_DETAIL {
                detail.truncate(detail.floor_char_boundary(MAX_DETAIL));
                detail.push('…');
                detail.shrink_to_fit();
            }
            detail
        }
        match self {
            Self::Invalid(detail) => Self::Invalid(cut(detail)),
            Self::TooLarge(detail) => Self::TooLarge(cut(detail)),
            other => other,
        }
    }
}

/// The text of the Word document `reader` holds (a file, or a stored version in a `Cursor`).
pub fn read_word(
    reader: impl Read + Seek,
    limits: &WordLimits,
    control: &Control<'_>,
) -> Result<WordText, WordError> {
    let budget = Budget::new(limits, control);
    let result = read(reader, limits, &budget);
    // A read the budget refused explains whatever came of it, even a result: zip ignores some
    // failed reads.
    let result = match budget.take_stop() {
        Some(stop) => Err(stop),
        None => result,
    };
    result.map_err(WordError::bounded)
}

fn read<R: Read + Seek>(
    reader: R,
    limits: &WordLimits,
    budget: &Budget<'_>,
) -> Result<WordText, WordError> {
    let mut source = Source {
        inner: reader,
        budget,
        position: 0,
        synced: true,
    };
    let window = check_end_record(&mut source, limits.max_entries)?;
    *budget.window.borrow_mut() = Some(window);
    let archive = ZipArchive::new(source);
    budget.window.take();
    let mut archive = archive.map_err(zip_error)?;
    if archive.len() > limits.max_entries {
        return Err(too_many_entries(archive.len() as u64, limits.max_entries));
    }

    let main = main_part(&mut archive, budget)?;
    let notes = note_parts(&mut archive, budget, &main)?;
    let mut collector = xml::Collector::new(limits.max_text);
    for index in [main.index].into_iter().chain(notes) {
        let flow = with_part(&mut archive, index, budget, |part, name| {
            collector.read_part(part, name)
        })?;
        if flow == xml::Flow::Stop {
            break;
        }
    }
    Ok(collector.finish())
}

/// Reads the end record (the zip64 one when the classic one defers to it) as zip will choose it,
/// and refuses more than `max_entries` entries, a directory too long for them, or a file in which
/// zip could take another end record; returns the bytes zip may read while it loads the
/// directory.
fn check_end_record<R: Read + Seek>(
    source: &mut Source<'_, R>,
    max_entries: usize,
) -> Result<Window, WordError> {
    let len = source.seek(SeekFrom::End(0)).map_err(io_invalid)?;
    let tail_len = len.min((END_LEN + MAX_COMMENT_LEN) as u64);
    let tail_start = len - tail_len;
    let mut tail = vec![0; tail_len as usize];
    read_at(source, tail_start, &mut tail)?;
    let at = find_end_record(&tail)
        .ok_or_else(|| WordError::Invalid("not a ZIP archive: no end record".to_owned()))?;
    let record = &tail[at..at + END_LEN];
    let end = tail_start + at as u64;

    let (disk_entries, all_entries) = (le16(record, 8), le16(record, 10));
    let mut entries = u64::from(disk_entries.max(all_entries));
    let mut directory = u64::from(le32(record, 16));
    // A locator without its signature means a classic archive.
    if defers_to_zip64(record) && end >= LOCATOR_LEN as u64 {
        let locator_at = end - LOCATOR_LEN as u64;
        let mut locator = [0; LOCATOR_LEN];
        read_at(source, locator_at, &mut locator)?;
        if locator[..4] == LOCATOR_SIGNATURE {
            let (record_at, disks) = (le64(&locator, 8), le32(&locator, 16));
            if record_at >= locator_at || disks > 1 {
                return Err(WordError::Invalid(LOCATOR_REFUSED.to_owned()));
            }
            let mut record = [0; ZIP64_END_LEN];
            read_at(source, record_at, &mut record)?;
            if record[..4] != ZIP64_END_SIGNATURE {
                return Err(WordError::Invalid(ZIP64_RECORD_MISSING.to_owned()));
            }
            check_zip64_record(&record, record_at, locator_at, le32(&locator, 4))?;
            entries = le64(&record, 32);
            directory = le64(&record, 48);
        }
    }

    if entries > max_entries as u64 {
        return Err(too_many_entries(entries, max_entries));
    }
    if directory > end {
        return Err(WordError::Invalid(DIRECTORY_AFTER_END.to_owned()));
    }
    let span = end - directory;
    let max_span = (max_entries as u64).saturating_mul(DIRECTORY_BYTES_PER_ENTRY);
    if span > max_span {
        return Err(WordError::TooLarge(format!(
            "a central directory of {span} bytes, more than {max_span}"
        )));
    }

    // What zip may read while it loads the directory, from the directory's start (less one search
    // window) to the file's end: in the tail already read, unless the directory is long.
    let start = directory.saturating_sub(FINDER_WINDOW);
    let bytes = match start.checked_sub(tail_start) {
        Some(skip) => {
            tail.drain(..skip as usize);
            tail
        }
        None => {
            let mut bytes = vec![0; (tail_start - start) as usize];
            read_at(source, start, &mut bytes)?;
            bytes.extend_from_slice(&tail);
            bytes
        }
    };
    let window = Window { start, bytes };
    refuse_earlier_end_records(&window, end)?;
    Ok(window)
}

/// Whether a classic end record sends zip to the zip64 locator before it: only these values do.
fn defers_to_zip64(record: &[u8]) -> bool {
    le16(record, 10) == u16::MAX || le32(record, 12) == u32::MAX || le32(record, 16) == u32::MAX
}

/// Refuses the zip64 end record at `record_at` if zip would not take it as it is (zip 8.6's
/// `find_central_directory`, `Zip64CentralDirectoryEnd::parse` and `read_central_header`): zip
/// would then look on for another one after it, which [`check_end_record`] has not checked.
fn check_zip64_record(
    record: &[u8; ZIP64_END_LEN],
    record_at: u64,
    locator_at: u64,
    locator_disk: u32,
) -> Result<(), WordError> {
    let record_size = le64(record, 4);
    let (disk, directory_disk) = (le32(record, 16), le32(record, 20));
    let (disk_entries, entries) = (le64(record, 24), le64(record, 32));
    let directory = le64(record, 48);
    // Its size reaches the locator exactly; it names the locator's disk, its own; it counts no
    // more entries on this disk than in all; and its directory, of at least a fixed header per
    // entry, ends before it.
    let taken = record_size >= ZIP64_MIN_RECORD_SIZE
        && record_size.checked_add(ZIP64_SIZE_END) == Some(locator_at - record_at)
        && directory_disk == locator_disk
        && disk == directory_disk
        && disk_entries <= entries
        && entries
            .saturating_mul(CENTRAL_HEADER_LEN)
            .saturating_add(directory)
            <= record_at;
    if taken {
        Ok(())
    } else {
        Err(WordError::Invalid(ZIP64_RECORD_REFUSED.to_owned()))
    }
}

/// Refuses an end record in `window` before `end`, the end record checked, unless zip would stop
/// at it.
///
/// When the directory of the end record zip took does not load, zip goes back to the end record
/// before it, and so on (zip 8.6's `ZipArchive::get_metadata` and `find_central_directory`). At
/// each it reads the record and its comment. At one that defers to a zip64 record it reads that
/// record, and reserves memory for every entry it declares (up to the file's length / 46, over 200
/// bytes each). At another it looks for a central header from where the record says its directory
/// starts up to the record, and loads the directory it finds: a file of many end records would
/// keep it busy for a time that grows with the square of their number. It stops at a record that
/// does not defer, has its comment inside the file, declares entries and names a directory before
/// the window, since its first read there is refused. An embedded package stored just before the
/// directory ends in such a record.
fn refuse_earlier_end_records(window: &Window, end: u64) -> Result<(), WordError> {
    for at in 0..(end - window.start) as usize {
        if window.bytes[at..at + 4] != END_SIGNATURE {
            continue;
        }
        let record = &window.bytes[at..at + END_LEN];
        let position = window.start + at as u64;
        let comment_end = position + END_LEN as u64 + u64::from(le16(record, 20));
        let stops = !defers_to_zip64(record)
            && comment_end <= window.end()
            && le16(record, 10) > 0
            && u64::from(le32(record, 16)) < window.start;
        if !stops {
            return Err(WordError::Invalid(EARLIER_END_RECORD.to_owned()));
        }
    }
    Ok(())
}

/// The end record zip chooses in `tail`, the file's last bytes: the one nearest the end whose
/// comment ends inside the file.
fn find_end_record(tail: &[u8]) -> Option<usize> {
    let last = tail.len().checked_sub(END_LEN)?;
    (0..=last).rev().find(|&at| {
        tail[at..at + 4] == END_SIGNATURE
            && at + END_LEN + usize::from(le16(tail, at + 20)) <= tail.len()
    })
}

fn read_at<R: Read + Seek>(
    source: &mut Source<'_, R>,
    at: u64,
    buf: &mut [u8],
) -> Result<(), WordError> {
    source.seek(SeekFrom::Start(at)).map_err(io_invalid)?;
    source.read_exact(buf).map_err(io_invalid)
}

fn le16(bytes: &[u8], at: usize) -> u16 {
    u16::from_le_bytes([bytes[at], bytes[at + 1]])
}

fn le32(bytes: &[u8], at: usize) -> u32 {
    u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]])
}

fn le64(bytes: &[u8], at: usize) -> u64 {
    u64::from(le32(bytes, at)) | (u64::from(le32(bytes, at + 4)) << 32)
}

fn too_many_entries(entries: u64, max_entries: usize) -> WordError {
    WordError::TooLarge(format!("{entries} entries, more than {max_entries}"))
}

/// A part of the archive: its index, and the name it was looked up by.
struct Part {
    index: usize,
    name: String,
}

/// The main part: the package's officeDocument relationship, else `word/document.xml`.
fn main_part<R: Read + Seek>(
    archive: &mut ZipArchive<Source<'_, R>>,
    budget: &Budget<'_>,
) -> Result<Part, WordError> {
    let named = match find(archive, "_rels/.rels") {
        Some(rels) => {
            let [target] = with_part(archive, rels, budget, |part, name| {
                xml::relationships(part, name, ["officeDocument"])
            })?;
            target.and_then(|target| resolve_target("", &target))
        }
        None => None,
    };
    named
        .into_iter()
        .chain([DEFAULT_MAIN_PART.to_owned()])
        .find_map(|name| find(archive, &name).map(|index| Part { index, name }))
        .ok_or_else(|| WordError::Invalid("no main document part".to_owned()))
}

/// The main part's footnotes and endnotes parts, in that order, those that exist.
fn note_parts<R: Read + Seek>(
    archive: &mut ZipArchive<Source<'_, R>>,
    budget: &Budget<'_>,
    main: &Part,
) -> Result<Vec<usize>, WordError> {
    let (folder, file) = split_part_name(&main.name);
    let Some(rels) = find(archive, &format!("{folder}_rels/{file}.rels")) else {
        return Ok(Vec::new());
    };
    let targets = with_part(archive, rels, budget, |part, name| {
        xml::relationships(part, name, ["footnotes", "endnotes"])
    })?;
    // A part the relationships name but the archive lacks has no text to give.
    Ok(targets
        .into_iter()
        .flatten()
        .filter_map(|target| resolve_target(folder, &target))
        .filter_map(|name| find(archive, &name))
        .filter(|&index| index != main.index)
        .collect())
}

/// The folder of a part name (empty, or ending in `/`) and its file name.
fn split_part_name(name: &str) -> (&str, &str) {
    match name.rfind('/') {
        Some(at) => (&name[..=at], &name[at + 1..]),
        None => ("", name),
    }
}

/// The part name a relationship target names, resolved from `folder`, the folder of the part
/// that has the relationship (empty for the package); `None` when it climbs out of the package.
fn resolve_target(folder: &str, target: &str) -> Option<String> {
    let path = match target.strip_prefix('/') {
        Some(absolute) => absolute.to_owned(),
        None => format!("{folder}{target}"),
    };
    let mut segments = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                segments.pop()?;
            }
            segment => segments.push(segment),
        }
    }
    (!segments.is_empty()).then(|| segments.join("/"))
}

/// The index of the entry named `name`, or else of one named the same but for ASCII case (part
/// names are case-insensitive).
fn find<R: Read + Seek>(archive: &ZipArchive<R>, name: &str) -> Option<usize> {
    archive.index_for_name(name).or_else(|| {
        (0..archive.len()).find(|&index| {
            archive
                .name_for_index(index)
                .is_some_and(|candidate| candidate.eq_ignore_ascii_case(name))
        })
    })
}

/// Runs `read` on the expanded bytes of entry `index`, counted by `budget`.
fn with_part<R: Read + Seek, T>(
    archive: &mut ZipArchive<Source<'_, R>>,
    index: usize,
    budget: &Budget<'_>,
    read: impl FnOnce(&mut dyn BufRead, &str) -> Result<T, WordError>,
) -> Result<T, WordError> {
    let name = archive.name_for_index(index).unwrap_or_default().to_owned();
    let entry = archive.by_index(index).map_err(zip_error)?;
    let mut part = BufReader::new(Expanded {
        inner: entry,
        budget,
    });
    read(&mut part, &name)
}

fn zip_error(error: ZipError) -> WordError {
    WordError::Invalid(match error {
        ZipError::UnsupportedArchive(ZipError::PASSWORD_REQUIRED) | ZipError::InvalidPassword => {
            "an entry is encrypted".to_owned()
        }
        ZipError::CompressionMethodNotSupported(method) => {
            format!("an entry uses unsupported compression method {method}")
        }
        error => error.to_string(),
    })
}

/// A read error the budget did not refuse: the archive's own (a short record, say). When the
/// budget refused the read, its reason replaces this error in [`read_word`].
fn io_invalid(error: io::Error) -> WordError {
    WordError::Invalid(error.to_string())
}

/// What one document may still read, shared by every reader of it.
struct Budget<'c> {
    control: &'c Control<'c>,
    max_expanded: u64,
    expanded: Cell<u64>,
    max_read: u64,
    read: Cell<u64>,
    /// While zip loads the directory: the bytes it may read, which it reads from here.
    window: RefCell<Option<Window>>,
    stopped: Cell<bool>,
    /// Why the first refused read was refused.
    stop: Cell<Option<WordError>>,
}

impl<'c> Budget<'c> {
    fn new(limits: &WordLimits, control: &'c Control<'c>) -> Self {
        Self {
            control,
            max_expanded: limits.max_expanded,
            expanded: Cell::new(0),
            max_read: limits.max_read,
            read: Cell::new(0),
            window: RefCell::new(None),
            stopped: Cell::new(false),
            stop: Cell::new(None),
        }
    }

    /// Counts `read` bytes read from the file, and refuses going over the cap.
    fn count_read(&self, read: usize) -> io::Result<()> {
        let total = self.read.get().saturating_add(read as u64);
        self.read.set(total);
        if total > self.max_read {
            return Err(self.refuse(WordError::TooLarge(format!(
                "reading more than {} bytes of the file",
                self.max_read
            ))));
        }
        Ok(())
    }

    /// Refuses every read once one was refused, and any read after a cancel or the deadline.
    fn check(&self) -> io::Result<()> {
        if self.stopped.get() {
            return Err(refused());
        }
        if self.control.cancel.load(Ordering::Relaxed) {
            return Err(self.refuse(WordError::Cancelled));
        }
        if Instant::now() >= self.control.deadline {
            return Err(self.refuse(WordError::TimedOut));
        }
        Ok(())
    }

    /// Records why reading stops (the first reason only) and returns the error to give the
    /// reader's caller.
    fn refuse(&self, reason: WordError) -> io::Error {
        if !self.stopped.replace(true) {
            self.stop.set(Some(reason));
        }
        refused()
    }

    fn take_stop(&self) -> Option<WordError> {
        self.stop.take()
    }
}

fn refused() -> io::Error {
    io::Error::other("reading the document stopped")
}

/// The file's bytes from `start` to its end, as [`check_end_record`] read them.
struct Window {
    start: u64,
    bytes: Vec<u8>,
}

impl Window {
    /// The file's length when the check read it.
    fn end(&self) -> u64 {
        self.start + self.bytes.len() as u64
    }

    /// Copies into `buf` the bytes from `position` on, as many as fit and there are; `None` for a
    /// position before the window.
    fn read_at(&self, position: u64, buf: &mut [u8]) -> Option<usize> {
        let skip = position.checked_sub(self.start)?;
        let rest = usize::try_from(skip)
            .ok()
            .and_then(|skip| self.bytes.get(skip..))
            .unwrap_or_default();
        let count = rest.len().min(buf.len());
        buf[..count].copy_from_slice(&rest[..count]);
        Some(count)
    }
}

/// The file itself, read under the budget, and read from the budget's window while it has one.
/// A failure of the file is recorded as [`WordError::Io`], so zip's own errors stay distinct from
/// it.
struct Source<'b, R> {
    inner: R,
    budget: &'b Budget<'b>,
    /// Where the next read starts.
    position: u64,
    /// Whether `inner` is at `position`: reading from the window leaves it where it was.
    synced: bool,
}

impl<R: Read + Seek> Source<'_, R> {
    fn read_file(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if !self.synced {
            self.seek_file(SeekFrom::Start(self.position))?;
        }
        match self.inner.read(buf) {
            Ok(read) => Ok(read),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => Err(error),
            Err(error) => Err(self.budget.refuse(WordError::Io(error))),
        }
    }

    fn seek_file(&mut self, to: SeekFrom) -> io::Result<u64> {
        match self.inner.seek(to) {
            Ok(position) => {
                self.position = position;
                self.synced = true;
                Ok(position)
            }
            // A position before the start: an offset in the archive is wrong.
            Err(error) if error.kind() == io::ErrorKind::InvalidInput => Err(self.budget.refuse(
                WordError::Invalid(format!("an offset is out of range: {error}")),
            )),
            Err(error) => Err(self.budget.refuse(WordError::Io(error))),
        }
    }

    /// `from` moved by `delta`, which must not lead before the start.
    fn moved(&self, from: u64, delta: i64) -> io::Result<u64> {
        from.checked_add_signed(delta).ok_or_else(|| {
            self.budget
                .refuse(WordError::Invalid("an offset is out of range".to_owned()))
        })
    }
}

impl<R: Read + Seek> Read for Source<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.budget.check()?;
        let from_window = self
            .budget
            .window
            .borrow()
            .as_ref()
            .map(|window| window.read_at(self.position, buf));
        let read = match from_window {
            Some(Some(read)) => {
                self.synced = false;
                read
            }
            Some(None) => {
                return Err(self
                    .budget
                    .refuse(WordError::Invalid(NO_DIRECTORY.to_owned())));
            }
            None => self.read_file(buf)?,
        };
        self.position += read as u64;
        self.budget.count_read(read)?;
        Ok(read)
    }
}

impl<R: Read + Seek> Seek for Source<'_, R> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.budget.check()?;
        let window_end = self.budget.window.borrow().as_ref().map(Window::end);
        let Some(end) = window_end else {
            // From `position`: after reading from the window, the file is elsewhere.
            let to = match to {
                SeekFrom::Current(delta) => SeekFrom::Start(self.moved(self.position, delta)?),
                to => to,
            };
            return self.seek_file(to);
        };
        self.position = match to {
            SeekFrom::Start(at) => at,
            SeekFrom::End(delta) => self.moved(end, delta)?,
            SeekFrom::Current(delta) => self.moved(self.position, delta)?,
        };
        self.synced = false;
        Ok(self.position)
    }
}

/// An entry's expanded bytes, counted against the budget. The declared sizes are not trusted.
struct Expanded<'b, R> {
    inner: R,
    budget: &'b Budget<'b>,
}

impl<R: Read> Read for Expanded<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.budget.check()?;
        let read = self.inner.read(buf)?;
        let expanded = self.budget.expanded.get().saturating_add(read as u64);
        self.budget.expanded.set(expanded);
        if expanded > self.budget.max_expanded {
            return Err(self.budget.refuse(WordError::TooLarge(format!(
                "the parts expand to more than {} bytes",
                self.budget.max_expanded
            ))));
        }
        Ok(read)
    }
}

#[cfg(test)]
mod tests;
