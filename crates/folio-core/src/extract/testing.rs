//! Word documents built for tests: packages of named parts written with `zip`, and the
//! WordprocessingML to put in them.

use std::io::{self, Cursor, Read, Seek, SeekFrom, Write};

use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipWriter};

pub(crate) const WORD_NS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
pub(crate) const RELATIONSHIP_TYPE: &str =
    "http://schemas.openxmlformats.org/officeDocument/2006/relationships/";

const CONTENT_TYPES: &str = r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>"#;

/// A package: named parts in order, written as a ZIP archive.
#[derive(Debug, Clone, Default)]
pub(crate) struct Package {
    parts: Vec<(String, Vec<u8>, CompressionMethod)>,
    zip64: bool,
}

impl Package {
    /// A Word document whose body (inside `w:body`) is `body`: content types, the package
    /// relationship to `word/document.xml`, and that part.
    pub(crate) fn docx(body: &str) -> Self {
        Self::default()
            .part("[Content_Types].xml", CONTENT_TYPES)
            .part(
                "_rels/.rels",
                relationships(&[("officeDocument", "word/document.xml")]),
            )
            .part("word/document.xml", document(body))
    }

    /// This package with the part `name` (replaced if it exists), deflated.
    pub(crate) fn part(self, name: &str, content: impl AsRef<[u8]>) -> Self {
        self.with(name, content.as_ref(), CompressionMethod::Deflated)
    }

    /// This package with the part `name` (replaced if it exists), stored.
    pub(crate) fn stored(self, name: &str, content: impl AsRef<[u8]>) -> Self {
        self.with(name, content.as_ref(), CompressionMethod::Stored)
    }

    /// This package without the part `name`.
    pub(crate) fn without(mut self, name: &str) -> Self {
        self.parts.retain(|(part, ..)| part != name);
        self
    }

    /// This package with zip64 end records.
    pub(crate) fn zip64(mut self) -> Self {
        self.zip64 = true;
        self
    }

    fn with(mut self, name: &str, content: &[u8], method: CompressionMethod) -> Self {
        let part = (name.to_owned(), content.to_vec(), method);
        match self
            .parts
            .iter_mut()
            .find(|(existing, ..)| existing == name)
        {
            Some(existing) => *existing = part,
            None => self.parts.push(part),
        }
        self
    }

    pub(crate) fn build(&self) -> Vec<u8> {
        let mut zip = ZipWriter::new(Cursor::new(Vec::new()));
        for (name, content, method) in &self.parts {
            let options = SimpleFileOptions::default().compression_method(*method);
            zip.start_file(name.as_str(), options)
                .expect("start a part");
            zip.write_all(content).expect("write a part");
        }
        if self.zip64 {
            // zip writes zip64 end records whenever the zip64 record has extensible data.
            zip.set_raw_zip64_extensible_data_sector(Box::new([]));
        }
        zip.finish().expect("finish the package").into_inner()
    }
}

/// A `w:document` part around `body`, with the prefixes of WordprocessingML, Office Math, markup
/// compatibility, Word shapes and VML bound.
pub(crate) fn document(body: &str) -> String {
    format!(
        concat!(
            r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?>"#,
            "\r\n",
            r#"<w:document xmlns:w="{}" "#,
            r#"xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" "#,
            r#"xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006" "#,
            r#"xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape" "#,
            r#"xmlns:v="urn:schemas-microsoft-com:vml" "#,
            r#"xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" "#,
            r#"mc:Ignorable="wps"><w:body>{}<w:sectPr/></w:body></w:document>"#,
        ),
        WORD_NS, body
    )
}

/// A paragraph of one run of `text` (escaped).
pub(crate) fn paragraph(text: &str) -> String {
    format!(
        r#"<w:p><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p>"#,
        escape(text)
    )
}

/// A relationships part: each `(kind, target)` with the transitional type `kind`.
pub(crate) fn relationships(items: &[(&str, &str)]) -> String {
    let mut xml = String::from(
        r#"<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">"#,
    );
    for (id, (kind, target)) in items.iter().enumerate() {
        xml.push_str(&format!(
            r#"<Relationship Id="rId{id}" Type="{RELATIONSHIP_TYPE}{kind}" Target="{target}"/>"#
        ));
    }
    xml.push_str("</Relationships>");
    xml
}

