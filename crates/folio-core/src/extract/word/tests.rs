use std::io::{self, Cursor, Read, Seek, SeekFrom};
use std::sync::LazyLock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use proptest::prelude::*;

use super::*;
use crate::extract::testing::{
    Package, RELATIONSHIP_TYPE, WORD_NS, document, notes, paragraph, patch_entry, relationships,
    set_encrypted,
};

const UNLIMITED: WordLimits = WordLimits::with_max_text(usize::MAX);

fn read_with(bytes: &[u8], limits: &WordLimits) -> Result<WordText, WordError> {
    let cancel = AtomicBool::new(false);
    read_word(Cursor::new(bytes), limits, &patient(&cancel))
}

fn read(bytes: &[u8]) -> Result<WordText, WordError> {
    read_with(bytes, &UNLIMITED)
}

fn patient(cancel: &AtomicBool) -> Control<'_> {
    Control {
        deadline: Instant::now() + Duration::from_secs(600),
        cancel,
    }
}

/// The paragraphs of a document read to its end.
fn paragraphs_of(bytes: &[u8]) -> Vec<String> {
    let text = read(bytes).expect("a readable document");
    assert!(text.complete);
    text.paragraphs
}

fn paragraphs(package: &Package) -> Vec<String> {
    paragraphs_of(&package.build())
}

/// The paragraphs of a document whose body is `xml`.
fn body(xml: &str) -> Vec<String> {
    paragraphs(&Package::docx(xml))
}

/// A package whose main part is `xml` as it is.
fn with_main_part(xml: &str) -> Package {
    Package::default()
        .part(
            "_rels/.rels",
            relationships(&[("officeDocument", "word/document.xml")]),
        )
        .part("word/document.xml", xml)
}

#[track_caller]
fn assert_invalid(result: Result<WordText, WordError>) {
    assert!(matches!(result, Err(WordError::Invalid(_))), "{result:?}");
}

#[track_caller]
fn assert_too_large(result: Result<WordText, WordError>) {
    assert!(matches!(result, Err(WordError::TooLarge(_))), "{result:?}");
}

/// Asserts that the document was refused as invalid, for the reason `detail`.
#[track_caller]
fn assert_refused(result: Result<WordText, WordError>, detail: &str) {
    assert!(
        matches!(&result, Err(WordError::Invalid(found)) if found == detail),
        "{result:?}, not {detail:?}"
    );
}

/// A document with a table, a text box, a footnote and an endnote.
static SAMPLE: LazyLock<Vec<u8>> = LazyLock::new(|| {
    let text_box = format!(
        "<w:p><w:r><w:t>Anchor</w:t></w:r><w:r><mc:AlternateContent><mc:Choice Requires=\"wps\">\
         <w:drawing><wps:wsp><wps:txbx><w:txbxContent>{0}</w:txbxContent></wps:txbx></wps:wsp>\
         </w:drawing></mc:Choice><mc:Fallback><w:pict><v:shape><v:textbox><w:txbxContent>{0}\
         </w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback></mc:AlternateContent>\
         </w:r><w:r><w:t xml:space=\"preserve\"> after the box</w:t></w:r></w:p>",
        paragraph("In the box")
    );
    let table = format!(
        "<w:tbl><w:tr><w:tc>{}</w:tc><w:tc>{}</w:tc></w:tr></w:tbl>",
        paragraph("线性代数"),
        paragraph("Linear algebra")
    );
    Package::docx(&[paragraph("Title"), table, text_box, paragraph("End")].concat())
        .part(
            "word/_rels/document.xml.rels",
            relationships(&[("footnotes", "footnotes.xml"), ("endnotes", "endnotes.xml")]),
        )
        .part("word/footnotes.xml", notes("footnote", &["A footnote"]))
        .part("word/endnotes.xml", notes("endnote", &["An endnote"]))
        .build()
});

#[test]
fn reads_the_sample() {
    assert_eq!(
        paragraphs_of(&SAMPLE),
        [
            "Title",
            "线性代数",
            "Linear algebra",
            "In the box",
            "Anchor after the box",
            "End",
            "A footnote",
            "An endnote"
        ]
    );
}

#[test]
fn reads_paragraphs_in_order() {
    let xml = [
        paragraph("First"),
        paragraph("第二段, second"),
        "<w:p/>".to_owned(),
        "<w:p><w:pPr><w:pStyle w:val=\"Heading1\"/></w:pPr><w:r><w:rPr><w:b/></w:rPr>\
         <w:t>Fou</w:t></w:r><w:r><w:t>rth</w:t></w:r></w:p>"
            .to_owned(),
    ]
    .concat();
    assert_eq!(body(&xml), ["First", "第二段, second", "", "Fourth"]);
}

#[test]
fn reads_table_cells_row_by_row() {
    let cell = |text| {
        format!(
            "<w:tc><w:tcPr><w:tcW w:w=\"0\"/></w:tcPr>{}</w:tc>",
            paragraph(text)
        )
    };
    let xml = format!(
        "{}<w:tbl><w:tblPr><w:tblW w:w=\"0\"/></w:tblPr><w:tblGrid><w:gridCol/><w:gridCol/>\
         </w:tblGrid><w:tr>{}{}</w:tr><w:tr>{}{}</w:tr></w:tbl>{}",
        paragraph("Before"),
        cell("A1"),
        cell("B1"),
        cell("A2"),
        cell("B2"),
        paragraph("After")
    );
    assert_eq!(body(&xml), ["Before", "A1", "B1", "A2", "B2", "After"]);
}

#[test]
fn reads_footnotes_then_endnotes_after_the_body_without_separators() {
    let package = Package::docx(&format!(
        "<w:p><w:r><w:t>Body</w:t></w:r><w:r><w:footnoteReference w:id=\"1\"/></w:r></w:p>{}",
        paragraph("More body")
    ))
    // Endnotes listed first, and a relationship that is not a note.
    .part(
        "word/_rels/document.xml.rels",
        relationships(&[
            ("endnotes", "endnotes.xml"),
            ("styles", "styles.xml"),
            ("footnotes", "footnotes.xml"),
        ]),
    )
    .part(
        "word/footnotes.xml",
        notes("footnote", &["Footnote one", "Footnote two"]),
    )
    .part("word/endnotes.xml", notes("endnote", &["Endnote"]));
    assert_eq!(
        paragraphs(&package),
        [
            "Body",
            "More body",
            "Footnote one",
            "Footnote two",
            "Endnote"
        ]
    );
}

#[test]
fn ignores_note_relationships_to_missing_parts() {
    let package = Package::docx(&paragraph("Body")).part(
        "word/_rels/document.xml.rels",
        relationships(&[("footnotes", "footnotes.xml")]),
    );
    assert_eq!(paragraphs(&package), ["Body"]);
}

#[test]
fn keeps_inserted_text_and_drops_deleted_and_moved_away_text() {
    let xml = "<w:p><w:r><w:t xml:space=\"preserve\">Kept </w:t></w:r>\
               <w:ins w:id=\"1\" w:author=\"A\"><w:r><w:t xml:space=\"preserve\">inserted </w:t>\
               </w:r></w:ins><w:del w:id=\"2\" w:author=\"A\"><w:r>\
               <w:delText xml:space=\"preserve\">deleted </w:delText></w:r></w:del>\
               <w:moveFrom w:id=\"3\" w:author=\"A\"><w:r><w:t>moved away</w:t></w:r></w:moveFrom>\
               <w:moveTo w:id=\"4\" w:author=\"A\"><w:r><w:t>moved here</w:t></w:r></w:moveTo>\
               <w:r><w:delText>stray</w:delText></w:r></w:p>";
    assert_eq!(body(xml), ["Kept inserted moved here"]);
}

