use proptest::prelude::*;

use super::*;
use crate::paths::{self, PATHS_VERSION};

fn name_error(name: &str) -> Option<NameError> {
    match Name::parse(name) {
        Ok(_) => None,
        Err(ValueError::Name(error)) => Some(error),
        Err(other) => panic!("{name:?}: {other:?}"),
    }
}

#[test]
fn names_follow_the_rules_in_their_order() {
    use NameError::*;
    for (name, expected) in [
        ("2026 秋", None),
        ("第3讲 特征值.pptx", None),
        (".gitignore", None),
        (" leading space", None),
        ("a\u{7f}b", None),
        ("Files & Backup.md", None),
        ("", Some(Empty)),
        (".", Some(DotName)),
        ("..", Some(DotName)),
        ("...", Some(TrailingDotOrSpace)),
        ("a/b", Some(InvalidCharacter('/'))),
        ("a\\b", Some(InvalidCharacter('\\'))),
        ("a:b", Some(InvalidCharacter(':'))),
        ("a\0b", Some(InvalidCharacter('\0'))),
        ("a\u{1f}b", Some(InvalidCharacter('\u{1f}'))),
        // Rule 3 comes before rule 4.
        ("a<b.", Some(InvalidCharacter('<'))),
        ("notes.", Some(TrailingDotOrSpace)),
        ("notes ", Some(TrailingDotOrSpace)),
        // Rule 4 comes before rule 5.
        ("CON ", Some(TrailingDotOrSpace)),
        ("CON", Some(ReservedName)),
        // Rule 5 comes before rule 7.
        ("CON.e\u{301}", Some(ReservedName)),
        ("e\u{301}", Some(NotNfc)),
    ] {
        assert_eq!(name_error(name), expected, "{name:?}");
    }
    for ch in ['<', '>', ':', '"', '/', '\\', '|', '?', '*', '\t', '\n'] {
        let name = format!("a{ch}b");
        assert_eq!(name_error(&name), Some(InvalidCharacter(ch)), "{name:?}");
    }
}

#[test]
fn device_names_are_reserved_in_any_case_and_with_any_extension() {
    for name in [
        "CON",
        "con",
        "Prn",
        "aux",
        "NUL",
        "nul.txt",
        "Nul.tar.gz",
        "CON .txt",
        "CONIN$",
        "conout$.log",
        "COM0",
        "com9",
        "LPT1",
        "lpt9.md",
        "COM¹",
        "COM²",
        "LPT³.txt",
        "COM1 .x",
    ] {
        assert_eq!(name_error(name), Some(NameError::ReservedName), "{name:?}");
    }
    for name in [
        "CONSOLE",
        "COM10",
        "COM",
        "LPT",
        "COMA",
        "LPT¹¹",
        "NUL-notes.md",
        "CO",
        "C",
        "conin",
        "COM 1",
        "xCON",
        "ÇON",
        "COM\u{2074}",
        "CON\u{a0}.txt",
    ] {
        assert_eq!(name_error(name), None, "{name:?}");
    }
}

#[test]
fn names_are_limited_in_utf16_units() {
    assert_eq!(name_error(&"a".repeat(255)), None);
    assert_eq!(name_error(&"a".repeat(256)), Some(NameError::TooLong));
    // Characters outside the BMP take two units each.
    assert_eq!(name_error(&format!("{}a", "😀".repeat(127))), None);
    assert_eq!(name_error(&"😀".repeat(128)), Some(NameError::TooLong));
    assert_eq!(name_error(&"台".repeat(255)), None);
    // Rule 6 comes before rule 7.
    assert_eq!(
        name_error(&"e\u{301}".repeat(128)),
        Some(NameError::TooLong)
    );
}

#[test]
fn names_must_be_nfc() {
    assert_eq!(name_error("résumé.docx"), None);
    assert_eq!(
        name_error("re\u{301}sume\u{301}.docx"),
        Some(NameError::NotNfc)
    );
    // The Angstrom sign normalizes to Å, so it is not NFC either.
    assert_eq!(name_error("\u{212b}"), Some(NameError::NotNfc));
    assert_eq!(name_error("\u{c5}"), None);
}