/// A footnotes part (`kind` "footnote") or endnotes part ("endnote"): the separators and the
/// continuation notice, given text here to show they are not read, then a note of one paragraph
/// for each of `texts`.
pub(crate) fn notes(kind: &str, texts: &[&str]) -> String {
    let mut xml = format!(r#"<w:{kind}s xmlns:w="{WORD_NS}">"#);
    for (id, special) in ["separator", "continuationSeparator", "continuationNotice"]
        .iter()
        .enumerate()
    {
        xml.push_str(&format!(
            r#"<w:{kind} w:type="{special}" w:id="-{id}"><w:p><w:r><w:{special}/><w:t>{special}</w:t></w:r></w:p></w:{kind}>"#
        ));
    }
    for (index, text) in texts.iter().enumerate() {
        let id = index + 1;
        xml.push_str(&format!(
            r#"<w:{kind} w:id="{id}"><w:p><w:r><w:{kind}Ref/></w:r><w:r><w:t xml:space="preserve">{}</w:t></w:r></w:p></w:{kind}>"#,
            escape(text)
        ));
    }
    xml.push_str(&format!("</w:{kind}s>"));
    xml
}

fn escape(text: &str) -> String {
    text.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
}

/// Changes, in a built package, the central directory header of the entry `name`.
pub(crate) fn patch_entry(zip: &mut [u8], name: &str, patch: impl FnOnce(&mut [u8])) {
    const SIGNATURE: &[u8] = b"PK\x01\x02";
    let mut at = 0;
    while let Some(found) = zip[at..]
        .windows(SIGNATURE.len())
        .position(|window| window == SIGNATURE)
    {
        let header = at + found;
        let name_len = usize::from(u16::from_le_bytes([zip[header + 28], zip[header + 29]]));
        if &zip[header + 46..header + 46 + name_len] == name.as_bytes() {
            patch(&mut zip[header..header + 46]);
            return;
        }
        at = header + 1;
    }
    panic!("no entry named {name}");
}

/// Sets the encryption flag of the entry `name` in a built package.
pub(crate) fn set_encrypted(zip: &mut [u8], name: &str) {
    patch_entry(zip, name, |header| header[8] |= 1);
}

/// A package of one entry, `word/document.xml`, whose data is `pattern` over and over, then
/// `last`: `len` bytes in all. Its bytes are made as they are read, so that a part of a hundred
/// MiB takes no memory.
pub(crate) struct Repeating {
    /// The local header, the data's length, and the directory with the end record.
    header: Vec<u8>,
    len: u64,
    pattern: Vec<u8>,
    last: Vec<u8>,
    trailer: Vec<u8>,
    position: u64,
}

impl Repeating {
    /// The package, its entry stored (the data is the part) or deflated (the data is deflate's).
    /// The checksum is 0, and so is a deflated entry's expanded size: nothing is meant to read the
    /// part to its end.
    pub(crate) fn new(method: CompressionMethod, pattern: &[u8], last: &[u8], len: u64) -> Self {
        const NAME: &[u8] = b"word/document.xml";
        let data_len = u32::try_from(len).expect("a data length below 4 GiB");
        let (method, expanded_len) = match method {
            CompressionMethod::Stored => (0_u16, data_len),
            CompressionMethod::Deflated => (8, 0),
            other => panic!("{other:?}"),
        };
        // Version 2.0 needed, no flags, the method, 1980-01-01 00:00, CRC-32, sizes.
        let mut fields = vec![20, 0, 0, 0];
        fields.extend(method.to_le_bytes());
        fields.extend([0, 0, 0x21, 0]);
        fields.extend(0_u32.to_le_bytes());
        fields.extend(data_len.to_le_bytes());
        fields.extend(expanded_len.to_le_bytes());
        let name_len = u16::try_from(NAME.len()).unwrap().to_le_bytes();

        let mut header = b"PK\x03\x04".to_vec();
        header.extend(&fields);
        header.extend(name_len);
        header.extend([0, 0]);
        header.extend(NAME);

        let mut directory = b"PK\x01\x02\x14\0".to_vec();
        directory.extend(&fields);
        directory.extend(name_len);
        // No extra field or comment, disk 0, no attributes, the local header at 0.
        directory.extend([0; 16]);
        directory.extend(NAME);
        let directory_at = u32::try_from(header.len() as u64 + len).unwrap();
        let mut trailer = directory.clone();
        trailer.extend(b"PK\x05\x06\0\0\0\0\x01\0\x01\0");
        trailer.extend(u32::try_from(directory.len()).unwrap().to_le_bytes());
        trailer.extend(directory_at.to_le_bytes());
        trailer.extend([0, 0]);
        Self {
            header,
            len,
            pattern: pattern.to_vec(),
            last: last.to_vec(),
            trailer,
            position: 0,
        }
    }

    fn total(&self) -> u64 {
        self.header.len() as u64 + self.len + self.trailer.len() as u64
    }

    /// The bytes from `at` on that one copy can give: a run of fixed bytes or of the pattern.
    fn piece(&self, at: u64) -> &[u8] {
        let data_at = self.header.len() as u64;
        let last_at = data_at + self.len - self.last.len() as u64;
        let trailer_at = data_at + self.len;
        if at < data_at {
            &self.header[at as usize..]
        } else if at < last_at {
            let offset = ((at - data_at) % self.pattern.len() as u64) as usize;
            let rest = (last_at - at).min((self.pattern.len() - offset) as u64) as usize;
            &self.pattern[offset..offset + rest]
        } else if at < trailer_at {
            &self.last[(at - last_at) as usize..]
        } else {
            &self.trailer[(at - trailer_at) as usize..]
        }
    }
}

impl Read for Repeating {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let mut read = 0;
        while read < buf.len() && self.position < self.total() {
            let piece = self.piece(self.position);
            let count = piece.len().min(buf.len() - read);
            buf[read..read + count].copy_from_slice(&piece[..count]);
            read += count;
            self.position += count as u64;
        }
        Ok(read)
    }
}

impl Seek for Repeating {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let position = match to {
            SeekFrom::Start(at) => Some(at),
            SeekFrom::End(delta) => self.total().checked_add_signed(delta),
            SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
        }
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        self.position = position;
        Ok(position)
    }
}