#[test]
fn keeps_tabs_and_line_breaks_inside_a_paragraph() {
    // The tab stop in the paragraph's properties is not a character.
    let xml = "<w:p><w:pPr><w:tabs><w:tab w:val=\"left\" w:pos=\"720\"/></w:tabs></w:pPr><w:r>\
               <w:t>Name</w:t><w:tab/><w:t>Value</w:t><w:br/><w:t>Next line</w:t><w:cr/>\
               <w:t>Third</w:t><w:noBreakHyphen/><w:t>part</w:t><w:tab></w:tab>\
               <w:br w:type=\"page\"/></w:r></w:p>";
    assert_eq!(body(xml), ["Name\tValue\nNext line\nThird-part\t\n"]);
}

#[test]
fn reads_a_text_box_once_before_its_anchor_paragraph() {
    let text_box = format!("<w:txbxContent>{}</w:txbxContent>", paragraph("In the box"));
    let xml = format!(
        "<w:p><w:r><w:t xml:space=\"preserve\">Anchor </w:t></w:r><w:r><mc:AlternateContent>\
         <mc:Choice Requires=\"wps\"><w:drawing><wps:wsp><wps:txbx>{text_box}</wps:txbx>\
         </wps:wsp></w:drawing></mc:Choice><mc:Choice Requires=\"v\">{text_box}</mc:Choice>\
         <mc:Fallback><w:pict><v:shape><v:textbox>{text_box}</v:textbox></v:shape></w:pict>\
         </mc:Fallback></mc:AlternateContent></w:r><w:r><w:t>text</w:t></w:r></w:p>"
    );
    assert_eq!(body(&xml), ["In the box", "Anchor text"]);
}

#[test]
fn reads_the_fallback_without_a_choice_and_legacy_text_boxes() {
    let xml = format!(
        "<w:p><w:r><mc:AlternateContent><mc:Fallback><w:pict><v:shape><v:textbox>\
         <w:txbxContent>{}</w:txbxContent></v:textbox></v:shape></w:pict></mc:Fallback>\
         </mc:AlternateContent><w:pict><v:shape><v:textbox><w:txbxContent>{}</w:txbxContent>\
         </v:textbox></v:shape></w:pict></w:r></w:p>",
        paragraph("Fallback"),
        paragraph("Legacy")
    );
    assert_eq!(body(&xml), ["Fallback", "Legacy", ""]);
}

#[test]
fn reads_field_results_without_their_instructions() {
    let xml = "<w:p><w:r><w:t xml:space=\"preserve\">Page </w:t></w:r>\
               <w:r><w:fldChar w:fldCharType=\"begin\"/></w:r>\
               <w:r><w:instrText xml:space=\"preserve\"> PAGE \\* MERGEFORMAT </w:instrText></w:r>\
               <w:r><w:fldChar w:fldCharType=\"separate\"/></w:r><w:r><w:t>3</w:t></w:r>\
               <w:r><w:fldChar w:fldCharType=\"end\"/></w:r>\
               <w:r><w:t xml:space=\"preserve\"> of </w:t></w:r>\
               <w:fldSimple w:instr=\" NUMPAGES \"><w:r><w:t>9</w:t></w:r></w:fldSimple>\
               <w:del w:id=\"1\"><w:r><w:delInstrText> DATE </w:delInstrText></w:r></w:del></w:p>";
    assert_eq!(body(xml), ["Page 3 of 9"]);
}

#[test]
fn reads_math_and_ruby_base_text() {
    let xml = "<w:p><m:oMath><m:r><m:t>x=1</m:t></m:r></m:oMath></w:p>\
               <w:p><w:r><w:ruby><w:rubyPr/><w:rt><w:r><w:t>xiàn</w:t></w:r></w:rt>\
               <w:rubyBase><w:r><w:t>线</w:t></w:r></w:rubyBase></w:ruby></w:r></w:p>";
    assert_eq!(body(xml), ["x=1", "线"]);
}

#[test]
fn resolves_xml_entities_character_references_and_character_data() {
    let xml = "<w:p><w:r><w:t>a &lt; b &amp;&amp; c &gt; d &quot;q&quot; &apos;s&apos; \
               &#20013;&#x6587; &#x1F600; <![CDATA[1 < 2]]></w:t></w:r></w:p>";
    assert_eq!(body(xml), ["a < b && c > d \"q\" 's' 中文 😀 1 < 2"]);
}

#[test]
fn matches_elements_by_namespace_not_by_prefix() {
    const WORD_STRICT: &str = "http://purl.oclc.org/ooxml/wordprocessingml/main";
    const MATH_STRICT: &str = "http://purl.oclc.org/ooxml/officeDocument/math";
    let strict = format!(
        "<w:document xmlns:w=\"{WORD_STRICT}\" xmlns:m=\"{MATH_STRICT}\"><w:body><w:p><w:r>\
         <w:t>Strict</w:t></w:r><m:oMath><m:r><m:t> y</m:t></m:r></m:oMath></w:p></w:body>\
         </w:document>"
    );
    let unusual = format!(
        "<ns0:document xmlns:ns0=\"{WORD_NS}\"><ns0:body><ns0:p><ns0:r><ns0:t>Unusual</ns0:t>\
         </ns0:r></ns0:p></ns0:body></ns0:document>"
    );
    let default = format!(
        "<document xmlns=\"{WORD_NS}\"><body><p><r><t>Default</t></r></p></body></document>"
    );
    let impostor = "<w:document xmlns:w=\"urn:not-word\"><w:body><w:p><w:r><w:t>Impostor\
                    </w:t></w:r></w:p></w:body></w:document>";
    let rebound = format!(
        "<w:document xmlns:w=\"{WORD_NS}\"><w:body><w:p><w:r><w:t>Real</w:t></w:r></w:p>\
         <w:p xmlns:w=\"urn:not-word\"><w:r><w:t>Fake</w:t></w:r></w:p></w:body></w:document>"
    );
    assert_eq!(paragraphs(&with_main_part(&strict)), ["Strict y"]);
    assert_eq!(paragraphs(&with_main_part(&unusual)), ["Unusual"]);
    assert_eq!(paragraphs(&with_main_part(&default)), ["Default"]);
    assert!(paragraphs(&with_main_part(impostor)).is_empty());
    assert_eq!(paragraphs(&with_main_part(&rebound)), ["Real"]);
}

#[test]
fn finds_the_main_part_and_its_notes_through_relationships() {
    // A strict relationship type, an absolute target with a dot segment, and notes found from the
    // main part's folder.
    let package_rels = "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/\
                        relationships\"><Relationship Id=\"rId2\" Type=\"http://purl.oclc.org/\
                        ooxml/officeDocument/relationships/extendedProperties\" \
                        Target=\"docProps/app.xml\"/><Relationship Id=\"rId1\" \
                        Type=\"http://purl.oclc.org/ooxml/officeDocument/relationships/\
                        officeDocument\" Target=\"/content/./main.xml\"/></Relationships>";
    let package = Package::default()
        .part("_rels/.rels", package_rels)
        .part("content/main.xml", document(&paragraph("Elsewhere")))
        .part(
            "content/_rels/main.xml.rels",
            relationships(&[("footnotes", "../notes/footnotes.xml")]),
        )
        .part("notes/footnotes.xml", notes("footnote", &["A note"]))
        .part(
            "word/document.xml",
            document(&paragraph("Not the main part")),
        );
    assert_eq!(paragraphs(&package), ["Elsewhere", "A note"]);
}

