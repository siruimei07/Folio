//! The XML of a Word package's parts, read under the reader's rules: no DTD, no entity but XML's
//! five and character references, elements nested at most [`MAX_DEPTH`] deep, and elements and
//! attributes matched by namespace URI (transitional or strict), never by prefix.

use std::borrow::Cow;
use std::fmt::Display;
use std::io::BufRead;

use quick_xml::XmlVersion;
use quick_xml::escape::resolve_xml_entity;
use quick_xml::events::attributes::{AttrError, Attribute};
use quick_xml::events::{BytesRef, BytesStart, Event};
use quick_xml::name::{Namespace, QName, ResolveResult};
use quick_xml::reader::NsReader;

use super::{WordError, WordText};

/// The deepest elements may nest.
pub(super) const MAX_DEPTH: usize = 256;

const WORD: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const WORD_STRICT: &str = "http://purl.oclc.org/ooxml/wordprocessingml/main";
const MATH: &str = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const MATH_STRICT: &str = "http://purl.oclc.org/ooxml/officeDocument/math";
const COMPATIBILITY: &str = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const RELATIONSHIPS: &str = "http://schemas.openxmlformats.org/package/2006/relationships";

/// Relationship types are one of these followed by a name such as `officeDocument`.
const RELATIONSHIP_TYPES: [&str; 2] = [
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/",
    "http://purl.oclc.org/ooxml/officeDocument/relationships/",
];

/// The namespaces the reader tells apart.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Space {
    /// WordprocessingML.
    Word,
    /// Office Math.
    Math,
    /// Markup compatibility (`mc:AlternateContent`).
    Compatibility,
    /// Package relationships.
    Relationships,
    /// No namespace.
    Unqualified,
    Other,
}

impl Space {
    fn of(resolved: &ResolveResult<'_>) -> Self {
        match resolved {
            ResolveResult::Bound(Namespace(uri)) => match *uri {
                WORD | WORD_STRICT => Self::Word,
                MATH | MATH_STRICT => Self::Math,
                COMPATIBILITY => Self::Compatibility,
                RELATIONSHIPS => Self::Relationships,
                _ => Self::Other,
            },
            ResolveResult::Unbound => Self::Unqualified,
            ResolveResult::Unknown(_) => Self::Other,
        }
    }
}

/// One step through a part.
enum Step<'b> {
    /// A start tag, or an empty element tag when `empty`.
    Start {
        space: Space,
        element: BytesStart<'b>,
        empty: bool,
    },
    End,
    /// Character data, with references resolved and line breaks as `\n`.
    Text(Cow<'b, str>),
    /// A declaration, comment or processing instruction.
    Other,
    Eof,
}

/// A part's XML under the reader's rules.
struct Xml<'p, R> {
    reader: NsReader<R>,
    /// The part's name, for error details.
    part: &'p str,
    depth: usize,
    seen_root: bool,
}

impl<'p, R: BufRead> Xml<'p, R> {
    fn new(source: R, part: &'p str) -> Self {
        Self {
            reader: NsReader::from_reader(source),
            part,
            depth: 0,
            seen_root: false,
        }
    }