#[test]
fn names_keep_their_text_and_sort_by_bytes() {
    let mut names: Vec<Name> = ["a.md", "B.md", "Ａ.txt", "😀.md", "_"]
        .iter()
        .map(|text| Name::parse(text).unwrap())
        .collect();
    names.sort();
    let sorted: Vec<&str> = names.iter().map(Name::as_str).collect();
    assert_eq!(sorted, ["B.md", "_", "a.md", "Ａ.txt", "😀.md"]);
    assert_eq!(names[0].to_string(), "B.md");
}

#[test]
fn paths_are_valid_names_joined_by_slashes() {
    let path = TreePath::parse("2026 秋/线性代数/第3讲 特征值.pptx").unwrap();
    assert_eq!(
        path.names().collect::<Vec<_>>(),
        ["2026 秋", "线性代数", "第3讲 特征值.pptx"]
    );
    assert_eq!(path.name(), "第3讲 特征值.pptx");
    assert_eq!(TreePath::parse("a").unwrap().name(), "a");
    for (text, expected) in [
        ("", ValueError::Name(NameError::Empty)),
        ("/a", ValueError::Name(NameError::Empty)),
        ("a/", ValueError::Name(NameError::Empty)),
        ("a//b", ValueError::Name(NameError::Empty)),
        ("a/../b", ValueError::Name(NameError::DotName)),
        ("a./b", ValueError::Name(NameError::TrailingDotOrSpace)),
        ("a/nul.txt", ValueError::Name(NameError::ReservedName)),
        (
            "a\\b/c",
            ValueError::Name(NameError::InvalidCharacter('\\')),
        ),
    ] {
        assert_eq!(TreePath::parse(text), Err(expected), "{text:?}");
    }
}

#[test]
fn paths_are_limited_in_utf16_units() {
    // 162 names of 200 units with their slashes, then a last name: 32,562 units before it.
    let long = |last: usize| {
        format!(
            "{}{}",
            format!("{}/", "a".repeat(200)).repeat(162),
            "a".repeat(last)
        )
    };
    assert!(TreePath::parse(&long(205)).is_ok());
    assert_eq!(TreePath::parse(&long(206)), Err(ValueError::PathTooLong));
    // A name that is too long is reported as such, whatever the path's length.
    assert_eq!(
        TreePath::parse(&format!("a/{}", "b".repeat(256))),
        Err(ValueError::Name(NameError::TooLong))
    );
}

#[test]
fn tree_paths_and_library_paths_convert_both_ways() {
    let library = RelPath::parse("2026 秋/线性代数").unwrap();
    let tree = TreePath::try_from(&library).unwrap();
    assert_eq!(tree.as_str(), library.as_str());
    assert_eq!(RelPath::try_from(&tree).unwrap(), library);
}

#[test]
fn times_are_exact_utc_seconds_from_1970_to_9999() {
    for text in [
        "2026-10-03T21:11:00Z",
        "1970-01-01T00:00:00Z",
        "9999-12-31T23:59:59Z",
        "2028-02-29T12:00:00Z",
        "2000-02-29T00:00:00Z",
        "2026-04-30T00:00:00Z",
        "2026-12-31T23:59:59Z",
    ] {
        let time = Timestamp::parse(text).unwrap();
        assert_eq!(time.to_string(), text);
        assert_eq!(format!("{time:?}"), text);
        assert_eq!(text.parse::<Timestamp>(), Ok(time));
    }
    for text in [
        "2026-02-29T12:00:00Z",
        "2100-02-29T12:00:00Z",
        "1900-02-29T12:00:00Z",
        "2026-04-31T00:00:00Z",
        "2026-00-10T00:00:00Z",
        "2026-13-10T00:00:00Z",
        "2026-10-00T00:00:00Z",
        "2026-10-32T00:00:00Z",
        "2026-10-03T21:11:00.5Z",
        "2026-10-03T21:11:00+00:00",
        "2026-10-03 21:11:00Z",
        "2026-10-03t21:11:00Z",
        "2026-10-03T21:11:00z",
        "2026-10-03T21:11:00",
        "2026-10-03T24:00:00Z",
        "2026-10-03T23:60:00Z",
        "2026-10-03T23:59:60Z",
        "1969-12-31T23:59:59Z",
        "0000-01-01T00:00:00Z",
        "2026-1-03T21:11:00Z",
        "+2026-10-03T21:11:00Z",
        "2026-10-03T21:11:0aZ",
        "2026-10-03T21:11:00ZZ",
        "２026-10-03T21:11:00Z",
        "",
    ] {
        assert_eq!(Timestamp::parse(text), Err(ValueError::Time), "{text:?}");
    }
}