#[test]
fn takes_the_first_of_repeated_attributes() {
    let package_rels = format!(
        "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/relationships\">\
         <Relationship Id=\"rId1\" Id=\"rId1\" Type=\"{RELATIONSHIP_TYPE}officeDocument\" \
         Target=\"word/main.xml\" Target=\"word/document.xml\"/></Relationships>"
    );
    let footnotes = format!(
        "<w:footnotes xmlns:w=\"{WORD_NS}\"><w:footnote w:id=\"0\" w:id=\"0\" w:type=\"separator\">\
         {}</w:footnote><w:footnote w:id=\"1\">{}</w:footnote></w:footnotes>",
        paragraph("Separator"),
        paragraph("A note")
    );
    let package = Package::default()
        .part("_rels/.rels", package_rels)
        .part("word/main.xml", document(&paragraph("Main")))
        .part(
            "word/_rels/main.xml.rels",
            relationships(&[("footnotes", "footnotes.xml")]),
        )
        .part("word/footnotes.xml", footnotes)
        .part("word/document.xml", document(&paragraph("Second")));
    assert_eq!(paragraphs(&package), ["Main", "A note"]);
}

/// The values `xml::find_attributes` finds in `element` (prefix `w` bound to WordprocessingML),
/// and the names it resolved.
fn look_up<const N: usize>(
    element: &quick_xml::events::BytesStart<'_>,
    wanted: [(xml::Space, &str); N],
) -> ([Option<String>; N], Vec<String>) {
    let mut resolved = Vec::new();
    let found = xml::find_attributes(element, wanted, |key| {
        resolved.push(key.as_ref().to_owned());
        if key.prefix().is_some_and(|prefix| prefix.as_ref() == "w") {
            xml::Space::Word
        } else {
            xml::Space::Other
        }
    })
    .expect("well-formed attributes");
    let values = found.map(|attribute| attribute.map(|attribute| attribute.value.into_owned()));
    (values, resolved)
}

#[test]
fn looks_attributes_up_in_one_pass_resolving_only_wanted_names() {
    // A tag of many attributes, most of them repeated, and a few with the local names looked up.
    let mut content = String::from("w:footnote");
    for n in 0..10_000 {
        content.push_str(&format!(" q:a{n}=\"v\" a{n}=\"v\" q:id=\"v\" id=\"v\""));
    }
    content.push_str(" type=\"none\" q:type=\"other\" q:Type=\"other\" w:type=\"note\" Type=\"T\"");
    let element = quick_xml::events::BytesStart::from_content(content, "w:footnote".len());
    // Only the prefixed names whose local name is wanted are resolved, each once.
    let (values, resolved) = look_up(&element, [(xml::Space::Word, "type"); 2]);
    assert_eq!(values, [Some("note".to_owned()), Some("note".to_owned())]);
    assert_eq!(resolved, ["q:type", "w:type"]);
    // Unprefixed names, as a relationship's are, are matched without resolving anything.
    let (values, resolved) = look_up(
        &element,
        [
            (xml::Space::Unqualified, "Type"),
            (xml::Space::Unqualified, "id"),
            (xml::Space::Unqualified, "Target"),
        ],
    );
    assert_eq!(values, [Some("T".to_owned()), Some("v".to_owned()), None]);
    assert!(resolved.is_empty(), "{resolved:?}");
}

#[test]
fn falls_back_to_word_document_xml() {
    let docx = Package::docx(&paragraph("Fallback"));
    assert_eq!(
        paragraphs(&docx.clone().without("_rels/.rels")),
        ["Fallback"]
    );
    let missing = relationships(&[("officeDocument", "word/missing.xml")]);
    assert_eq!(
        paragraphs(&docx.clone().part("_rels/.rels", missing)),
        ["Fallback"]
    );
    let outside = relationships(&[("officeDocument", "../../document.xml")]);
    assert_eq!(
        paragraphs(&docx.clone().part("_rels/.rels", outside)),
        ["Fallback"]
    );
    let external = "<Relationships xmlns=\"http://schemas.openxmlformats.org/package/2006/\
                    relationships\"><Relationship Id=\"rId1\" Type=\"http://schemas.\
                    openxmlformats.org/officeDocument/2006/relationships/officeDocument\" \
                    Target=\"word/other.xml\" TargetMode=\"External\"/></Relationships>";
    let package = docx
        .part("_rels/.rels", external)
        .part("word/other.xml", document(&paragraph("External")));
    assert_eq!(paragraphs(&package), ["Fallback"]);
}

#[test]
fn matches_part_names_whatever_their_case() {
    let package = Package::default()
        .part(
            "_rels/.rels",
            relationships(&[("officeDocument", "word/document.xml")]),
        )
        .part("Word/Document.XML", document(&paragraph("Case")));
    assert_eq!(paragraphs(&package), ["Case"]);
}

#[test]
fn reads_stored_parts_and_zip64_end_records() {
    let stored = Package::docx("").stored("word/document.xml", document(&paragraph("Stored")));
    assert_eq!(paragraphs(&stored), ["Stored"]);

    let mut bytes = Package::docx(&paragraph("Zip64")).zip64().build();
    // Only the zip64 record tells the number of entries: the classic one says 65,535.
    let end = bytes.len() - 22;
    assert_eq!(bytes[end..end + 4], *b"PK\x05\x06");
    bytes[end + 8..end + 12].copy_from_slice(&[0xFF; 4]);
    assert_eq!(paragraphs_of(&bytes), ["Zip64"]);
}

#[test]
fn refuses_a_package_without_a_main_part() {
    assert_invalid(read(
        &Package::docx("").without("word/document.xml").build(),
    ));
    // A main part that is not XML, or is empty.
    assert_invalid(read(
        &Package::docx("").part("word/document.xml", "").build(),
    ));
    assert_invalid(read(
        &Package::docx("")
            .part("word/document.xml", [0xFF, 0xFE, 0x3C, 0x00])
            .build(),
    ));
}

#[test]
fn refuses_what_is_not_a_zip_archive() {
    let mut compound_file = vec![0xD0, 0xCF, 0x11, 0xE0, 0xA1, 0xB1, 0x1A, 0xE1];
    compound_file.resize(4096, 0);
    for bytes in [
        &b""[..],
        &b"not really a document"[..],
        &b"PK\x03\x04"[..],
        // An Office-encrypted document is an OLE compound file.
        compound_file.as_slice(),
    ] {
        assert_invalid(read(bytes));
    }
}

#[test]
fn refuses_encrypted_and_unsupported_entries() {
    let mut encrypted = Package::docx(&paragraph("Secret")).build();
    set_encrypted(&mut encrypted, "word/document.xml");
    assert_invalid(read(&encrypted));

    let mut bzip2 = Package::docx(&paragraph("Packed")).build();
    patch_entry(&mut bzip2, "word/document.xml", |header| {
        header[10..12].copy_from_slice(&12_u16.to_le_bytes());
    });
    assert_invalid(read(&bzip2));
}

