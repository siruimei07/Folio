//! The value rules of history format 1 (remote-format.md §6 and the name comparison of §7.4),
//! frozen with it.
//!
//! A version 1 tree or commit must parse in every later Folio, so these rules never change. Today
//! they equal the library's own (`paths::check_name` at `PATHS_VERSION` 1, `meta::DisplayName`,
//! `meta::LibraryId`), but those may change with a later paths or metadata version, so the store
//! keeps its own copy; tests keep the name, path and library id rules equal to the library's while
//! `PATHS_VERSION` is 1.

use std::fmt;
use std::str::FromStr;

use unicode_normalization::is_nfc;

use super::json::Int;
use crate::meta;
use crate::paths::{PathError, RelPath};

/// The longest name, in UTF-16 code units (§6.4 rule 6).
pub const MAX_NAME_UNITS: usize = 255;

/// The longest path, in UTF-16 code units (§6.5).
pub const MAX_PATH_UNITS: usize = 32_767;

/// The longest device name, in characters (§6.6).
pub const MAX_DEVICE_NAME_CHARS: usize = 128;

/// The longest summary, in characters (§6.7).
pub const MAX_SUMMARY_CHARS: usize = 256;

/// The longest body, in characters (§6.7).
pub const MAX_BODY_CHARS: usize = 16_384;

/// The value that breaks a rule of remote-format.md §6, and how.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ValueError {
    #[error(transparent)]
    Name(#[from] NameError),
    #[error("a path is longer than {MAX_PATH_UNITS} UTF-16 code units")]
    PathTooLong,
    #[error(
        "a time must be YYYY-MM-DDTHH:MM:SSZ from 1970-01-01T00:00:00Z to 9999-12-31T23:59:59Z"
    )]
    Time,
    #[error("an object id must be `b3:` and 64 lower-case hexadecimal digits")]
    ObjectId,
    #[error("a pack name must be 64 lower-case hexadecimal digits, and `.pack` in a file name")]
    PackName,
    #[error("a device id must be 32 lower-case hexadecimal digits")]
    DeviceId,
    #[error("a library id must be 32 lower-case hexadecimal digits")]
    LibraryId,
    /// A pack a head record lists is smaller than any pack (remote-format.md §10.3).
    #[error("a pack is at least 150 bytes long")]
    PackSize,
    #[error(
        "a device name must be 1-{MAX_DEVICE_NAME_CHARS} characters without control characters, \
         not starting or ending with white space"
    )]
    DeviceName,
    #[error(
        "a summary must be 1-{MAX_SUMMARY_CHARS} characters without control characters, not \
         starting or ending with white space"
    )]
    Summary,
    #[error(
        "a body must be 1-{MAX_BODY_CHARS} characters without control characters other than tab \
         and line feed, not starting with a line feed or ending with white space"
    )]
    Body,
    #[error("a size must be an integer from 0 to 2^53 - 1")]
    Size,
    #[error("a count must be an integer from 1 to 2^53 - 1")]
    Count,
}

/// The rule of remote-format.md §6.4 a name breaks first, in the order of the rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum NameError {
    #[error("a name is empty")]
    Empty,
    #[error("`.` and `..` are not names")]
    DotName,
    #[error("a name holds {0:?}, which Windows does not allow")]
    InvalidCharacter(char),
    #[error("a name ends with a dot or a space")]
    TrailingDotOrSpace,
    #[error("a name is a Windows device name")]
    ReservedName,
    #[error("a name is longer than {MAX_NAME_UNITS} UTF-16 code units")]
    TooLong,
    #[error("a name is not in Unicode normalization form C")]
    NotNfc,
}

validated_string!(
    /// One entry of a tree or one segment of a path (remote-format.md §6.4). Names compare as
    /// byte strings, so two that differ only in case are different names.
    Name,
    ValueError,
    |text| check_name(text).map_err(ValueError::Name)
);

validated_string!(
    /// A path relative to the library root (remote-format.md §6.5): names joined by `/`, at most
    /// 32,767 UTF-16 code units in all.
    TreePath,
    ValueError,
    check_path
);

impl TreePath {
    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.0.split('/')
    }

    /// The last name.
    pub fn name(&self) -> &str {
        self.0.rsplit_once('/').map_or(&self.0, |(_, name)| name)
    }
}

/// A library path is a tree path when it meets the frozen rules too.
impl TryFrom<&RelPath> for TreePath {
    type Error = ValueError;

    fn try_from(path: &RelPath) -> Result<Self, ValueError> {
        Self::parse(path.as_str())
    }
}

