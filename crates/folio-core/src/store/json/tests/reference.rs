//! The reader this module had before it read documents without building their values: a
//! recursive descent that builds the whole document ([`parse`]), then its value and canonical
//! encoding ([`parse_canonical`]). Kept as the model the readers must agree with: they accept and
//! refuse exactly the documents it does, and read the same values and versions.

use std::collections::BTreeMap;
use std::collections::btree_map::Entry;

use super::super::{Int, JsonError, MAX_DEPTH, Value};

/// A JSON value as [`parse`] read it, before the format's value rules: `null` and numbers of
/// every form included.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum Json {
    Null,
    Bool(bool),
    /// A number exactly as written: `1`, `-0`, `1.5e3`.
    Number(String),
    String(String),
    Array(Vec<Json>),
    Object(BTreeMap<String, Json>),
}

impl Json {
    /// The member `key` of an object; `None` when it has none or is not an object.
    pub(super) fn get(&self, key: &str) -> Option<&Self> {
        match self {
            Self::Object(members) => members.get(key),
            _ => None,
        }
    }

    fn into_value(self) -> Result<Value, JsonError> {
        Ok(match self {
            Self::Null => return Err(JsonError::Null),
            Self::Bool(value) => Value::Bool(value),
            Self::Number(text) => Value::Int(Int::parse(&text).ok_or(JsonError::Number)?),
            Self::String(text) => Value::String(text),
            Self::Array(items) => Value::Array(
                items
                    .into_iter()
                    .map(Self::into_value)
                    .collect::<Result<_, _>>()?,
            ),
            Self::Object(members) => Value::Object(
                members
                    .into_iter()
                    .map(|(key, value)| Ok((key, value.into_value()?)))
                    .collect::<Result<_, JsonError>>()?,
            ),
        })
    }
}

/// The `format_version` a document states, as the store read it: the number's text when the
/// document is an object whose `format_version` is a number.
pub(super) fn stated_number(document: &Json) -> Option<&str> {
    match document.get("format_version") {
        Some(Json::Number(text)) => Some(text),
        _ => None,
    }
}

/// The value of a canonical document: it parses, follows the value rules, and encodes back to
/// exactly `bytes`.
pub(super) fn parse_canonical(bytes: &[u8]) -> Result<Value, JsonError> {
    let value = parse(bytes)?.into_value()?;
    let encoded = value.encode();
    if encoded != bytes {
        let offset = encoded
            .iter()
            .zip(bytes)
            .position(|(ours, theirs)| ours != theirs)
            .unwrap_or_else(|| encoded.len().min(bytes.len()));
        return Err(JsonError::NotCanonical { offset });
    }
    Ok(value)
}

pub(super) fn parse(bytes: &[u8]) -> Result<Json, JsonError> {
    let text = std::str::from_utf8(bytes).map_err(|error| JsonError::Utf8 {
        offset: error.valid_up_to(),
    })?;
    let mut parser = Parser {
        text,
        pos: 0,
        depth: 0,
    };
    let value = parser.value()?;
    parser.skip_space();
    if parser.pos == text.len() {
        Ok(value)
    } else {
        Err(parser.syntax())
    }
}

struct Parser<'a> {
    text: &'a str,
    pos: usize,
    depth: usize,
}