#[test]
fn times_convert_to_and_from_unix_seconds() {
    for (text, seconds) in [
        ("1970-01-01T00:00:00Z", 0),
        ("1970-01-02T00:00:00Z", 86_400),
        ("2000-02-29T23:59:59Z", 951_868_799),
        ("2000-03-01T00:00:00Z", 951_868_800),
        ("2026-10-03T21:11:00Z", 1_791_061_860),
        ("2028-02-29T12:00:00Z", 1_835_438_400),
        ("2038-01-19T03:14:08Z", 2_147_483_648),
        ("2100-03-01T00:00:00Z", 4_107_542_400),
        ("9999-12-31T23:59:59Z", 253_402_300_799),
    ] {
        let time = Timestamp::parse(text).unwrap();
        assert_eq!(time.unix_seconds(), seconds, "{text}");
        assert_eq!(Timestamp::from_unix_seconds(seconds), Ok(time), "{text}");
    }
    assert_eq!(Timestamp::MIN.to_string(), "1970-01-01T00:00:00Z");
    assert_eq!(Timestamp::MAX.to_string(), "9999-12-31T23:59:59Z");
    assert_eq!(
        Timestamp::from_unix_seconds(Timestamp::MAX.unix_seconds() + 1),
        Err(ValueError::Time)
    );
    assert_eq!(
        Timestamp::from_unix_seconds(u64::MAX),
        Err(ValueError::Time)
    );
}

#[test]
fn device_ids_are_32_lower_case_hexadecimal_digits() {
    assert!(DeviceId::parse("8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c").is_ok());
    for text in [
        "8C1E0D2B4A6F43E19D7C5B3A2F1E0D9C",
        "8c1e0d2b4a6f43e19d7c5b3a2f1e0d9",
        "8c1e0d2b4a6f43e19d7c5b3a2f1e0d9c0",
        "8c1e0d2b4a6f43e19d7c5b3a2f1e0d9g",
        "",
    ] {
        assert_eq!(DeviceId::parse(text), Err(ValueError::DeviceId), "{text:?}");
    }
}

#[test]
fn library_ids_are_32_lower_case_hexadecimal_digits() {
    let text = "48ffdfb335860f2c15c8bccf2a90e720";
    let id = LibraryId::parse(text).unwrap();
    assert_eq!(id.as_str(), text);
    let from_library = meta::LibraryId::parse(text).unwrap();
    assert_eq!(LibraryId::try_from(&from_library), Ok(id));
    for text in [
        "48FFDFB335860F2C15C8BCCF2A90E720",
        "48ffdfb335860f2c15c8bccf2a90e72",
        "48ffdfb335860f2c15c8bccf2a90e7200",
        "48ffdfb335860f2c15c8bccf2a90e72g",
        "",
    ] {
        assert_eq!(
            LibraryId::parse(text),
            Err(ValueError::LibraryId),
            "{text:?}"
        );
    }
}

#[test]
fn device_names_are_one_line_without_surrounding_white_space() {
    for text in [
        "G16",
        "台式机",
        "Sirui’s Surface",
        "a b",
        "x".repeat(128).as_str(),
        "台".repeat(128).as_str(),
    ] {
        assert!(DeviceName::parse(text).is_ok(), "{text:?}");
    }
    for text in [
        "",
        " G16",
        "G16 ",
        "G16\u{3000}",
        "\u{a0}G16",
        "G16\u{85}",
        "a\nb",
        "a\u{85}b",
        "a\u{7f}b",
        "a\u{9f}b",
        "x".repeat(129).as_str(),
    ] {
        assert_eq!(
            DeviceName::parse(text),
            Err(ValueError::DeviceName),
            "{text:?}"
        );
    }
}

#[test]
fn summaries_are_one_line_of_at_most_256_characters() {
    for text in [
        "MAT232: add lecture 5 slides",
        "中",
        "x".repeat(256).as_str(),
        "😀".repeat(256).as_str(),
    ] {
        assert!(Summary::parse(text).is_ok(), "{text:?}");
    }
    for text in [
        "",
        "line\nbreak",
        " padded",
        "padded ",
        "tab\tinside",
        "x".repeat(257).as_str(),
    ] {
        assert_eq!(Summary::parse(text), Err(ValueError::Summary), "{text:?}");
    }
}