    fn next<'b>(&mut self, buf: &'b mut Vec<u8>) -> Result<Step<'b>, WordError> {
        let part = self.part;
        let (resolved, event) = self
            .reader
            .read_resolved_event_into(buf)
            .map_err(|error| invalid(part, error))?;
        let space = Space::of(&resolved);
        Ok(match event {
            Event::Start(element) => {
                if self.depth >= MAX_DEPTH {
                    return Err(too_deep(part));
                }
                self.depth += 1;
                self.seen_root = true;
                Step::Start {
                    space,
                    element,
                    empty: false,
                }
            }
            Event::Empty(element) => {
                if self.depth >= MAX_DEPTH {
                    return Err(too_deep(part));
                }
                self.seen_root = true;
                Step::Start {
                    space,
                    element,
                    empty: true,
                }
            }
            Event::End(_) => {
                self.depth = self.depth.saturating_sub(1);
                Step::End
            }
            Event::Text(text) => Step::Text(text.xml10_content()),
            Event::CData(data) => Step::Text(data.xml10_content()),
            Event::GeneralRef(reference) => Step::Text(resolve(part, &reference)?),
            Event::DocType(_) => return Err(invalid(part, "a document type declaration")),
            Event::Decl(_) | Event::PI(_) | Event::Comment(_) => Step::Other,
            Event::Eof if self.depth > 0 => return Err(invalid(part, "ends inside an element")),
            Event::Eof if !self.seen_root => return Err(invalid(part, "no root element")),
            Event::Eof => Step::Eof,
        })
    }

    /// The attributes of `element` that `wanted` names ([`find_attributes`]), prefixes resolved
    /// in the element's scope.
    fn attributes<'e, const N: usize>(
        &self,
        element: &'e BytesStart<'_>,
        wanted: [(Space, &str); N],
    ) -> Result<[Option<Attribute<'e>>; N], WordError> {
        let resolver = self.reader.resolver();
        find_attributes(element, wanted, |key| {
            Space::of(&resolver.resolve_attribute(key).0)
        })
        .map_err(|error| invalid(self.part, error))
    }

    /// An attribute's value, references resolved. Only the values read are resolved, so an
    /// undeclared entity in an attribute the reader does not use goes unnoticed.
    fn value(&self, attribute: Option<Attribute<'_>>) -> Result<Option<String>, WordError> {
        attribute
            .map(|attribute| {
                attribute
                    .normalized_value(XmlVersion::Implicit1_0)
                    .map(Cow::into_owned)
                    .map_err(|error| invalid(self.part, error))
            })
            .transpose()
    }
}

/// The first attribute of `element` with each of `wanted`'s namespace and local name, found in one
/// pass over its attributes, which stops once each is found.
///
/// A crafted tag may hold millions of attributes, so the work must grow with the tag's length
/// only. quick-xml's duplicate check is off, since it keeps every name it has seen (hundreds of
/// MiB for such a tag): a repeated name is not refused, and its first value counts. An unprefixed
/// name is in no namespace, so it is matched as it is; `space_of`, which walks the bindings in
/// scope (up to 128), is called only for a prefixed name whose local part is wanted, once for each.
pub(super) fn find_attributes<'e, const N: usize>(
    element: &'e BytesStart<'_>,
    wanted: [(Space, &str); N],
    mut space_of: impl FnMut(QName<'_>) -> Space,
) -> Result<[Option<Attribute<'e>>; N], AttrError> {
    let mut found = [const { None }; N];
    let mut attributes = element.attributes();
    attributes.with_checks(false);
    for attribute in attributes {
        let attribute = attribute?;
        let (local, prefix) = attribute.key.decompose();
        let mut space = None;
        for (slot, &(wanted_space, wanted_local)) in found.iter_mut().zip(&wanted) {
            if slot.is_some() || local.as_ref() != wanted_local {
                continue;
            }
            let matches = match (prefix, wanted_space) {
                (None, wanted_space) => wanted_space == Space::Unqualified,
                (Some(_), Space::Unqualified) => false,
                (Some(_), wanted_space) => {
                    *space.get_or_insert_with(|| space_of(attribute.key)) == wanted_space
                }
            };
            if matches {
                *slot = Some(attribute.clone());
            }
        }
        if found.iter().all(Option::is_some) {
            break;
        }
    }
    Ok(found)
}