/// A tree path is a library path when it meets the library's current rules too.
impl TryFrom<&TreePath> for RelPath {
    type Error = PathError;

    fn try_from(path: &TreePath) -> Result<Self, PathError> {
        Self::parse(path.as_str())
    }
}

validated_string!(
    /// A device's id (remote-format.md §6.1): 128 random bits as 32 lower-case hexadecimal
    /// digits, generated once per Windows installation (versioning.md §4.6).
    DeviceId,
    ValueError,
    |text| {
        if is_id_128(text) {
            Ok(())
        } else {
            Err(ValueError::DeviceId)
        }
    }
);

validated_string!(
    /// A library's id (remote-format.md §6.1): the `id` of `.folio/library.json`, 128 random bits
    /// as 32 lower-case hexadecimal digits. Frozen with the format, as the other values are: the
    /// metadata format's [`meta::LibraryId`] has the same rule today and converts with a check.
    LibraryId,
    ValueError,
    |text| {
        if is_id_128(text) {
            Ok(())
        } else {
            Err(ValueError::LibraryId)
        }
    }
);

/// A library's id from `.folio/library.json` is a library id of the format when it meets the
/// frozen rule too.
impl TryFrom<&meta::LibraryId> for LibraryId {
    type Error = ValueError;

    fn try_from(id: &meta::LibraryId) -> Result<Self, ValueError> {
        Self::parse(id.as_str())
    }
}

validated_string!(
    /// A device's name (remote-format.md §6.6): 1–128 characters, no control characters, not
    /// starting or ending with white space.
    DeviceName,
    ValueError,
    |text| {
        if is_line(text, MAX_DEVICE_NAME_CHARS) {
            Ok(())
        } else {
            Err(ValueError::DeviceName)
        }
    }
);

validated_string!(
    /// A commit's summary (remote-format.md §6.7): 1–256 characters, no control characters, so
    /// one line, not starting or ending with white space.
    Summary,
    ValueError,
    |text| {
        if is_line(text, MAX_SUMMARY_CHARS) {
            Ok(())
        } else {
            Err(ValueError::Summary)
        }
    }
);

validated_string!(
    /// A commit's body (remote-format.md §6.7): 1–16,384 characters, no control characters but
    /// tab and line feed, not starting with a line feed, not ending with white space. A message
    /// without details has no body rather than an empty one.
    Body,
    ValueError,
    |text| {
        if is_body(text) {
            Ok(())
        } else {
            Err(ValueError::Body)
        }
    }
);

/// A time (remote-format.md §6.2): UTC in whole seconds, written exactly `YYYY-MM-DDTHH:MM:SSZ`,
/// from 1970-01-01T00:00:00Z to 9999-12-31T23:59:59Z. Clocks may be wrong, so readers never order
/// commits by their times.
#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Timestamp(u64);

impl Timestamp {
    /// 1970-01-01T00:00:00Z.
    pub const MIN: Self = Self(0);

    /// 9999-12-31T23:59:59Z.
    pub const MAX: Self = Self(253_402_300_799);

    pub fn parse(text: &str) -> Result<Self, ValueError> {
        let bytes = text.as_bytes();
        let separators = [
            (4, b'-'),
            (7, b'-'),
            (10, b'T'),
            (13, b':'),
            (16, b':'),
            (19, b'Z'),
        ];
        if bytes.len() != 20 || separators.iter().any(|&(at, byte)| bytes[at] != byte) {
            return Err(ValueError::Time);
        }
        let number = |start: usize, len: usize| {
            bytes[start..start + len]
                .iter()
                .try_fold(0, |value: u64, &digit| {
                    digit
                        .is_ascii_digit()
                        .then(|| value * 10 + u64::from(digit - b'0'))
                })
        };
        let mut fields = [0; 6];
        let places = [(0, 4), (5, 2), (8, 2), (11, 2), (14, 2), (17, 2)];
        for (field, (at, len)) in fields.iter_mut().zip(places) {
            *field = number(at, len).ok_or(ValueError::Time)?;
        }
        let [year, month, day, hour, minute, second] = fields;
        let valid = year >= 1970
            && (1..=12).contains(&month)
            && (1..=days_in_month(year, month)).contains(&day)
            && hour <= 23
            && minute <= 59
            && second <= 59;
        if !valid {
            return Err(ValueError::Time);
        }
        let days = days_from_civil(year, month, day);
        Ok(Self(days * 86_400 + hour * 3_600 + minute * 60 + second))
    }

