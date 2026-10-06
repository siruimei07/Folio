//! Canonical JSON (remote-format.md §5): the one encoding of every tree, commit and record.
//!
//! The store's readers build no value of a whole document. Such a value grows with the document's
//! shape, not its length: `{},` is three bytes of input and a node of the value, so a small
//! document of many small objects would ask for a hundred times its size. Instead, within the
//! store:
//!
//! - `check` reads RFC 8259 JSON as strictly as the format needs: UTF-8 only, white space only
//!   from ` \t\n\r`, objects and arrays nested at most [`MAX_DEPTH`] levels, no duplicate keys and
//!   no lone surrogates. It keeps nothing of the document but the number its `format_version`
//!   states, so a record's version is read before any other rule (§3).
//! - `canonical` accepts a document only when it is exactly the canonical encoding of a value,
//!   and returns that value as a `Node`: read where it lies in the document's bytes, so a reader
//!   holds only what it takes out of it (the schemas).
//!
//! [`parse_canonical`] builds the whole [`Value`] of a canonical document, for documents one trusts
//! and for tests; [`Value::encode`] writes the canonical encoding.
//!
//! Both readers go through a document once, front to back, and report the first problem they meet.
//! They recurse once per level of nesting, so never more than [`MAX_DEPTH`] times, whatever the
//! input. Their memory is a few words per level and, in `check`, the place of every key of an
//! object whose keys are not in ascending order (eight bytes each, in a list that grows by
//! doubling), to find a key it repeats. Such an object's keys are each read once more, to hash
//! them, and sorted by their hashes, so that finding a repeat costs the keys' bytes and a sort of
//! integers, whatever the keys hold.

use std::borrow::Cow;
use std::cmp::Ordering;
use std::collections::BTreeMap;
use std::fmt;
use std::hash::{BuildHasher, Hasher, RandomState};

/// How deep objects and arrays may nest; the document's own object or array is level 1.
pub const MAX_DEPTH: usize = 16;

/// Why bytes are not a document of the format. Offsets count bytes from the document's start.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum JsonError {
    #[error("not UTF-8 (byte {offset})")]
    Utf8 { offset: usize },
    /// Not RFC 8259 JSON: a byte order mark, white space other than ` \t\n\r`, an unescaped
    /// control character, a document that ends early or goes on after its value.
    #[error("not JSON (byte {offset})")]
    Syntax { offset: usize },
    #[error("objects and arrays nest deeper than {MAX_DEPTH} levels (byte {offset})")]
    Depth { offset: usize },
    #[error("an object repeats a key (byte {offset})")]
    DuplicateKey { offset: usize },
    #[error("a string holds a lone surrogate (byte {offset})")]
    LoneSurrogate { offset: usize },
    #[error("`null` is not a value of the format")]
    Null,
    #[error("a number is not an integer from 0 to 2^53 - 1 in canonical form")]
    Number,
    /// Not the canonical encoding of what it holds: white space, keys out of their order, an
    /// escape that canonical JSON does not write. `offset` is the first byte, read front to back,
    /// that the canonical encoding would not have there.
    #[error("not canonical (first differs at byte {offset})")]
    NotCanonical { offset: usize },
}

/// An integer of the format (remote-format.md §5 rule 2): 0 to 2^53 - 1, which every JSON reader
/// keeps exactly.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Default)]
pub struct Int(u64);

impl Int {
    pub const MAX: Self = Self((1 << 53) - 1);

    pub const fn new(value: u64) -> Option<Self> {
        if value <= Self::MAX.0 {
            Some(Self(value))
        } else {
            None
        }
    }

    pub const fn get(self) -> u64 {
        self.0
    }

    /// The integer canonical JSON writes as `text`: decimal digits, no sign, no leading zero.
    fn parse(text: &str) -> Option<Self> {
        let canonical = text == "0"
            || (text.starts_with(|ch: char| matches!(ch, '1'..='9'))
                && text.bytes().all(|byte| byte.is_ascii_digit()));
        // 2^53 - 1 has 16 digits, so a longer number is out of range and need not be parsed.
        if !canonical || text.len() > 16 {
            return None;
        }
        text.parse().ok().and_then(Self::new)
    }
}