#[test]
fn refuses_a_document_type_declaration() {
    let with_dtd = |xml: &str| {
        xml.replacen(
            "?>",
            "?><!DOCTYPE w:document [<!ENTITY lol \"lol\"><!ENTITY lol2 \"&lol;&lol;\">]>",
            1,
        )
    };
    let main = with_dtd(&document(&paragraph("&lol2;")));
    assert_invalid(read(
        &Package::docx("").part("word/document.xml", main).build(),
    ));
    let rels = with_dtd(&relationships(&[("officeDocument", "word/document.xml")]));
    assert_invalid(read(
        &Package::docx(&paragraph("x"))
            .part("_rels/.rels", rels)
            .build(),
    ));
}

#[test]
fn refuses_an_undeclared_entity_in_text_skipped_text_and_attributes_it_reads() {
    for xml in [
        "<w:p><w:r><w:t>a&nbsp;b</w:t></w:r></w:p>",
        "<w:p><w:del w:id=\"1\"><w:r><w:delText>&bogus;</w:delText></w:r></w:del></w:p>",
        "<w:p><w:r><w:t>&#0;</w:t></w:r></w:p>",
    ] {
        assert_invalid(read(&Package::docx(xml).build()));
    }
    let footnotes = format!(
        "<w:footnotes xmlns:w=\"{WORD_NS}\"><w:footnote w:type=\"&bogus;\" w:id=\"1\"/>\
         </w:footnotes>"
    );
    let package = Package::docx(&paragraph("Body"))
        .part(
            "word/_rels/document.xml.rels",
            relationships(&[("footnotes", "footnotes.xml")]),
        )
        .part("word/footnotes.xml", footnotes);
    assert_invalid(read(&package.build()));
}

#[test]
fn refuses_malformed_xml() {
    assert_invalid(read(&Package::docx("<w:p><w:r><w:t>x</w:r></w:p>").build()));
    let main = document(&paragraph("cut"));
    let cut = &main[..main.len() - "</w:body></w:document>".len()];
    assert_invalid(read(
        &Package::docx("").part("word/document.xml", cut).build(),
    ));
}

#[test]
fn refuses_parts_that_expand_beyond_the_cap() {
    let spaces = " ".repeat(2 << 20);
    let bomb = Package::docx(&format!("<w:p>{spaces}</w:p>")).build();
    assert!(bomb.len() < 64 << 10, "{}", bomb.len());
    let limits = WordLimits {
        max_expanded: 1 << 20,
        ..UNLIMITED
    };
    assert_too_large(read_with(&bomb, &limits));
    assert_eq!(paragraphs_of(&bomb), [""]);
}

#[test]
fn refuses_reading_more_of_the_file_than_the_cap() {
    // Empty deflate blocks: stored blocks of no bytes, five bytes each that expand to nothing.
    let mut blocks = [0x00, 0x00, 0x00, 0xFF, 0xFF].repeat(400_000);
    blocks.extend([0x01, 0x00, 0x00, 0xFF, 0xFF]);
    let mut bytes = Package::docx("")
        .stored("word/document.xml", &blocks)
        .build();
    patch_entry(&mut bytes, "word/document.xml", |header| {
        header[10..12].copy_from_slice(&8_u16.to_le_bytes());
    });
    let limits = WordLimits {
        max_read: 1 << 20,
        ..UNLIMITED
    };
    assert_too_large(read_with(&bytes, &limits));
    // Within the cap, the part is read to its end, and is no XML.
    assert_invalid(read(&bytes));
}

#[test]
fn refuses_too_many_entries() {
    let package = Package::docx(&paragraph("x")).part("docProps/app.xml", "<Properties/>");
    let three = WordLimits {
        max_entries: 3,
        ..UNLIMITED
    };
    assert_too_large(read_with(&package.build(), &three));
    assert_too_large(read_with(&package.clone().zip64().build(), &three));
    let four = WordLimits {
        max_entries: 4,
        ..UNLIMITED
    };
    assert!(read_with(&package.build(), &four).is_ok());
}

#[test]
fn refuses_a_directory_too_long_for_the_entries_allowed() {
    let package =
        Package::docx(&paragraph("x")).part(&format!("media/{}.png", "n".repeat(5000)), "x");
    let four = WordLimits {
        max_entries: 4,
        ..UNLIMITED
    };
    assert_too_large(read_with(&package.build(), &four));
    assert_eq!(paragraphs(&package), ["x"]);
}

#[test]
fn refuses_elements_nested_too_deep() {
    let nested = |depth: usize| {
        format!(
            "<w:p>{}<w:r><w:t>deep</w:t></w:r>{}</w:p>",
            "<w:customXml>".repeat(depth),
            "</w:customXml>".repeat(depth)
        )
    };
    // w:document, w:body, w:p, the custom elements, w:r and w:t.
    assert_eq!(body(&nested(xml::MAX_DEPTH - 5)), ["deep"]);
    assert_too_large(read(&Package::docx(&nested(xml::MAX_DEPTH - 4)).build()));
    // An empty element one level too deep.
    let empty = format!(
        "<w:p>{}<w:r><w:tab/></w:r>{}</w:p>",
        "<w:customXml>".repeat(xml::MAX_DEPTH - 4),
        "</w:customXml>".repeat(xml::MAX_DEPTH - 4)
    );
    assert_too_large(read(&Package::docx(&empty).build()));
}

#[test]
fn stops_at_max_text_with_the_text_before_it() {
    let package = Package::docx(&[paragraph("Hello world"), paragraph("Second")].concat());
    let text = read_with(&package.build(), &WordLimits::with_max_text(8)).unwrap();
    assert_eq!(
        text,
        WordText {
            paragraphs: vec!["Hello w".to_owned()],
            complete: false
        }
    );
    // One byte for the paragraph and 7 for text: two of these three-byte characters.
    let chinese = Package::docx(&paragraph("线性代数")).build();
    let text = read_with(&chinese, &WordLimits::with_max_text(8)).unwrap();
    assert_eq!(text.paragraphs, ["线性"]);
    assert!(!text.complete);
    // Text that fills max_text exactly is complete.
    let exact = Package::docx(&paragraph("abc")).build();
    assert_eq!(
        read_with(&exact, &WordLimits::with_max_text(4)).unwrap(),
        WordText {
            paragraphs: vec!["abc".to_owned()],
            complete: true
        }
    );
    // A stop inside a text box keeps the box's text and its anchor's, in that order.
    let text = read_with(&SAMPLE, &WordLimits::with_max_text(50)).unwrap();
    assert_eq!(
        text.paragraphs,
        ["Title", "线性代数", "Linear algebra", "In the b", "Anchor"]
    );
    assert!(!text.complete);
}

#[test]
fn stops_at_the_deadline_and_on_cancel() {
    let not_cancelled = AtomicBool::new(false);
    let expired = Control {
        deadline: Instant::now(),
        cancel: &not_cancelled,
    };
    let result = read_word(Cursor::new(&SAMPLE[..]), &UNLIMITED, &expired);
    assert!(matches!(result, Err(WordError::TimedOut)), "{result:?}");

    let cancelled = AtomicBool::new(true);
    let result = read_word(Cursor::new(&SAMPLE[..]), &UNLIMITED, &patient(&cancelled));
    assert!(matches!(result, Err(WordError::Cancelled)), "{result:?}");
}