impl Parser<'_> {
    fn peek(&self) -> Option<u8> {
        self.peek_at(0)
    }

    fn peek_at(&self, ahead: usize) -> Option<u8> {
        self.text.as_bytes().get(self.pos + ahead).copied()
    }

    fn syntax(&self) -> JsonError {
        JsonError::Syntax { offset: self.pos }
    }

    fn skip_space(&mut self) {
        while matches!(self.peek(), Some(b' ' | b'\t' | b'\n' | b'\r')) {
            self.pos += 1;
        }
    }

    fn value(&mut self) -> Result<Json, JsonError> {
        self.skip_space();
        match self.peek() {
            Some(b'{') => self.object(),
            Some(b'[') => self.array(),
            Some(b'"') => self.string().map(Json::String),
            _ => {
                let rest = &self.text.as_bytes()[self.pos..];
                for (word, value) in [("true", true), ("false", false)] {
                    if rest.starts_with(word.as_bytes()) {
                        self.pos += word.len();
                        return Ok(Json::Bool(value));
                    }
                }
                if rest.starts_with(b"null") {
                    self.pos += 4;
                    return Ok(Json::Null);
                }
                self.number()
            }
        }
    }

    fn open(&mut self) -> Result<(), JsonError> {
        self.depth += 1;
        if self.depth > MAX_DEPTH {
            return Err(JsonError::Depth { offset: self.pos });
        }
        self.pos += 1;
        Ok(())
    }

    fn object(&mut self) -> Result<Json, JsonError> {
        self.open()?;
        let mut members = BTreeMap::new();
        self.skip_space();
        if self.peek() == Some(b'}') {
            self.pos += 1;
        } else {
            loop {
                self.skip_space();
                if self.peek() != Some(b'"') {
                    return Err(self.syntax());
                }
                let at = self.pos;
                let Entry::Vacant(slot) = members.entry(self.string()?) else {
                    return Err(JsonError::DuplicateKey { offset: at });
                };
                self.skip_space();
                if self.peek() != Some(b':') {
                    return Err(self.syntax());
                }
                self.pos += 1;
                slot.insert(self.value()?);
                self.skip_space();
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
        self.depth -= 1;
        Ok(Json::Object(members))
    }

    fn array(&mut self) -> Result<Json, JsonError> {
        self.open()?;
        let mut items = Vec::new();
        self.skip_space();
        if self.peek() == Some(b']') {
            self.pos += 1;
        } else {
            loop {
                items.push(self.value()?);
                self.skip_space();
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
        Ok(Json::Array(items))
    }

    fn string(&mut self) -> Result<String, JsonError> {
        self.pos += 1;
        let mut out = String::new();
        loop {
            let rest = &self.text.as_bytes()[self.pos..];
            let run = rest
                .iter()
                .position(|&byte| byte == b'"' || byte == b'\\' || byte < 0x20)
                .unwrap_or(rest.len());
            out.push_str(&self.text[self.pos..self.pos + run]);
            self.pos += run;
            match self.peek() {
                Some(b'"') => {
                    self.pos += 1;
                    return Ok(out);
                }
                Some(b'\\') => out.push(self.escape()?),
                _ => return Err(self.syntax()),
            }
        }
    }

    fn escape(&mut self) -> Result<char, JsonError> {
        let at = self.pos;
        let short = match self.peek_at(1) {
            Some(b'"') => '"',
            Some(b'\\') => '\\',
            Some(b'/') => '/',
            Some(b'b') => '\u{8}',
            Some(b'f') => '\u{c}',
            Some(b'n') => '\n',
            Some(b'r') => '\r',
            Some(b't') => '\t',
            Some(b'u') => {
                let unit = self.code_unit(at).ok_or(JsonError::Syntax { offset: at })?;
                self.pos += 6;
                return self.unit_char(unit, at);
            }
            _ => return Err(JsonError::Syntax { offset: at }),
        };
        self.pos += 2;
        Ok(short)
    }

    fn code_unit(&self, at: usize) -> Option<u32> {
        let escape = self.text.as_bytes().get(at..at + 6)?;
        if &escape[..2] != b"\\u" {
            return None;
        }
        escape[2..].iter().try_fold(0, |unit, &digit| {
            Some((unit << 4) | char::from(digit).to_digit(16)?)
        })
    }

    fn unit_char(&mut self, unit: u32, at: usize) -> Result<char, JsonError> {
        let lone = JsonError::LoneSurrogate { offset: at };
        match unit {
            0xd800..=0xdbff => {
                let low = self
                    .code_unit(self.pos)
                    .filter(|low| (0xdc00..=0xdfff).contains(low))
                    .ok_or(lone)?;
                self.pos += 6;
                char::from_u32(0x10000 + ((unit - 0xd800) << 10) + (low - 0xdc00)).ok_or(lone)
            }
            0xdc00..=0xdfff => Err(lone),
            _ => char::from_u32(unit).ok_or(lone),
        }
    }

    fn number(&mut self) -> Result<Json, JsonError> {
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
        Ok(Json::Number(self.text[start..self.pos].to_owned()))
    }

    fn skip_digits(&mut self) {
        while self.peek().is_some_and(|b| b.is_ascii_digit()) {
            self.pos += 1;
        }
    }
}