impl From<u32> for Int {
    fn from(value: u32) -> Self {
        Self(u64::from(value))
    }
}

impl fmt::Display for Int {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&self.0, f)
    }
}

/// A value of the format (remote-format.md §5): no `null`, integers from 0 to 2^53 - 1. An
/// object's members are kept in ascending UTF-8 byte order of their keys (`String`'s order),
/// which is the order canonical JSON writes them in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Value {
    Bool(bool),
    Int(Int),
    String(String),
    Array(Vec<Value>),
    Object(BTreeMap<String, Value>),
}

impl Value {
    /// The canonical encoding (remote-format.md §5).
    ///
    /// # Panics
    ///
    /// When objects and arrays nest deeper than [`MAX_DEPTH`] levels: such a value has no
    /// canonical form. The format's schemas nest at most five levels.
    pub fn encode(&self) -> Vec<u8> {
        let mut out = Vec::new();
        self.encode_into(&mut out);
        out
    }

    /// Appends the canonical encoding to `out`; see [`Value::encode`].
    pub fn encode_into(&self, out: &mut Vec<u8>) {
        write_value(out, self, 1);
    }

    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_int(&self) -> Option<Int> {
        match self {
            Self::Int(value) => Some(*value),
            _ => None,
        }
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::String(text) => Some(text),
            _ => None,
        }
    }

    pub fn as_array(&self) -> Option<&[Self]> {
        match self {
            Self::Array(items) => Some(items),
            _ => None,
        }
    }

    pub fn as_object(&self) -> Option<&BTreeMap<String, Self>> {
        match self {
            Self::Object(members) => Some(members),
            _ => None,
        }
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

impl From<Int> for Value {
    fn from(value: Int) -> Self {
        Self::Int(value)
    }
}

impl From<String> for Value {
    fn from(text: String) -> Self {
        Self::String(text)
    }
}

impl From<&str> for Value {
    fn from(text: &str) -> Self {
        Self::String(text.to_owned())
    }
}

impl From<Vec<Value>> for Value {
    fn from(items: Vec<Value>) -> Self {
        Self::Array(items)
    }
}

impl From<BTreeMap<String, Value>> for Value {
    fn from(members: BTreeMap<String, Value>) -> Self {
        Self::Object(members)
    }
}

/// Checks that `bytes` are one JSON document as the format reads JSON (the module documentation),
/// without building its value. Returns the number the document's `format_version` member states,
/// as written, when the document is an object with that member and the member is a number: what a
/// record's version is read from before any other rule (remote-format.md §3).
pub(super) fn check(bytes: &[u8]) -> Result<Option<&str>, JsonError> {
    let mut scanner = Scanner::new(bytes, false)?;
    scanner.document()?;
    let text = scanner.text;
    Ok(scanner
        .version
        .map(|(start, end)| &text[start..end])
        .filter(|value| matches!(value.as_bytes()[0], b'-' | b'0'..=b'9')))
}

/// The value of `bytes` when they are exactly the canonical encoding of a value (remote-format.md
/// §5), as a [`Node`] that reads it where it lies.
pub(super) fn canonical(bytes: &[u8]) -> Result<Node<'_>, JsonError> {
    let mut scanner = Scanner::new(bytes, true)?;
    scanner.document()?;
    Ok(Node {
        text: scanner.text,
        at: 0,
    })
}

/// The value of a canonical JSON document (remote-format.md §5): it is exactly the canonical
/// encoding of that value. Built whole, for documents one trusts and for tests: the value of a
/// dense document takes many times the document's size, so the store reads untrusted documents
/// through their schemas instead.
pub fn parse_canonical(bytes: &[u8]) -> Result<Value, JsonError> {
    canonical(bytes).map(Node::to_value)
}

fn write_value(out: &mut Vec<u8>, value: &Value, depth: usize) {
    match value {
        Value::Bool(true) => out.extend_from_slice(b"true"),
        Value::Bool(false) => out.extend_from_slice(b"false"),
        Value::Int(number) => out.extend_from_slice(number.0.to_string().as_bytes()),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            assert!(depth <= MAX_DEPTH, "{TOO_DEEP}");
            out.push(b'[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_value(out, item, depth + 1);
            }
            out.push(b']');
        }
        Value::Object(members) => {
            assert!(depth <= MAX_DEPTH, "{TOO_DEEP}");
            out.push(b'{');
            for (i, (key, item)) in members.iter().enumerate() {
                if i > 0 {
                    out.push(b',');
                }
                write_string(out, key);
                out.push(b':');
                write_value(out, item, depth + 1);
            }
            out.push(b'}');
        }
    }
}