/// A character reference, or one of XML's five entities; any other entity is refused.
fn resolve(part: &str, reference: &BytesRef<'_>) -> Result<Cow<'static, str>, WordError> {
    let character = reference
        .resolve_char_ref()
        .map_err(|error| invalid(part, error))?;
    if let Some(character) = character {
        return Ok(Cow::Owned(character.into()));
    }
    let name: &str = reference;
    resolve_xml_entity(name).map(Cow::Borrowed).ok_or_else(|| {
        let name = &name[..name.floor_char_boundary(32)];
        invalid(part, format_args!("the undeclared entity &{name};"))
    })
}

fn invalid(part: &str, detail: impl Display) -> WordError {
    WordError::Invalid(format!("{part}: {detail}"))
}

fn too_deep(part: &str) -> WordError {
    WordError::TooLarge(format!(
        "{part}: elements nested more than {MAX_DEPTH} deep"
    ))
}

/// The target of the first internal relationship of each of `kinds` (such as `officeDocument`
/// or `footnotes`, transitional or strict) in a relationships part.
pub(super) fn relationships<const N: usize>(
    source: impl BufRead,
    part: &str,
    kinds: [&str; N],
) -> Result<[Option<String>; N], WordError> {
    let mut xml = Xml::new(source, part);
    let mut targets = [const { None }; N];
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match xml.next(&mut buf)? {
            Step::Start {
                space: Space::Relationships,
                element,
                ..
            } if element.local_name().as_ref() == "Relationship" => {
                let [kind, mode, target] = xml.attributes(
                    &element,
                    [
                        (Space::Unqualified, "Type"),
                        (Space::Unqualified, "TargetMode"),
                        (Space::Unqualified, "Target"),
                    ],
                )?;
                let Some(kind) = xml.value(kind)? else {
                    continue;
                };
                let Some(kind) = RELATIONSHIP_TYPES
                    .iter()
                    .find_map(|base| kind.strip_prefix(base))
                else {
                    continue;
                };
                let Some(slot) = kinds.iter().position(|wanted| *wanted == kind) else {
                    continue;
                };
                let mode = xml.value(mode)?;
                if targets[slot].is_none() && mode.as_deref() != Some("External") {
                    targets[slot] = xml.value(target)?;
                }
            }
            Step::Eof => return Ok(targets),
            _ => {}
        }
    }
}

/// Whether to read on after a part.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum Flow {
    Continue,
    /// `max_text` is reached.
    Stop,
}

/// What an open element means for the text.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Frame {
    /// `w:p`, whose text is the innermost open paragraph.
    Paragraph,
    /// `w:r`, inside which `w:tab`, `w:br`, `w:cr` and `w:noBreakHyphen` are characters.
    Run,
    /// `w:t` or `m:t`, whose character data is text.
    Text,
    /// `mc:AlternateContent`: only its first branch is read, since the others repeat it.
    Alternate {
        taken: bool,
    },
    Other,
}

/// The paragraphs of the parts read so far, within `max_text`.
pub(super) struct Collector {
    paragraphs: Vec<String>,
    /// Paragraphs whose end has not come yet, innermost last (a text box's paragraphs open
    /// inside the paragraph that anchors it, and close first).
    open: Vec<String>,
    /// Bytes of text plus one per paragraph.
    used: usize,
    max_text: usize,
    full: bool,
}

impl Collector {
    pub(super) fn new(max_text: usize) -> Self {
        Self {
            paragraphs: Vec::new(),
            open: Vec::new(),
            used: 0,
            max_text,
            full: false,
        }
    }