    /// The time `seconds` after 1970-01-01T00:00:00Z, if it is not after [`Timestamp::MAX`].
    pub fn from_unix_seconds(seconds: u64) -> Result<Self, ValueError> {
        if seconds <= Self::MAX.0 {
            Ok(Self(seconds))
        } else {
            Err(ValueError::Time)
        }
    }

    /// The seconds since 1970-01-01T00:00:00Z.
    pub const fn unix_seconds(self) -> u64 {
        self.0
    }
}

impl fmt::Display for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let (year, month, day) = civil_from_days(self.0 / 86_400);
        let seconds = self.0 % 86_400;
        let (hour, minute, second) = (seconds / 3_600, seconds / 60 % 60, seconds % 60);
        write!(
            f,
            "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}Z"
        )
    }
}

impl fmt::Debug for Timestamp {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(self, f)
    }
}

impl FromStr for Timestamp {
    type Err = ValueError;

    fn from_str(text: &str) -> Result<Self, ValueError> {
        Self::parse(text)
    }
}

/// A size in bytes (remote-format.md §6.3): an integer from 0 to 2^53 - 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Size(u64);

impl Size {
    pub const MAX: Self = Self(Int::MAX.get());

    pub const fn new(bytes: u64) -> Result<Self, ValueError> {
        if bytes <= Self::MAX.0 {
            Ok(Self(bytes))
        } else {
            Err(ValueError::Size)
        }
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl TryFrom<u64> for Size {
    type Error = ValueError;

    fn try_from(bytes: u64) -> Result<Self, ValueError> {
        Self::new(bytes)
    }
}

/// Every integer of the format is a valid size.
impl From<Int> for Size {
    fn from(value: Int) -> Self {
        Self(value.get())
    }
}

impl From<Size> for Int {
    fn from(size: Size) -> Self {
        Self::new(size.0).expect("a size is an integer of the format")
    }
}

impl fmt::Display for Size {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

/// A count (remote-format.md §6.3, `seq` and `lamport`): an integer from 1 to 2^53 - 1.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Count(u64);

impl Count {
    pub const MIN: Self = Self(1);
    pub const MAX: Self = Self(Int::MAX.get());

    pub const fn new(value: u64) -> Result<Self, ValueError> {
        if value >= Self::MIN.0 && value <= Self::MAX.0 {
            Ok(Self(value))
        } else {
            Err(ValueError::Count)
        }
    }

    pub const fn get(self) -> u64 {
        self.0
    }
}

impl TryFrom<u64> for Count {
    type Error = ValueError;

    fn try_from(value: u64) -> Result<Self, ValueError> {
        Self::new(value)
    }
}

impl TryFrom<Int> for Count {
    type Error = ValueError;

    fn try_from(value: Int) -> Result<Self, ValueError> {
        Self::new(value.get())
    }
}

impl From<Count> for Int {
    fn from(count: Count) -> Self {
        Self::new(count.0).expect("a count is an integer of the format")
    }
}

impl fmt::Display for Count {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

/// Whether two names are the same name as NTFS compares them for remote-format.md §7.4: ignoring
/// ASCII case, with `ı` (U+0131) as `i` and `ſ` (U+017F) as `s`. For the names §7.4 protects
/// (`.folio`, `local`, `store`) this is what Unicode's simple uppercase mapping does.
pub fn same_ntfs_name(a: &str, b: &str) -> bool {
    a.chars().map(ntfs_fold).eq(b.chars().map(ntfs_fold))
}

fn ntfs_fold(ch: char) -> char {
    match ch {
        'A'..='Z' => ch.to_ascii_lowercase(),
        'ı' => 'i',
        'ſ' => 's',
        _ => ch,
    }
}

/// The rules of remote-format.md §6.4, in their order.
fn check_name(name: &str) -> Result<(), NameError> {
    if name.is_empty() {
        return Err(NameError::Empty);
    }
    if name == "." || name == ".." {
        return Err(NameError::DotName);
    }
    let invalid = |ch: char| {
        ch <= '\u{1f}' || matches!(ch, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*')
    };
    if let Some(ch) = name.chars().find(|&ch| invalid(ch)) {
        return Err(NameError::InvalidCharacter(ch));
    }
    if name.ends_with(['.', ' ']) {
        return Err(NameError::TrailingDotOrSpace);
    }
    if is_device_name(name) {
        return Err(NameError::ReservedName);
    }
    if utf16_len(name) > MAX_NAME_UNITS {
        return Err(NameError::TooLong);
    }
    if !is_nfc(name) {
        return Err(NameError::NotNfc);
    }
    Ok(())
}

/// Rule 5: the part before the first `.`, without the spaces at its end, equals a device name
/// ignoring ASCII case, or is `COM` or `LPT` and one digit (`0`–`9`, `¹`, `²`, `³`).
fn is_device_name(name: &str) -> bool {
    let stem = name
        .split_once('.')
        .map_or(name, |(stem, _)| stem)
        .trim_end_matches(' ');
    if ["CON", "PRN", "AUX", "NUL", "CONIN$", "CONOUT$"]
        .iter()
        .any(|device| stem.eq_ignore_ascii_case(device))
    {
        return true;
    }
    let (Some(prefix), Some(digit)) = (stem.get(..3), stem.get(3..)) else {
        return false;
    };
    let mut digit = digit.chars();
    (prefix.eq_ignore_ascii_case("COM") || prefix.eq_ignore_ascii_case("LPT"))
        && matches!(digit.next(), Some('0'..='9' | '¹' | '²' | '³'))
        && digit.next().is_none()
}

/// §6.5: every name valid, then the length.
fn check_path(text: &str) -> Result<(), ValueError> {
    for name in text.split('/') {
        check_name(name)?;
    }
    if utf16_len(text) > MAX_PATH_UNITS {
        return Err(ValueError::PathTooLong);
    }
    Ok(())
}

/// §6.1: 128 bits as 32 lower-case hexadecimal digits, a library's or a device's id.
fn is_id_128(text: &str) -> bool {
    text.len() == 32 && crate::is_lower_hex(text)
}

/// The length of `text` in UTF-16 code units, the unit of §6.4 rule 6 and §6.5.
pub(super) fn utf16_len(text: &str) -> usize {
    text.chars().map(char::len_utf16).sum()
}

/// White space (remote-format.md §2): the Unicode `White_Space` property, spelled out as Unicode
/// 17 defines it (Rust's `char::is_whitespace`) so that the rule stays frozen.
fn is_white_space(ch: char) -> bool {
    matches!(
        ch,
        '\u{9}'..='\u{d}'
            | ' '
            | '\u{85}'
            | '\u{a0}'
            | '\u{1680}'
            | '\u{2000}'..='\u{200a}'
            | '\u{2028}'
            | '\u{2029}'
            | '\u{202f}'
            | '\u{205f}'
            | '\u{3000}'
    )
}

/// Control characters (remote-format.md §2): general category `Cc`.
fn is_control(ch: char) -> bool {
    matches!(ch, '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}')
}

/// One line of 1 to `max` characters: no control characters, not starting or ending with white
/// space (§6.6, and §6.7's summary).
fn is_line(text: &str, max: usize) -> bool {
    let mut chars = 0;
    for ch in text.chars() {
        chars += 1;
        if chars > max || is_control(ch) {
            return false;
        }
    }
    chars >= 1 && !text.starts_with(is_white_space) && !text.ends_with(is_white_space)
}

/// §6.7's body.
fn is_body(text: &str) -> bool {
    let mut chars = 0;
    for ch in text.chars() {
        chars += 1;
        if chars > MAX_BODY_CHARS || (is_control(ch) && ch != '\t' && ch != '\n') {
            return false;
        }
    }
    chars >= 1 && !text.starts_with('\n') && !text.ends_with(is_white_space)
}

fn is_leap_year(year: u64) -> bool {
    (year.is_multiple_of(4) && !year.is_multiple_of(100)) || year.is_multiple_of(400)
}

fn days_in_month(year: u64, month: u64) -> u64 {
    match month {
        2 if is_leap_year(year) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// The days from 1970-01-01 to a date of the proleptic Gregorian calendar from 1970 on (Howard
/// Hinnant's `days_from_civil`, for years that need no negative numbers).
fn days_from_civil(year: u64, month: u64, day: u64) -> u64 {
    // Years start in March, so the leap day ends a year.
    let year = if month <= 2 { year - 1 } else { year };
    let era = year / 400;
    let year_of_era = year % 400;
    let day_of_year = (153 * ((month + 9) % 12) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

/// The date `days` after 1970-01-01, as (year, month, day): the inverse of [`days_from_civil`].
fn civil_from_days(days: u64) -> (u64, u64, u64) {
    let days = days + 719_468;
    let era = days / 146_097;
    let day_of_era = days % 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = (month_index + 2) % 12 + 1;
    let year = era * 400 + year_of_era + u64::from(month <= 2);
    (year, month, day)
}

#[cfg(test)]
mod tests;