/// A reader that does something once `after` bytes have been read.
struct Tripwire<'a> {
    inner: Cursor<&'a [u8]>,
    after: usize,
    read: usize,
    action: Trip<'a>,
}

enum Trip<'a> {
    Fail,
    Cancel(&'a AtomicBool),
}

impl Read for Tripwire<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.read >= self.after {
            match self.action {
                Trip::Fail => {
                    return Err(io::Error::new(
                        io::ErrorKind::PermissionDenied,
                        "the file is locked",
                    ));
                }
                Trip::Cancel(cancel) => cancel.store(true, Ordering::Relaxed),
            }
        }
        let room = buf.len().min(self.after.saturating_sub(self.read).max(1));
        let read = self.inner.read(&mut buf[..room])?;
        self.read += read;
        Ok(read)
    }
}

impl Seek for Tripwire<'_> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.inner.seek(to)
    }
}

/// A document long enough that its main part is read in many pieces after the archive's
/// directory.
fn long_document() -> Vec<u8> {
    let paragraphs: String = (0..2_000)
        .map(|n| paragraph(&format!("Paragraph {n}: {}", n * 7_919 % 10_007)))
        .collect();
    Package::docx(&paragraphs).build()
}

#[test]
fn reports_read_failures_as_io_errors_wherever_they_happen() {
    let bytes = long_document();
    // The end record, the directory, and the middle of the main part.
    for after in [0, bytes.len() / 2, bytes.len() + 8_192] {
        let cancel = AtomicBool::new(false);
        let reader = Tripwire {
            inner: Cursor::new(bytes.as_slice()),
            after,
            read: 0,
            action: Trip::Fail,
        };
        let result = read_word(reader, &UNLIMITED, &patient(&cancel));
        assert!(
            matches!(&result, Err(WordError::Io(error)) if error.kind() == io::ErrorKind::PermissionDenied),
            "after {after}: {result:?}"
        );
    }
}

#[test]
fn notices_a_cancel_while_reading_a_part() {
    let bytes = long_document();
    let cancel = AtomicBool::new(false);
    let reader = Tripwire {
        inner: Cursor::new(bytes.as_slice()),
        after: bytes.len() + 8_192,
        read: 0,
        action: Trip::Cancel(&cancel),
    };
    let result = read_word(reader, &UNLIMITED, &patient(&cancel));
    assert!(matches!(result, Err(WordError::Cancelled)), "{result:?}");
}

#[test]
fn a_damaged_end_record_does_not_lead_to_an_earlier_one() {
    let mut bytes = Package::docx(&paragraph("Inner")).build();
    bytes.extend(std::iter::repeat_n(b'J', 4096));
    // An end record whose directory, somewhere in the junk, is not there.
    let directory = u32::try_from(bytes.len() - 64).unwrap();
    bytes.extend(b"PK\x05\x06\0\0\0\0");
    bytes.extend(1_u16.to_le_bytes());
    bytes.extend(1_u16.to_le_bytes());
    bytes.extend(46_u32.to_le_bytes());
    bytes.extend(directory.to_le_bytes());
    bytes.extend(0_u16.to_le_bytes());
    // zip alone would go back to the inner document's end record.
    assert!(zip::ZipArchive::new(Cursor::new(&bytes)).is_ok());
    assert_invalid(read(&bytes));
}

/// A file of `len` bytes, zeros and then `tail`, that notes where it was asked to seek and the
/// lowest position it was asked to seek to or read from.
struct Sparse {
    len: u64,
    tail: Vec<u8>,
    position: u64,
    seeks: Vec<u64>,
    lowest: u64,
}

impl Sparse {
    fn new(len: u64, tail: Vec<u8>) -> Self {
        Self {
            len,
            tail,
            position: 0,
            seeks: Vec::new(),
            lowest: u64::MAX,
        }
    }
}

impl Read for Sparse {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        self.lowest = self.lowest.min(self.position);
        let tail_at = self.len - self.tail.len() as u64;
        let count = buf
            .len()
            .min(self.len.saturating_sub(self.position) as usize);
        for (offset, byte) in buf[..count].iter_mut().enumerate() {
            let at = self.position + offset as u64;
            *byte = at
                .checked_sub(tail_at)
                .map_or(0, |index| self.tail[index as usize]);
        }
        self.position += count as u64;
        Ok(count)
    }
}

impl Seek for Sparse {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        let position = match to {
            SeekFrom::Start(at) => Some(at),
            SeekFrom::End(delta) => self.len.checked_add_signed(delta),
            SeekFrom::Current(delta) => self.position.checked_add_signed(delta),
        }
        .ok_or_else(|| io::Error::from(io::ErrorKind::InvalidInput))?;
        self.seeks.push(position);
        self.lowest = self.lowest.min(position);
        self.position = position;
        Ok(position)
    }
}

/// A zip64 end record giving its size field, its entries (on this disk and in all) and where its
/// directory starts; disk 0.
fn zip64_end_record(record_size: u64, entries: u64, directory: u64) -> Vec<u8> {
    zip64_end_record_on((0, 0), record_size, entries, directory)
}

/// A zip64 end record as [`zip64_end_record`] gives, on the disks given: its own and its
/// directory's.
fn zip64_end_record_on(
    (disk, directory_disk): (u32, u32),
    record_size: u64,
    entries: u64,
    directory: u64,
) -> Vec<u8> {
    let mut record = b"PK\x06\x06".to_vec();
    record.extend(record_size.to_le_bytes());
    // The versions that made it and that it needs.
    record.extend([45, 0, 45, 0]);
    record.extend(disk.to_le_bytes());
    record.extend(directory_disk.to_le_bytes());
    record.extend(entries.to_le_bytes());
    record.extend(entries.to_le_bytes());
    // The directory's size, then where it starts.
    record.extend(0_u64.to_le_bytes());
    record.extend(directory.to_le_bytes());
    record
}

/// A zip64 end record locator pointing at `record_at`, on one disk.
fn zip64_locator(record_at: u64) -> Vec<u8> {
    let mut locator = b"PK\x06\x07\0\0\0\0".to_vec();
    locator.extend(record_at.to_le_bytes());
    locator.extend(1_u32.to_le_bytes());
    locator
}

/// A classic end record of `entries` entries and a directory of `directory_len` bytes at
/// `directory`, without a comment; `u16::MAX` and `u32::MAX` defer to a zip64 record.
fn classic_end_record(entries: u16, directory_len: u32, directory: u32) -> Vec<u8> {
    let mut record = b"PK\x05\x06\0\0\0\0".to_vec();
    record.extend(entries.to_le_bytes());
    record.extend(entries.to_le_bytes());
    record.extend(directory_len.to_le_bytes());
    record.extend(directory.to_le_bytes());
    record.extend([0, 0]);
    record
}

/// The most entries a zip64 record at `record_at` can declare and zip still take: a fixed header
/// each, ending before it, from a start no lower than their count. Returns them and that start.
fn most_entries_before(record_at: u64) -> (u64, u64) {
    let entries = record_at / 47;
    (entries, record_at - 46 * entries)
}

/// A file crafted to lead zip to a zip64 record the check never took.
struct Crafted {
    file: Sparse,
    /// Where zip alone looks for that record's directory, once it has reserved memory for it.
    declared: u64,
    /// The lowest position the check reads.
    read_from: u64,
}