#[test]
fn bodies_may_hold_tabs_and_line_breaks() {
    for text in [
        "- one\n- two",
        "\tindented\n\n  second paragraph",
        " leading space",
        "x",
        "x".repeat(16_384).as_str(),
    ] {
        assert!(Body::parse(text).is_ok(), "{text:?}");
    }
    for text in [
        "",
        "\nstarts with a line break",
        "ends with a line break\n",
        "ends with a space ",
        "ends with a tab\t",
        "ends with an ideographic space\u{3000}",
        "carriage\r\nreturn",
        "bell\u{7}",
        "next line\u{85}x",
        "x".repeat(16_385).as_str(),
    ] {
        assert_eq!(Body::parse(text), Err(ValueError::Body), "{text:?}");
    }
}

/// The frozen sets of §2 equal Rust's current Unicode tables. If a Rust upgrade changes these,
/// the format does not change: keep the frozen sets and update this test.
#[test]
fn white_space_and_control_characters_match_unicode() {
    for ch in (0..=0x10ffff).filter_map(char::from_u32) {
        assert_eq!(is_white_space(ch), ch.is_whitespace(), "{ch:?}");
        assert_eq!(is_control(ch), ch.is_control(), "{ch:?}");
    }
}

#[test]
fn sizes_and_counts_are_bounded_integers() {
    assert_eq!(Size::new(0).map(Size::get), Ok(0));
    assert_eq!(Size::new(Int::MAX.get()), Ok(Size::MAX));
    assert_eq!(Size::new(Int::MAX.get() + 1), Err(ValueError::Size));
    assert_eq!(
        Size::try_from(5_u64)
            .map(|size| size.to_string())
            .as_deref(),
        Ok("5")
    );
    assert_eq!(Size::from(Int::MAX), Size::MAX);
    assert_eq!(Int::from(Size::MAX), Int::MAX);
    assert_eq!(Count::new(0), Err(ValueError::Count));
    assert_eq!(Count::new(1), Ok(Count::MIN));
    assert_eq!(Count::new(Int::MAX.get()), Ok(Count::MAX));
    assert_eq!(Count::new(Int::MAX.get() + 1), Err(ValueError::Count));
    assert_eq!(Count::try_from(Int::default()), Err(ValueError::Count));
    assert_eq!(
        Count::try_from(7_u64)
            .map(|count| count.to_string())
            .as_deref(),
        Ok("7")
    );
    assert_eq!(Int::from(Count::MAX), Int::MAX);
}

#[test]
fn ntfs_names_ignore_ascii_case_dotless_i_and_long_s() {
    for name in [".folio", ".FOLIO", ".Folio", ".folıo", ".FOLıO"] {
        assert!(same_ntfs_name(name, ".folio"), "{name:?}");
    }
    for name in ["store", "STORE", "ſtore", "ſTORE"] {
        assert!(same_ntfs_name(name, "store"), "{name:?}");
    }
    assert!(same_ntfs_name("LOCAL", "local"));
    for name in [
        ".folio2",
        ".foli",
        "folio",
        ".fol\u{130}o",
        ".ｆolio",
        "FOLIO~1",
        ".folio ",
    ] {
        assert!(!same_ntfs_name(name, ".folio"), "{name:?}");
    }
}

/// Names built from the pieces the rules care about.
fn name_like() -> impl Strategy<Value = String> {
    let pieces = vec![
        "CON", "con", "PRN", "aux", "NUL", "CONIN$", "conout$", "COM", "lpt", "1", "0", "¹", "²",
        "³", "10", ".", "..", " ", "a", "Z", "é", "e\u{301}", "\u{301}", "\u{212b}", "😀", "台",
        ":", "/", "\\", "|", "?", "*", "<", ">", "\"", "\0", "\u{1f}", "\u{7f}", "\u{85}", "ı",
        "ſ", "\u{3000}", "\u{a0}",
    ];
    prop_oneof![
        4 => prop::collection::vec(prop::sample::select(pieces), 0..8).prop_map(|parts| parts.concat()),
        1 => any::<String>(),
        // Around the 255-unit limit.
        1 => prop::collection::vec(prop::sample::select(vec!["a", "😀", "é", "e\u{301}"]), 120..260)
            .prop_map(|parts| parts.concat()),
    ]
}