const TOO_DEEP: &str = "a value nested deeper than 16 levels has no canonical encoding";

/// A string as canonical JSON writes it (remote-format.md §5 rule 5): `"` and `\` escaped, the
/// control characters U+0000 to U+001F as their short escape or `\u00` and two lower-case digits,
/// everything else as itself.
fn write_string(out: &mut Vec<u8>, text: &str) {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let bytes = text.as_bytes();
    out.push(b'"');
    let mut unescaped = 0;
    for (i, &byte) in bytes.iter().enumerate() {
        let short: &[u8] = match byte {
            b'"' => b"\\\"",
            b'\\' => b"\\\\",
            0x08 => b"\\b",
            b'\t' => b"\\t",
            b'\n' => b"\\n",
            0x0c => b"\\f",
            b'\r' => b"\\r",
            // Written as `\u00XX` below.
            0x00..=0x1f => b"",
            _ => continue,
        };
        out.extend_from_slice(&bytes[unescaped..i]);
        if short.is_empty() {
            let (high, low) = (
                DIGITS[usize::from(byte >> 4)],
                DIGITS[usize::from(byte & 0xf)],
            );
            out.extend_from_slice(&[b'\\', b'u', b'0', b'0', high, low]);
        } else {
            out.extend_from_slice(short);
        }
        unescaped = i + 1;
    }
    out.extend_from_slice(&bytes[unescaped..]);
    out.push(b'"');
}

/// A value of a canonical JSON document ([`canonical`]), read where it lies in the document's
/// bytes: nothing is copied but the strings taken out, and an object's members or an array's items
/// are found by walking it each time they are asked for.
#[derive(Clone, Copy)]
pub(super) struct Node<'a> {
    text: &'a str,
    /// Where the value starts.
    at: usize,
}

impl fmt::Debug for Node<'_> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // The start of the value only: a document may hold 64 MiB.
        let start: String = self.text[self.at..].chars().take(40).collect();
        f.debug_struct("Node")
            .field("at", &self.at)
            .field("start", &start)
            .finish()
    }
}

impl<'a> Node<'a> {
    fn first(self) -> u8 {
        self.text.as_bytes()[self.at]
    }

    pub(super) fn as_bool(self) -> Option<bool> {
        match self.first() {
            b't' => Some(true),
            b'f' => Some(false),
            _ => None,
        }
    }

    pub(super) fn as_int(self) -> Option<Int> {
        if !self.first().is_ascii_digit() {
            return None;
        }
        let end = value_end(self.text.as_bytes(), self.at);
        Int::parse(&self.text[self.at..end])
    }

    /// The string, its escapes decoded: borrowed from the document unless it has any.
    pub(super) fn as_str(self) -> Option<Cow<'a, str>> {
        (self.first() == b'"').then(|| string_at(self.text, self.at))
    }

    pub(super) fn as_array(self) -> Option<Items<'a>> {
        (self.first() == b'[').then_some(Items {
            text: self.text,
            pos: self.at + 1,
        })
    }

    pub(super) fn as_object(self) -> Option<Object<'a>> {
        (self.first() == b'{').then_some(Object {
            text: self.text,
            at: self.at,
        })
    }

    /// The whole value, built in memory; see [`parse_canonical`].
    pub(super) fn to_value(self) -> Value {
        if let Some(object) = self.as_object() {
            Value::Object(
                object
                    .members()
                    .map(|(key, value)| (key.into_owned(), value.to_value()))
                    .collect(),
            )
        } else if let Some(items) = self.as_array() {
            Value::Array(items.map(Node::to_value).collect())
        } else if let Some(text) = self.as_str() {
            Value::String(text.into_owned())
        } else if let Some(value) = self.as_bool() {
            Value::Bool(value)
        } else {
            Value::Int(
                self.as_int()
                    .expect("a canonical value is an integer when nothing else"),
            )
        }
    }
}