/// Makes a crafted file of the length given.
type Craft = fn(u64) -> Crafted;

/// Where the last bytes of a file of `len` bytes start, in which the end record is looked for.
fn tail_start(len: u64) -> u64 {
    len - (END_LEN + MAX_COMMENT_LEN) as u64
}

/// A file of `len` bytes whose end record defers to `first(at)`, a zip64 record at `at` that zip
/// does not take as it is, followed by one it takes, declaring about `len` / 47 entries.
fn behind_a_zip64_record(len: u64, first: fn(u64) -> Vec<u8>) -> Crafted {
    let record = ZIP64_END_LEN as u64;
    let first_at = len - (2 * record + (LOCATOR_LEN + END_LEN) as u64);
    let second = first_at + record;
    let (entries, directory) = most_entries_before(second);
    let mut tail = first(first_at);
    tail.extend(zip64_end_record(record - 12, entries, directory));
    tail.extend(zip64_locator(first_at));
    tail.extend(classic_end_record(u16::MAX, u32::MAX, u32::MAX));
    Crafted {
        file: Sparse::new(len, tail),
        // zip counts the archive from where it found the second record, not the first.
        declared: directory + (second - first_at),
        read_from: tail_start(len),
    }
}

/// A file of `len` bytes whose end record names a directory that is not there, after an earlier
/// end record that defers to a zip64 record declaring about `len` / 47 entries.
fn an_earlier_zip64_record(len: u64) -> Crafted {
    const JUNK: u64 = 100;
    let record_at = len - ((ZIP64_END_LEN + LOCATOR_LEN + 2 * END_LEN) as u64 + JUNK);
    let (entries, directory) = most_entries_before(record_at);
    let mut tail = zip64_end_record(ZIP64_END_LEN as u64 - 12, entries, directory);
    tail.extend(zip64_locator(record_at));
    // It defers by its entries and directory length only; its directory offset is before the
    // window, as at an end record zip stops at.
    tail.extend(classic_end_record(u16::MAX, u32::MAX, 0));
    let junk_at = u32::try_from(record_at + tail.len() as u64).unwrap();
    tail.extend(std::iter::repeat_n(b'J', JUNK as usize));
    tail.extend(classic_end_record(1, 46, junk_at));
    Crafted {
        file: Sparse::new(len, tail),
        declared: directory,
        read_from: tail_start(len),
    }
}

/// As [`an_earlier_zip64_record`], but the end record names a directory a million bytes long,
/// with a central header at its start and nothing after it; the earlier end record, its locator
/// and its zip64 record lie in the middle, before the tail.
fn a_long_directory_before_a_zip64_record(len: u64) -> Crafted {
    let end = len - END_LEN as u64;
    let directory = end - 1_000_000;
    let earlier = directory + 500_000;
    let locator_at = earlier - LOCATOR_LEN as u64;
    let record_at = locator_at - ZIP64_END_LEN as u64;
    let (entries, declared) = most_entries_before(record_at);
    let mut tail = vec![0; (end - directory) as usize];
    let mut put = |at: u64, bytes: &[u8]| {
        let at = (at - directory) as usize;
        tail[at..at + bytes.len()].copy_from_slice(bytes);
    };
    put(directory, b"PK\x01\x02");
    put(
        record_at,
        &zip64_end_record(ZIP64_END_LEN as u64 - 12, entries, declared),
    );
    put(locator_at, &zip64_locator(record_at));
    put(earlier, &classic_end_record(u16::MAX, u32::MAX, 0));
    tail.extend(classic_end_record(
        2,
        u32::try_from(end - directory).unwrap(),
        u32::try_from(directory).unwrap(),
    ));
    Crafted {
        file: Sparse::new(len, tail),
        declared,
        read_from: directory - FINDER_WINDOW,
    }
}

#[test]
fn zip_never_reaches_a_zip64_end_record_the_check_did_not_take() {
    // zip reserves memory for every entry a zip64 record declares (over 200 bytes each, gigabytes
    // for a large file) just before it seeks to that record's directory. The check refuses each
    // of these files itself, before zip loads anything.
    const REACHES_LOCATOR: u64 = 2 * ZIP64_END_LEN as u64 - 12;
    let crafted: [(&str, Craft, &str); 7] = [
        (
            "after a record of a size below zip's least",
            |len| behind_a_zip64_record(len, |at| zip64_end_record(0, 1, at)),
            ZIP64_RECORD_REFUSED,
        ),
        // Without its signature, a record zip would take: zip looks for one after it.
        (
            "after a record without its signature",
            |len| {
                behind_a_zip64_record(len, |at| {
                    let mut record = zip64_end_record(REACHES_LOCATOR, 1, at - 46);
                    record[..4].copy_from_slice(b"XXXX");
                    record
                })
            },
            ZIP64_RECORD_MISSING,
        ),
        // Each of these first records breaks one rule only.
        (
            "after a record whose size does not reach its locator",
            |len| behind_a_zip64_record(len, |at| zip64_end_record(44, 1, at - 46)),
            ZIP64_RECORD_REFUSED,
        ),
        (
            "after a record whose directory is on another disk than the locator's",
            |len| {
                behind_a_zip64_record(len, |at| {
                    zip64_end_record_on((1, 1), REACHES_LOCATOR, 1, at - 46)
                })
            },
            ZIP64_RECORD_REFUSED,
        ),
        (
            "after a record whose entries do not fit before it",
            |len| {
                behind_a_zip64_record(len, |at| {
                    zip64_end_record_on((0, 0), REACHES_LOCATOR, 1, at)
                })
            },
            ZIP64_RECORD_REFUSED,
        ),
        (
            "behind an end record whose directory fails",
            an_earlier_zip64_record,
            EARLIER_END_RECORD,
        ),
        (
            "behind a long directory",
            a_long_directory_before_a_zip64_record,
            EARLIER_END_RECORD,
        ),
    ];
    let len = 4 << 20;
    for (name, crafted, detail) in crafted {
        let mut alone = crafted(len);
        assert!(zip::ZipArchive::new(&mut alone.file).is_err(), "{name}");
        assert!(
            alone.file.seeks.contains(&alone.declared),
            "zip alone, {name}"
        );

        let mut checked = crafted(len);
        let cancel = AtomicBool::new(false);
        let result = read_word(&mut checked.file, &UNLIMITED, &patient(&cancel));
        assert!(
            matches!(&result, Err(WordError::Invalid(found)) if found == detail),
            "{name}: {result:?}"
        );
        assert_eq!(checked.file.lowest, checked.read_from, "{name}");
    }
}