fn path_like() -> impl Strategy<Value = String> {
    prop_oneof![
        4 => prop::collection::vec(name_like(), 1..5).prop_map(|names| names.join("/")),
        // Around the 32,767-unit limit.
        1 => (160usize..=164, 190usize..=215).prop_map(|(count, last)| {
            format!("{}{}", format!("{}/", "a".repeat(200)).repeat(count), "a".repeat(last))
        }),
    ]
}

/// The library's error for the same rule.
fn library_error(error: NameError) -> PathError {
    match error {
        NameError::Empty => PathError::Empty,
        NameError::DotName => PathError::DotSegment,
        NameError::InvalidCharacter(ch) => PathError::ReservedCharacter(ch),
        NameError::TrailingDotOrSpace => PathError::TrailingDotOrSpace,
        NameError::ReservedName => PathError::ReservedName,
        NameError::TooLong => PathError::NameTooLong,
        NameError::NotNfc => PathError::NotNfc,
    }
}

proptest! {
    /// While `PATHS_VERSION` is 1, the frozen rules are the library's (remote-format.md §6.4).
    /// A later paths version may change `check_name`; the frozen rules stay.
    #[test]
    fn frozen_names_follow_check_name_at_paths_version_1(name in name_like()) {
        assert_eq!(PATHS_VERSION, 1, "the frozen name rules equal check_name only at version 1");
        let frozen = check_name(&name).map_err(library_error);
        prop_assert_eq!(frozen, paths::check_name(&name));
    }

    /// The frozen library id rule is the metadata format's (library-core.md §4.2) today.
    #[test]
    fn frozen_library_ids_follow_the_metadata_rule(
        text in prop_oneof![
            "[0-9a-f]{32}",
            "[0-9a-fA-F]{30,34}",
            any::<String>(),
        ]
    ) {
        prop_assert_eq!(
            LibraryId::parse(&text).is_ok(),
            meta::LibraryId::parse(&text).is_ok()
        );
    }

    #[test]
    fn frozen_paths_follow_rel_path_at_paths_version_1(path in path_like()) {
        assert_eq!(PATHS_VERSION, 1, "the frozen path rules equal RelPath only at version 1");
        let frozen = TreePath::parse(&path).map(|_| ()).map_err(|error| match error {
            ValueError::Name(error) => library_error(error),
            ValueError::PathTooLong => PathError::TooLong,
            other => panic!("{other:?}"),
        });
        prop_assert_eq!(frozen, RelPath::parse(&path).map(|_| ()));
    }

    #[test]
    fn times_round_trip_through_seconds_and_text(seconds in 0..=Timestamp::MAX.unix_seconds()) {
        let time = Timestamp::from_unix_seconds(seconds).unwrap();
        prop_assert_eq!(time.unix_seconds(), seconds);
        prop_assert_eq!(Timestamp::parse(&time.to_string()), Ok(time));
    }

    /// The fixed-width text sorts like the times it writes.
    #[test]
    fn times_sort_like_their_text(
        a in 0..=Timestamp::MAX.unix_seconds(),
        b in 0..=Timestamp::MAX.unix_seconds(),
    ) {
        let (a, b) = (Timestamp::from_unix_seconds(a).unwrap(), Timestamp::from_unix_seconds(b).unwrap());
        prop_assert_eq!(a.cmp(&b), a.to_string().cmp(&b.to_string()));
    }

    /// Every day from 1970 to 9999 starts at midnight of a valid date, and days follow each other.
    #[test]
    fn days_follow_each_other(day in 0..(Timestamp::MAX.unix_seconds() / 86_400)) {
        let (year, month, d) = civil_from_days(day);
        prop_assert_eq!(days_from_civil(year, month, d), day);
        prop_assert!((1..=days_in_month(year, month)).contains(&d));
        let next = civil_from_days(day + 1);
        let expected = if d < days_in_month(year, month) {
            (year, month, d + 1)
        } else if month < 12 {
            (year, month + 1, 1)
        } else {
            (year + 1, 1, 1)
        };
        prop_assert_eq!(next, expected);
    }
}