/// An object of a canonical document ([`Node::as_object`]).
#[derive(Clone, Copy)]
pub(super) struct Object<'a> {
    text: &'a str,
    at: usize,
}

impl<'a> Object<'a> {
    /// The members in the order of their keys, which is the document's.
    pub(super) fn members(self) -> Members<'a> {
        Members {
            text: self.text,
            pos: self.at + 1,
        }
    }

    /// The member `key`.
    pub(super) fn get(self, key: &str) -> Option<Node<'a>> {
        for (found, value) in self.members() {
            match found.as_ref().cmp(key) {
                Ordering::Less => {}
                Ordering::Equal => return Some(value),
                Ordering::Greater => return None,
            }
        }
        None
    }
}

/// The members of an object of a canonical document, each key decoded.
#[derive(Clone)]
pub(super) struct Members<'a> {
    text: &'a str,
    /// At the next key, or at the object's `}`.
    pos: usize,
}

impl<'a> Iterator for Members<'a> {
    type Item = (Cow<'a, str>, Node<'a>);

    fn next(&mut self) -> Option<Self::Item> {
        let bytes = self.text.as_bytes();
        if bytes[self.pos] == b'}' {
            return None;
        }
        let end = string_end(bytes, self.pos);
        let key = decode(self.text, self.pos, end);
        // After the key's closing quote, the colon.
        let at = end + 1;
        self.pos = value_end(bytes, at);
        if bytes[self.pos] == b',' {
            self.pos += 1;
        }
        Some((
            key,
            Node {
                text: self.text,
                at,
            },
        ))
    }
}

/// The items of an array of a canonical document.
#[derive(Clone)]
pub(super) struct Items<'a> {
    text: &'a str,
    /// At the next item, or at the array's `]`.
    pos: usize,
}

impl<'a> Iterator for Items<'a> {
    type Item = Node<'a>;

    fn next(&mut self) -> Option<Node<'a>> {
        let bytes = self.text.as_bytes();
        if bytes[self.pos] == b']' {
            return None;
        }
        let at = self.pos;
        self.pos = value_end(bytes, at);
        if bytes[self.pos] == b',' {
            self.pos += 1;
        }
        Some(Node {
            text: self.text,
            at,
        })
    }
}

/// The string whose opening quote is at `quote` in a checked document, its escapes decoded.
fn string_at(text: &str, quote: usize) -> Cow<'_, str> {
    decode(text, quote, string_end(text.as_bytes(), quote))
}

/// The checked string from its opening quote at `quote` to just after its closing quote at `end`,
/// its escapes decoded: borrowed when it has none.
fn decode(text: &str, quote: usize, end: usize) -> Cow<'_, str> {
    let content = &text[quote + 1..end - 1];
    if content.contains('\\') {
        Cow::Owned(Chars::at(text, quote).collect())
    } else {
        Cow::Borrowed(content)
    }
}

/// How the checked keys whose opening quotes are at `a` and `b` in `text` compare, decoded: as
/// canonical JSON orders keys. Keys without escapes compare as their bytes.
fn compare_keys(text: &str, a: usize, b: usize) -> Ordering {
    let bytes = text.as_bytes();
    let a_text = &text[a + 1..string_end(bytes, a) - 1];
    let b_text = &text[b + 1..string_end(bytes, b) - 1];
    if a_text.contains('\\') || b_text.contains('\\') {
        Chars::at(text, a).cmp(Chars::at(text, b))
    } else {
        a_text.cmp(b_text)
    }
}

/// The offset after the string whose opening quote is at `quote` in a checked document.
fn string_end(bytes: &[u8], quote: usize) -> usize {
    let mut pos = quote + 1;
    loop {
        match bytes[pos] {
            b'"' => {
                #[cfg(test)]
                scanned::add(pos + 1 - quote);
                return pos + 1;
            }
            // The escaped character, or the `u` of `\u` and four digits, none of them a quote.
            b'\\' => pos += 2,
            _ => pos += 1,
        }
    }
}

/// In tests, the bytes of strings [`string_end`] went through on this thread: the work of finding
/// where checked strings end, which a reader does again each time it takes a key out or compares
/// two, so that tests can count it rather than time it.
#[cfg(test)]
mod scanned {
    use std::cell::Cell;