#[test]
fn refuses_a_zip64_end_record_zip_would_not_take() {
    let mut bytes = Package::docx(&paragraph("Zip64")).zip64().build();
    // zip writes the classic record's own values, so it does not defer to the zip64 one, which
    // is then never read: by zip, nor by the check.
    assert_eq!(paragraphs_of(&bytes), ["Zip64"]);
    let end = bytes.len() - END_LEN;
    bytes[end + 10..end + 12].copy_from_slice(&[0xFF; 2]);
    let record_at = end - LOCATOR_LEN - ZIP64_END_LEN;
    assert_eq!(bytes[record_at..record_at + 4], ZIP64_END_SIGNATURE);
    let patched = |at: usize, value: &[u8]| {
        let mut bytes = bytes.clone();
        bytes[record_at + at..record_at + at + value.len()].copy_from_slice(value);
        bytes
    };
    assert_eq!(paragraphs_of(&patched(4, &44_u64.to_le_bytes())), ["Zip64"]);
    // Each breaks one rule (the first two, the size's), so the check, not zip, refuses it.
    for (rule, at, value) in [
        (
            "a size that does not reach the locator",
            4,
            45_u64.to_le_bytes().to_vec(),
        ),
        ("a size below zip's least", 4, 0_u64.to_le_bytes().to_vec()),
        (
            "another disk than its directory's",
            16,
            1_u32.to_le_bytes().to_vec(),
        ),
        (
            "a directory on another disk than the locator's",
            16,
            [1, 0, 0, 0, 1, 0, 0, 0].to_vec(),
        ),
        (
            "more entries on this disk than in all",
            24,
            9_u64.to_le_bytes().to_vec(),
        ),
        (
            "more entries than fit between the directory's start and the record",
            32,
            1_000_u64.to_le_bytes().to_vec(),
        ),
    ] {
        let result = read(&patched(at, &value));
        assert!(
            matches!(&result, Err(WordError::Invalid(found)) if found == ZIP64_RECORD_REFUSED),
            "{rule}: {result:?}"
        );
    }
    // A size below zip's least as the one rule broken: the record of no entries then overlaps
    // its locator, whose offset field is the record's directory.
    let len = 4096;
    let record_at = len - (40 + LOCATOR_LEN + END_LEN) as u64;
    let mut tail = zip64_end_record(28, 0, 0);
    tail.truncate(40);
    tail.extend(zip64_locator(record_at));
    tail.extend(classic_end_record(u16::MAX, u32::MAX, u32::MAX));
    let cancel = AtomicBool::new(false);
    let result = read_word(Sparse::new(len, tail), &UNLIMITED, &patient(&cancel));
    assert_refused(result, ZIP64_RECORD_REFUSED);
}

#[test]
fn refuses_an_inconsistent_locator_and_a_directory_after_the_end_record() {
    // A deferring end record with a comment, its locator naming a zip64 record inside the comment,
    // after the locator.
    let mut bytes = vec![0; 1000];
    let end = bytes.len() + LOCATOR_LEN;
    bytes.extend(zip64_locator((end + END_LEN + 10) as u64));
    let mut record = classic_end_record(u16::MAX, u32::MAX, u32::MAX);
    record[20..22].copy_from_slice(&100_u16.to_le_bytes());
    bytes.extend(record);
    let mut comment = vec![0; 100];
    comment[10..10 + ZIP64_END_LEN].copy_from_slice(&zip64_end_record(44, 1, 0));
    bytes.extend(comment);
    assert_refused(read(&bytes), LOCATOR_REFUSED);

    // A locator of more than one disk.
    let mut bytes = Package::docx(&paragraph("Zip64")).zip64().build();
    let end = bytes.len() - END_LEN;
    bytes[end + 10..end + 12].copy_from_slice(&[0xFF; 2]);
    let disks = end - LOCATOR_LEN + 16;
    bytes[disks..disks + 4].copy_from_slice(&2_u32.to_le_bytes());
    assert_refused(read(&bytes), LOCATOR_REFUSED);

    // An end record whose directory would start after it.
    let mut bytes = vec![0; 100];
    bytes.extend(classic_end_record(1, 46, 5000));
    assert_refused(read(&bytes), DIRECTORY_AFTER_END);
}

/// A reader over `bytes` that counts the bytes read, and fails once more than `max` were: so that
/// work growing with the square of a file's length fails fast.
struct Metered<'a> {
    inner: Cursor<&'a [u8]>,
    read: u64,
    max: u64,
}

impl<'a> Metered<'a> {
    fn new(bytes: &'a [u8], max: u64) -> Self {
        Self {
            inner: Cursor::new(bytes),
            read: 0,
            max,
        }
    }
}

impl Read for Metered<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if self.read > self.max {
            return Err(io::Error::other("read too much"));
        }
        let read = self.inner.read(buf)?;
        self.read += read as u64;
        Ok(read)
    }
}

impl Seek for Metered<'_> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.inner.seek(to)
    }
}

/// A file of about `len` bytes: `junk` zeros, then nothing but classic end records of one entry
/// whose directory, right after the junk, has no central header.
fn end_record_flood(junk: usize, len: usize) -> Vec<u8> {
    let record = classic_end_record(1, 46, u32::try_from(junk).unwrap());
    let mut bytes = vec![0; junk];
    while bytes.len() + END_LEN <= len {
        bytes.extend(&record);
    }
    bytes
}

#[test]
fn refuses_a_flood_of_end_records_before_zip_searches_them() {
    // zip goes back from each end record whose directory it cannot find to the one before it,
    // and looks for that one's directory from its start up to the record: work that grows with
    // the square of the file's length, seconds for 1 MiB. The check reads the file once.
    for junk in [0, 4096] {
        let bytes = end_record_flood(junk, 1 << 20);
        let max = 16 * bytes.len() as u64;
        let mut alone = Metered::new(&bytes, max);
        assert!(zip::ZipArchive::new(&mut alone).is_err());
        assert!(alone.read > max, "zip alone read {} bytes", alone.read);

        let mut file = Metered::new(&bytes, max);
        let cancel = AtomicBool::new(false);
        let result = read_word(&mut file, &UNLIMITED, &patient(&cancel));
        assert_refused(result, EARLIER_END_RECORD);
        assert!(file.read <= bytes.len() as u64, "{} bytes read", file.read);
    }
}

/// A file whose end record names a directory without a central header, a little after
/// `earlier`, which the check's window holds.
fn behind_an_end_record(earlier: &[u8]) -> Vec<u8> {
    let mut bytes = vec![0; 8192];
    bytes.extend(earlier);
    bytes.extend([0; 100]);
    let directory = u32::try_from(bytes.len() - 50).unwrap();
    bytes.extend(classic_end_record(1, 46, directory));
    bytes
}

#[test]
fn refuses_an_earlier_end_record_unless_zip_stops_there() {
    // zip goes back to the earlier record when the directory of the last one does not load.
    let mut long_comment = classic_end_record(1, 46, 0);
    long_comment[20..22].copy_from_slice(&u16::MAX.to_le_bytes());
    for (name, earlier) in [
        (
            "deferring to zip64",
            classic_end_record(u16::MAX, u32::MAX, 0),
        ),
        ("with a comment past the file's end", long_comment),
        ("of no entries", classic_end_record(0, 0, 0)),
        (
            "with a directory in the window",
            classic_end_record(1, 46, 8000),
        ),
    ] {
        let result = read(&behind_an_end_record(&earlier));
        assert!(
            matches!(&result, Err(WordError::Invalid(found)) if found == EARLIER_END_RECORD),
            "{name}: {result:?}"
        );
    }
    // At one whose directory starts before the window, zip stops: its first read there is
    // refused.
    assert_refused(
        read(&behind_an_end_record(&classic_end_record(1, 46, 0))),
        NO_DIRECTORY,
    );
}