    /// Collects the paragraphs of one part (the main part, footnotes or endnotes).
    pub(super) fn read_part(
        &mut self,
        source: impl BufRead,
        part: &str,
    ) -> Result<Flow, WordError> {
        let mut xml = Xml::new(source, part);
        let mut frames: Vec<Frame> = Vec::new();
        // Open elements inside one whose content is not text (deleted text, field codes …).
        let mut skipped = 0_usize;
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match xml.next(&mut buf)? {
                Step::Start {
                    space,
                    element,
                    empty,
                } => {
                    let frame = if skipped > 0 {
                        None
                    } else {
                        self.open(&xml, space, &element, frames.last_mut())?
                    };
                    match (frame, empty) {
                        (Some(frame), true) => self.close(frame),
                        (Some(frame), false) => frames.push(frame),
                        (None, true) => {}
                        (None, false) => skipped += 1,
                    }
                }
                Step::End => {
                    if skipped > 0 {
                        skipped -= 1;
                    } else if let Some(frame) = frames.pop() {
                        self.close(frame);
                    }
                }
                Step::Text(text) => {
                    if skipped == 0 && frames.last() == Some(&Frame::Text) {
                        self.push(&text);
                    }
                }
                Step::Other => {}
                Step::Eof => return Ok(Flow::Continue),
            }
            if self.full {
                return Ok(Flow::Stop);
            }
        }
    }

    /// What an element that opens means, or `None` when nothing inside it is text.
    fn open<R: BufRead>(
        &mut self,
        xml: &Xml<'_, R>,
        space: Space,
        element: &BytesStart<'_>,
        parent: Option<&mut Frame>,
    ) -> Result<Option<Frame>, WordError> {
        let local = element.local_name();
        let in_run = parent.as_deref() == Some(&Frame::Run);
        Ok(Some(match (space, local.as_ref()) {
            (Space::Word, "p") => {
                if self.begin_paragraph() {
                    Frame::Paragraph
                } else {
                    Frame::Other
                }
            }
            (Space::Word, "r") => Frame::Run,
            (Space::Word | Space::Math, "t") => Frame::Text,
            (Space::Word, "tab") if in_run => self.character("\t"),
            (Space::Word, "br" | "cr") if in_run => self.character("\n"),
            (Space::Word, "noBreakHyphen") if in_run => self.character("-"),
            // Deleted and moved-away text, field instructions, and ruby annotations.
            (Space::Word, "del" | "moveFrom" | "delText" | "delInstrText" | "instrText" | "rt") => {
                return Ok(None);
            }
            (Space::Word, "footnote" | "endnote") => {
                let [kind] = xml.attributes(element, [(Space::Word, "type")])?;
                let kind = xml.value(kind)?;
                if matches!(
                    kind.as_deref(),
                    Some("separator" | "continuationSeparator" | "continuationNotice")
                ) {
                    return Ok(None);
                }
                Frame::Other
            }
            (Space::Compatibility, "AlternateContent") => Frame::Alternate { taken: false },
            // The first `mc:Choice`, or `mc:Fallback` when there is none.
            (Space::Compatibility, "Choice" | "Fallback") => match parent {
                Some(Frame::Alternate { taken: true }) => return Ok(None),
                Some(Frame::Alternate { taken }) => {
                    *taken = true;
                    Frame::Other
                }
                _ => Frame::Other,
            },
            _ => Frame::Other,
        }))
    }

    fn close(&mut self, frame: Frame) {
        if frame == Frame::Paragraph
            && let Some(paragraph) = self.open.pop()
        {
            self.paragraphs.push(paragraph);
        }
    }

    /// Opens a paragraph, unless `max_text` is reached.
    fn begin_paragraph(&mut self) -> bool {
        if self.used >= self.max_text {
            self.full = true;
            return false;
        }
        self.used += 1;
        self.open.push(String::new());
        true
    }

    fn character(&mut self, character: &str) -> Frame {
        self.push(character);
        Frame::Other
    }

    /// Adds text to the innermost open paragraph, up to `max_text`. Text outside every paragraph
    /// (which WordprocessingML does not allow) is not read.
    fn push(&mut self, text: &str) {
        let Some(paragraph) = self.open.last_mut() else {
            return;
        };
        let room = self.max_text - self.used;
        if text.len() <= room {
            paragraph.push_str(text);
            self.used += text.len();
        } else {
            let cut = text.floor_char_boundary(room);
            paragraph.push_str(&text[..cut]);
            self.used += cut;
            self.full = true;
        }
    }

    pub(super) fn finish(mut self) -> WordText {
        // Paragraphs a stop left open, innermost first, as they would have closed.
        while let Some(paragraph) = self.open.pop() {
            self.paragraphs.push(paragraph);
        }
        WordText {
            paragraphs: self.paragraphs,
            complete: !self.full,
        }
    }
}