    thread_local! {
        static SCANNED: Cell<usize> = const { Cell::new(0) };
    }

    pub(super) fn add(bytes: usize) {
        SCANNED.set(SCANNED.get() + bytes);
    }

    /// What `run` returns, and the bytes of strings it went through.
    pub(super) fn during<T>(run: impl FnOnce() -> T) -> (T, usize) {
        let start = SCANNED.get();
        let result = run();
        (result, SCANNED.get() - start)
    }
}

/// The offset after the value at `at` in a checked canonical document, which has no white space.
fn value_end(bytes: &[u8], at: usize) -> usize {
    match bytes[at] {
        b'"' => string_end(bytes, at),
        b'{' | b'[' => {
            let mut depth = 0_usize;
            let mut pos = at;
            loop {
                match bytes[pos] {
                    b'"' => {
                        pos = string_end(bytes, pos);
                        continue;
                    }
                    b'{' | b'[' => depth += 1,
                    b'}' | b']' => {
                        depth -= 1;
                        if depth == 0 {
                            return pos + 1;
                        }
                    }
                    _ => {}
                }
                pos += 1;
            }
        }
        b't' => at + 4,
        b'f' => at + 5,
        _ => {
            let digits = bytes[at..].iter().take_while(|byte| byte.is_ascii_digit());
            at + digits.count()
        }
    }
}

/// The characters of a checked string ([`Chars::at`] its opening quote), its escapes decoded.
/// Characters compare as their UTF-8 bytes do, so keys compare in canonical JSON's order.
#[derive(Debug, Clone)]
struct Chars<'a> {
    /// What follows the characters read: the string's closing quote at the end.
    rest: &'a str,
}

impl<'a> Chars<'a> {
    fn at(text: &'a str, quote: usize) -> Self {
        Self {
            rest: &text[quote + 1..],
        }
    }
}

impl Iterator for Chars<'_> {
    type Item = char;

    fn next(&mut self) -> Option<char> {
        let mut chars = self.rest.chars();
        match chars.next()? {
            '"' => None,
            '\\' => {
                let (ch, len) = unescape(self.rest.as_bytes());
                self.rest = &self.rest[len..];
                Some(ch)
            }
            ch => {
                self.rest = chars.as_str();
                Some(ch)
            }
        }
    }
}

/// The character the checked escape at the start of `bytes` stands for, and the escape's length
/// in bytes: 2, or 6 for `\u` and four digits, or 12 for a surrogate pair.
fn unescape(bytes: &[u8]) -> (char, usize) {
    let short = match bytes[1] {
        b'"' => '"',
        b'\\' => '\\',
        b'/' => '/',
        b'b' => '\u{8}',
        b'f' => '\u{c}',
        b'n' => '\n',
        b'r' => '\r',
        b't' => '\t',
        _ => {
            let unit = hex_unit(&bytes[2..6]).unwrap_or(0xfffd);
            if (0xd800..0xdc00).contains(&unit) {
                let low = hex_unit(&bytes[8..12]).unwrap_or(0xdc00);
                let code = 0x10000 + ((unit - 0xd800) << 10) + (low.wrapping_sub(0xdc00) & 0x3ff);
                return (char::from_u32(code).unwrap_or('\u{fffd}'), 12);
            }
            return (char::from_u32(unit).unwrap_or('\u{fffd}'), 6);
        }
    };
    (short, 2)
}

/// The UTF-16 code unit four hexadecimal digits of either case write.
fn hex_unit(digits: &[u8]) -> Option<u32> {
    digits.iter().try_fold(0, |unit, &digit| {
        Some((unit << 4) | char::from(digit).to_digit(16)?)
    })
}

/// A recursive descent over a document's UTF-8 text that checks it and builds nothing: as any JSON
/// document of the format ([`check`]), or as canonical JSON ([`canonical`]). Every structural
/// character is ASCII, so `pos` only ever stops on character boundaries.
struct Scanner<'a> {
    text: &'a str,
    pos: usize,
    /// The objects and arrays open at `pos`.
    depth: usize,
    /// Canonical JSON only: no white space, keys in ascending order, the escapes and integers rule
    /// 5 and rule 2 write.
    canonical: bool,
    /// The opening quotes of the keys of the open objects whose keys came out of ascending order,
    /// to find a key such an object repeats when it ends ([`Scanner::repeated_key`]).
    keys: Vec<u64>,
    /// Where the value of the document's own `format_version` member starts and ends.
    version: Option<(usize, usize)>,
    /// How canonical JSON writes the character of an escape, to compare with the escape.
    written: Vec<u8>,
}