#[test]
fn stops_at_an_embedded_package_when_the_directory_does_not_load() {
    // An embedded document stored as the last part ends in an end record just before the
    // directory, in the bytes zip may read while it loads the directory.
    let inner = Package::docx(&paragraph("Inner")).build();
    let mut bytes = Package::docx(&paragraph("Outer"))
        .stored("word/media/image1.png", vec![0; 4096])
        .stored("word/embeddings/Document.docx", &inner)
        .build();
    let end = bytes.len() - END_LEN;
    let inner_end = le32(&bytes, end + 16) as usize - END_LEN;
    assert_eq!(bytes[inner_end..inner_end + 4], END_SIGNATURE);
    assert_eq!(paragraphs_of(&bytes), ["Outer"]);

    // With one entry more than the directory holds, zip goes back to the inner record, which
    // leads it to the inner document; the check's window stops it there.
    let entries = le16(&bytes, end + 10) + 1;
    for at in [end + 8, end + 10] {
        bytes[at..at + 2].copy_from_slice(&entries.to_le_bytes());
    }
    let alone = zip::ZipArchive::new(Cursor::new(&bytes)).expect("zip alone takes the inner one");
    assert_eq!(alone.len(), 3);
    assert_refused(read(&bytes), NO_DIRECTORY);
}

/// A file that grows once it has been read from, as when another program appends to a file
/// while Folio reads it.
struct Growing {
    file: Cursor<Vec<u8>>,
    appended: Option<Vec<u8>>,
}

impl Read for Growing {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let read = self.file.read(buf)?;
        if let Some(appended) = self.appended.take() {
            self.file.get_mut().extend(appended);
        }
        Ok(read)
    }
}

impl Seek for Growing {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.file.seek(to)
    }
}

#[test]
fn zip_loads_the_directory_the_check_read() {
    let checked = Package::docx(&paragraph("Checked")).build();
    let appended = Package::docx(&paragraph("Appended"))
        .stored("word/media/image1.png", vec![0; 4096])
        .build();
    // Read after it is appended, the file is the appended document, after bytes of no matter.
    let both = [checked.as_slice(), &appended].concat();
    assert_eq!(paragraphs_of(&both), ["Appended"]);

    // Appended while it is read, after the check: zip reads what the check read.
    let file = Growing {
        file: Cursor::new(checked),
        appended: Some(appended),
    };
    let cancel = AtomicBool::new(false);
    let text = read_word(file, &UNLIMITED, &patient(&cancel)).unwrap();
    assert_eq!(text.paragraphs, ["Checked"]);
}

#[test]
fn reads_the_file_where_the_window_leaves_off() {
    let bytes: Vec<u8> = (0..=255).collect();
    let cancel = AtomicBool::new(false);
    let control = patient(&cancel);
    let budget = Budget::new(&UNLIMITED, &control);
    let mut source = Source {
        inner: Cursor::new(&bytes[..]),
        budget: &budget,
        position: 0,
        synced: true,
    };
    let window = |start: u64| {
        Some(Window {
            start,
            bytes: vec![b'w'; 256 - start as usize],
        })
    };
    let mut two = [0; 2];
    // After reading from the window, the file is read on from there…
    *budget.window.borrow_mut() = window(0);
    source.read_exact(&mut two).unwrap();
    assert_eq!(two, [b'w'; 2]);
    budget.window.take();
    source.read_exact(&mut two).unwrap();
    assert_eq!(two, [2, 3]);
    // …also after seeking in the window, wherever the file was left.
    source.seek(SeekFrom::End(0)).unwrap();
    *budget.window.borrow_mut() = window(200);
    source.seek(SeekFrom::Start(250)).unwrap();
    source.read_exact(&mut two).unwrap();
    budget.window.take();
    source.read_exact(&mut two).unwrap();
    assert_eq!(two, [252, 253]);
    // A seek from the current position counts from there.
    *budget.window.borrow_mut() = window(200);
    source.seek(SeekFrom::End(-50)).unwrap();
    source.read_exact(&mut two).unwrap();
    budget.window.take();
    assert_eq!(source.stream_position().unwrap(), 208);
    source.read_exact(&mut two).unwrap();
    assert_eq!(two, [208, 209]);
    assert!(budget.take_stop().is_none());
}

#[test]
fn cuts_details_that_come_from_the_file() {
    // quick-xml names both tags of a mismatched end tag in full. The open tag's length moves the
    // cut across the three bytes of a character.
    for open in ["a", "ab", "abc"] {
        let main = format!("<{open}></{}>", "标".repeat(100_000));
        let result = read(&with_main_part(&main).build());
        let Err(WordError::Invalid(detail)) = &result else {
            panic!("{result:?}");
        };
        assert!(
            detail.len() <= MAX_DETAIL + '…'.len_utf8(),
            "{}",
            detail.len()
        );
        assert!(detail.ends_with("标…"), "{detail}");
    }
}

#[test]
fn cuts_too_large_details_that_name_a_part() {
    // The nesting error names the main part, whose name the package's relationships give.
    let name = format!("word/{}.xml", "n".repeat(60_000));
    let nested = format!(
        "{}{}",
        "<w:customXml>".repeat(300),
        "</w:customXml>".repeat(300)
    );
    let package = Package::default()
        .part("_rels/.rels", relationships(&[("officeDocument", &name)]))
        .part(&name, document(&nested));
    let result = read(&package.build());
    let Err(WordError::TooLarge(detail)) = &result else {
        panic!("{result:?}");
    };
    assert!(
        detail.len() <= MAX_DETAIL + '…'.len_utf8(),
        "{}",
        detail.len()
    );
    assert!(detail.ends_with("nn…"), "{detail}");
}

/// Bytes ending in an end record with arbitrary fields and no comment, so that the directory
/// zip then loads is arbitrary too.
fn with_end_record(mut bytes: Vec<u8>, fields: [u8; 16]) -> Vec<u8> {
    bytes.extend(b"PK\x05\x06");
    bytes.extend(fields);
    bytes.extend([0, 0]);
    bytes
}

proptest! {
    #![proptest_config(ProptestConfig::with_cases(32))]

    #[test]
    fn arbitrary_bytes_never_panic(
        bytes in proptest::collection::vec(any::<u8>(), 0..2_048),
        fields in any::<[u8; 16]>(),
    ) {
        let _ = read(&bytes);
        let _ = read(&with_end_record(bytes, fields));
    }

    #[test]
    fn damaged_documents_never_panic(
        changes in proptest::collection::vec((any::<prop::sample::Index>(), any::<u8>()), 1..16),
    ) {
        let mut bytes = SAMPLE.clone();
        for (at, value) in changes {
            let at = at.index(bytes.len());
            bytes[at] = value;
        }
        let _ = read(&bytes);
    }

    #[test]
    fn a_limited_reading_is_the_start_of_the_whole(max_text in 0_usize..120) {
        let whole = paragraphs_of(&SAMPLE);
        let text = read_with(&SAMPLE, &WordLimits::with_max_text(max_text)).unwrap();
        // Each paragraph begins one of the whole's, in order. One may be missing: a text box
        // the stop came before, whose paragraphs would have come before its anchor's.
        let mut rest = whole.iter();
        for part in &text.paragraphs {
            prop_assert!(
                rest.any(|full| full.starts_with(part.as_str())),
                "{part:?} in {:?}", text.paragraphs
            );
        }
        let used: usize = text.paragraphs.iter().map(|paragraph| paragraph.len() + 1).sum();
        prop_assert!(used <= max_text);
        prop_assert_eq!(text.complete, text.paragraphs == whole);
    }
}