impl<'a> Scanner<'a> {
    fn new(bytes: &'a [u8], canonical: bool) -> Result<Self, JsonError> {
        let text = std::str::from_utf8(bytes).map_err(|error| JsonError::Utf8 {
            offset: error.valid_up_to(),
        })?;
        Ok(Self {
            text,
            pos: 0,
            depth: 0,
            canonical,
            keys: Vec::new(),
            version: None,
            written: Vec::new(),
        })
    }

    fn bytes(&self) -> &'a [u8] {
        self.text.as_bytes()
    }

    fn peek(&self) -> Option<u8> {
        self.peek_at(0)
    }

    fn peek_at(&self, ahead: usize) -> Option<u8> {
        self.bytes().get(self.pos + ahead).copied()
    }

    fn syntax(&self) -> JsonError {
        JsonError::Syntax { offset: self.pos }
    }

    /// One value and nothing after it.
    fn document(&mut self) -> Result<(), JsonError> {
        self.value()?;
        self.space()?;
        if self.pos == self.text.len() {
            Ok(())
        } else {
            Err(self.syntax())
        }
    }

    /// RFC 8259's white space, and no other; canonical JSON has none.
    fn space(&mut self) -> Result<(), JsonError> {
        let is_space = |byte| matches!(byte, Some(b' ' | b'\t' | b'\n' | b'\r'));
        if is_space(self.peek()) && self.canonical {
            return Err(JsonError::NotCanonical { offset: self.pos });
        }
        while is_space(self.peek()) {
            self.pos += 1;
        }
        Ok(())
    }

    fn value(&mut self) -> Result<(), JsonError> {
        self.space()?;
        match self.peek() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => self.string(),
            _ => {
                let rest = &self.bytes()[self.pos..];
                for word in ["true", "false"] {
                    if rest.starts_with(word.as_bytes()) {
                        self.pos += word.len();
                        return Ok(());
                    }
                }
                if rest.starts_with(b"null") {
                    if self.canonical {
                        return Err(JsonError::Null);
                    }
                    self.pos += 4;
                    return Ok(());
                }
                self.number()
            }
        }
    }

    /// Steps over the opening bracket of an object or array, one level deeper.
    fn open(&mut self) -> Result<(), JsonError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(JsonError::Depth { offset: self.pos });
        }
        self.pos += 1;
        Ok(())
    }

    fn object(&mut self) -> Result<(), JsonError> {
        let start = self.pos;
        self.open()?;
        // The keys this object collects, once they come out of order, start here.
        let base = self.keys.len();
        let mut collecting = false;
        let mut previous: Option<usize> = None;
        self.space()?;
        if self.peek() == Some(b'}') {
            self.pos += 1;
        } else {
            loop {
                self.space()?;
                if self.peek() != Some(b'"') {
                    return Err(self.syntax());
                }
                let key = self.pos;
                self.string()?;
                if let Some(previous) = previous {
                    match self.compare_keys(previous, key) {
                        Ordering::Less => {}
                        // While the keys ascend, a repeat comes right after its twin.
                        Ordering::Equal => return Err(JsonError::DuplicateKey { offset: key }),
                        Ordering::Greater if self.canonical => {
                            return Err(JsonError::NotCanonical { offset: key });
                        }
                        Ordering::Greater if !collecting => {
                            collecting = true;
                            self.collect_keys(start, key);
                        }
                        Ordering::Greater => {}
                    }
                }
                if collecting {
                    self.keys.push(key as u64);
                }
                previous = Some(key);
                let version = !self.canonical
                    && self.depth == 1
                    && Chars::at(self.text, key).eq("format_version".chars());
                self.space()?;
                if self.peek() != Some(b':') {
                    return Err(self.syntax());
                }
                self.pos += 1;
                self.space()?;
                let value = self.pos;
                self.value()?;
                if version {
                    self.version = Some((value, self.pos));
                }
                self.space()?;
                match self.peek() {
                    Some(b',') => self.pos += 1,
                    Some(b'}') => {
                        self.pos += 1;
                        break;
                    }
                    _ => return Err(self.syntax()),
                }
            }
        }
        if collecting {
            if let Some(offset) = self.repeated_key(base) {
                return Err(JsonError::DuplicateKey { offset });
            }
            self.keys.truncate(base);
        }
        self.depth -= 1;
        Ok(())
    }

    fn compare_keys(&self, a: usize, b: usize) -> Ordering {
        compare_keys(self.text, a, b)
    }

    /// Collects the keys of the object whose opening brace is at `start` that come before `end`,
    /// once a key there is out of order: the part was checked already.
    fn collect_keys(&mut self, start: usize, end: usize) {
        let bytes = self.bytes();
        let mut pos = start + 1;
        let mut depth = 0_usize;
        let mut key_next = true;
        while pos < end {
            match bytes[pos] {
                b'"' => {
                    if depth == 0 && key_next {
                        self.keys.push(pos as u64);
                        key_next = false;
                    }
                    pos = string_end(bytes, pos);
                    continue;
                }
                b'{' | b'[' => depth += 1,
                b'}' | b']' => depth -= 1,
                b',' if depth == 0 => key_next = true,
                _ => {}
            }
            pos += 1;
        }
    }

    /// The first key in document order that repeats an earlier key of the object whose keys were
    /// collected from `base` on.
    ///
    /// Each key's place gets a hash of the key's decoded characters above it, in the same eight
    /// bytes, and the keys are sorted by that: equal keys hash alike, so they end up side by side,
    /// in document order. A key is read once to hash it and compared with another only when both
    /// share a hash, which different keys rarely do, so the work is the keys' bytes and a sort of
    /// integers: never a long key compared again with every other, as sorting the keys by their
    /// text would where it partitions around that key. The hash's key is random, so a document
    /// cannot be made of different keys that share hashes.
    fn repeated_key(&mut self, base: usize) -> Option<usize> {
        let text = self.text;
        // The low bits hold any place in the document; the hash fills the bits above them.
        let leading = (text.len() as u64).leading_zeros();
        let place_bits = u64::BITS - leading;
        let place = |entry: u64| (entry & (u64::MAX >> leading)) as usize;
        let hashes = RandomState::new();
        let keys = &mut self.keys[base..];
        for entry in keys.iter_mut() {
            let mut hasher = hashes.build_hasher();
            // One write per character, whatever escape writes it, so equal keys hash alike.
            for ch in Chars::at(text, place(*entry)) {
                hasher.write_u32(u32::from(ch));
            }
            *entry |= hasher.finish() << place_bits;
        }
        keys.sort_unstable();
        keys.chunk_by(|a, b| a >> place_bits == b >> place_bits)
            .filter_map(|run| {
                // The run's first key, in document order, that equals an earlier one in it.
                run.iter().enumerate().skip(1).find_map(|(i, &later)| {
                    let later = place(later);
                    run[..i]
                        .iter()
                        .any(|&earlier| compare_keys(text, place(earlier), later).is_eq())
                        .then_some(later)
                })
            })
            .min()
    }

    fn array(&mut self) -> Result<(), JsonError> {
        self.open()?;
        self.space()?;
        if self.peek() == Some(b']') {
            self.pos += 1;
        } else {
            loop {
                self.value()?;
                self.space()?;
                match self.peek() {
                    Some(b',') => self.pos += 1,
                    Some(b']') => {
                        self.pos += 1;
                        break;
                    }
                    _ => return Err(self.syntax()),
                }
            }
        }
        self.depth -= 1;
        Ok(())
    }

    /// A string whose opening quote is at `pos`.
    fn string(&mut self) -> Result<(), JsonError> {
        self.pos += 1;
        loop {
            let rest = &self.bytes()[self.pos..];
            let run = rest
                .iter()
                .position(|&byte| byte == b'"' || byte == b'\\' || byte < 0x20)
                .unwrap_or(rest.len());
            self.pos += run;
            match self.peek() {
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(());
                }
                Some(b'\\') => self.escape()?,
                // The document ends inside the string, or a control character is not escaped.
                _ => return Err(self.syntax()),
            }
        }
    }

    /// The escape at `pos`. In canonical JSON, only those rule 5 writes: a character that has none
    /// is written as itself.
    fn escape(&mut self) -> Result<(), JsonError> {
        let at = self.pos;
        let ch = match self.peek_at(1) {
            Some(b'"') => '"',
            Some(b'\\') => '\\',
            Some(b'/') => '/',
            Some(b'b') => '\u{8}',
            Some(b'f') => '\u{c}',
            Some(b'n') => '\n',
            Some(b'r') => '\r',
            Some(b't') => '\t',
            Some(b'u') => {
                let unit = self
                    .bytes()
                    .get(at + 2..at + 6)
                    .and_then(hex_unit)
                    .ok_or(JsonError::Syntax { offset: at })?;
                self.pos += 6;
                let ch = self.unit_char(unit, at)?;
                return self.written_as(ch, at);
            }
            _ => return Err(JsonError::Syntax { offset: at }),
        };
        self.pos += 2;
        self.written_as(ch, at)
    }

    /// The character an escaped code unit stands for; a high surrogate takes the low surrogate
    /// escaped right after it (at `pos`) to make one character.
    fn unit_char(&mut self, unit: u32, at: usize) -> Result<char, JsonError> {
        let lone = JsonError::LoneSurrogate { offset: at };
        match unit {
            0xd800..=0xdbff => {
                let low = self
                    .bytes()
                    .get(self.pos..self.pos + 6)
                    .filter(|escape| escape.starts_with(b"\\u"))
                    .and_then(|escape| hex_unit(&escape[2..]))
                    .filter(|low| (0xdc00..=0xdfff).contains(low))
                    .ok_or(lone)?;
                self.pos += 6;
                char::from_u32(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)).ok_or(lone)
            }
            0xdc00..=0xdfff => Err(lone),
            _ => char::from_u32(unit).ok_or(lone),
        }
    }

    /// In canonical JSON, checks that the escape from `at` to `pos`, which stands for `ch`, is how
    /// [`Value::encode`] writes `ch` (rule 5); otherwise the first byte that differs is reported.
    fn written_as(&mut self, ch: char, at: usize) -> Result<(), JsonError> {
        if !self.canonical {
            return Ok(());
        }
        let written = &mut self.written;
        written.clear();
        write_string(written, ch.encode_utf8(&mut [0; 4]));
        // Without its quotes. An escape that differs from it differs within its length: the
        // canonical escapes are `\` and one character, or `\u00` and two digits like this one.
        let ours = &written[1..written.len() - 1];
        let theirs = &self.text.as_bytes()[at..self.pos];
        match ours
            .iter()
            .zip(theirs)
            .position(|(ours, theirs)| ours != theirs)
        {
            None => {
                debug_assert_eq!(
                    ours, theirs,
                    "an escape equal to the canonical one so far is it"
                );
                Ok(())
            }
            Some(differs) => Err(JsonError::NotCanonical {
                offset: at + differs,
            }),
        }
    }

    /// A number as RFC 8259 writes it, `-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?`; in
    /// canonical JSON only an integer of rule 2. A fraction or exponent without digits is not taken,
    /// so what follows fails as syntax.
    fn number(&mut self) -> Result<(), JsonError> {
        let start = self.pos;
        if self.peek() == Some(b'-') {
            self.pos += 1;
        }
        match self.peek() {
            Some(b'0') => self.pos += 1,
            Some(b'1'..=b'9') => self.skip_digits(),
            _ => return Err(self.syntax()),
        }
        if self.peek() == Some(b'.') && self.peek_at(1).is_some_and(|b| b.is_ascii_digit()) {
            self.pos += 1;
            self.skip_digits();
        }
        if matches!(self.peek(), Some(b'e' | b'E')) {
            let sign = usize::from(matches!(self.peek_at(1), Some(b'+' | b'-')));
            if self.peek_at(1 + sign).is_some_and(|b| b.is_ascii_digit()) {
                self.pos += 1 + sign;
                self.skip_digits();
            }
        }
        if self.canonical && Int::parse(&self.text[start..self.pos]).is_none() {
            return Err(JsonError::Number);
        }
        Ok(())
    }

    fn skip_digits(&mut self) {
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.pos += 1;
        }
    }
}

#[cfg(test)]
mod tests;
