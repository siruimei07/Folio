use proptest::prelude::*;

use super::*;
use crate::store::strategies;

mod reference;

fn object(members: &[(&str, Value)]) -> Value {
    Value::Object(
        members
            .iter()
            .map(|(key, value)| ((*key).to_owned(), value.clone()))
            .collect(),
    )
}

fn int(value: u64) -> Value {
    Value::Int(Int::new(value).unwrap())
}

/// `levels` objects nested in each other, as `{"a":{"a":{}}}` for 3.
fn nested(levels: usize) -> String {
    format!(
        "{}{{}}{}",
        r#"{"a":"#.repeat(levels - 1),
        "}".repeat(levels - 1)
    )
}

/// What both readers say of `document`: [`check`]'s version, and [`canonical`]'s value.
fn read(document: &[u8]) -> (Result<Option<&str>, JsonError>, Result<Value, JsonError>) {
    (check(document), parse_canonical(document))
}

#[test]
fn check_reads_every_kind_of_value() {
    for document in [
        r#"{"a":[true,false,null,"x",0,-1.5e3],"b":{}}"#,
        " 7 ",
        r#""s""#,
        "[]",
        "null",
    ] {
        assert_eq!(check(document.as_bytes()), Ok(None), "{document}");
    }
}

#[test]
fn check_returns_the_version_as_written() {
    for number in [
        "0",
        "-0",
        "12",
        "-12",
        "1.5",
        "1e3",
        "1E+3",
        "1e-3",
        "0.0",
        "9007199254740993",
        "123456789012345678901234567890",
    ] {
        let document = format!("{{\"x\":[], \"format_version\" : {number} }}");
        assert_eq!(check(document.as_bytes()), Ok(Some(number)), "{number}");
    }
    // Only the document's own member counts, under any spelling of its key, and only a number.
    for (document, version) in [
        (r#"{"format\u005fversion":2}"#, Some("2")),
        (r#"{"a":{"format_version":2}}"#, None),
        (r#"[{"format_version":2}]"#, None),
        (r#"{"format_version":"2"}"#, None),
        (r#"{"format_version":null}"#, None),
        (r#"{"format_version":[2]}"#, None),
        (r#"{"version":2}"#, None),
    ] {
        assert_eq!(check(document.as_bytes()), Ok(version), "{document}");
    }
}

#[test]
fn allows_only_rfc_8259_white_space() {
    let spaced = b" \t\n\r{ \t\n\r\"a\" \t\n\r: \t\n\r[ 1 , 2 ] \t\n\r} \t\n\r";
    assert_eq!(check(spaced), Ok(None));
    assert_eq!(
        parse_canonical(spaced),
        Err(JsonError::NotCanonical { offset: 0 })
    );
    for space in [
        "\u{c}", "\u{b}", "\u{a0}", "\u{2028}", "\u{3000}", "\u{feff}",
    ] {
        let document = format!("{{{space}\"a\":1}}");
        let (checked, canonical) = read(document.as_bytes());
        assert_eq!(checked, Err(JsonError::Syntax { offset: 1 }), "{space:?}");
        assert_eq!(canonical, Err(JsonError::Syntax { offset: 1 }), "{space:?}");
    }
}

#[test]
fn a_byte_order_mark_is_a_syntax_error() {
    let (checked, canonical) = read(b"\xef\xbb\xbf{\"a\":1}");
    assert_eq!(checked, Err(JsonError::Syntax { offset: 0 }));
    assert_eq!(canonical, Err(JsonError::Syntax { offset: 0 }));
}

#[test]
fn refuses_malformed_documents() {
    for document in [
        "",
        " ",
        "{",
        "}",
        "[1,]",
        "[,1]",
        r#"{"a":1,}"#,
        r#"{"a" 1}"#,
        r#"{"a":1 "b":2}"#,
        r#"{a:1}"#,
        "{'a':1}",
        r#"{"a":1}x"#,
        r#"{"a":1}{}"#,
        "[1 2]",
        r#"["a"#,
        r#"["a\"]"#,
        "tru",
        "nul",
        "True",
        "NaN",
        "Infinity",
        "01",
        "-",
        "+1",
        ".5",
        "1.",
        "1.e3",
        "1e",
        "1e+",
        "0x10",
        "--1",
        "[1]//",
        r#"["\x"]"#,
        r#"["\u12"]"#,
        r#"["\u12g4"]"#,
        r#"["\U0041"]"#,
        "[\"tab\tinside\"]",
        "[\"line\nbreak\"]",
        "[\"nul\u{0}\"]",
    ] {
        let (checked, canonical) = read(document.as_bytes());
        assert!(
            matches!(checked, Err(JsonError::Syntax { .. })),
            "{document:?}: {checked:?}"
        );
        // Canonical JSON refuses them too; where white space comes first, for that.
        assert!(canonical.is_err(), "{document:?}");
    }
}

#[test]
fn reports_where_the_syntax_breaks() {
    for (document, offset) in [
        (&b"[1,]"[..], 3),
        (br#"{"a":1}x"#, 7),
        (br#"["\q"]"#, 2),
        (br#"{"a":tru}"#, 5),
    ] {
        let (checked, canonical) = read(document);
        assert_eq!(checked, Err(JsonError::Syntax { offset }));
        assert_eq!(canonical, Err(JsonError::Syntax { offset }));
    }
}

#[test]
fn refuses_text_that_is_not_utf8() {
    for (bytes, offset) in [
        (&b"[\"\xc0\xaf\"]"[..], 2),         // an overlong encoding of `/`
        (&b"[\"\xed\xa0\x80\"]"[..], 2),     // a surrogate encoded as UTF-8
        (&b"[\"\xf4\x90\x80\x80\"]"[..], 2), // beyond U+10FFFF
        (&b"[\"\xe4\xb8\"]"[..], 2),         // a truncated sequence
        (&b"[\"ok\"]\xff"[..], 6),
    ] {
        let (checked, canonical) = read(bytes);
        assert_eq!(checked, Err(JsonError::Utf8 { offset }), "{bytes:?}");
        assert_eq!(canonical, Err(JsonError::Utf8 { offset }), "{bytes:?}");
    }
}

#[test]
fn decodes_escapes() {
    let document = r#""\"\\\/\b\f\n\r\t\u0041\u00e9\u4E2D\ud83d\ude00\uD83D\uDE00x""#;
    assert_eq!(check(document.as_bytes()), Ok(None));
    let expected = "\"\\/\u{8}\u{c}\n\r\tAé中😀😀x";
    assert_eq!(Chars::at(document, 0).collect::<String>(), expected);
    // Characters compare as their UTF-8 bytes, as canonical JSON orders keys: U+FF61 comes before
    // U+1F600 there, after it in UTF-16.
    let pair = r#""\uff61" "\ud83d\ude00""#;
    assert_eq!(Chars::at(pair, 0).cmp(Chars::at(pair, 9)), Ordering::Less);
}

#[test]
fn refuses_lone_surrogates() {
    for document in [
        r#"["\ud800"]"#,
        r#"["\udc00"]"#,
        r#"["\ude00\ud83d"]"#,
        r#"["\ud83d\u0041"]"#,
        r#"["\ud83d\ud83d\ude00"]"#,
        r#"["\ud83dx"]"#,
        r#"["\ud83d"#,
        r#"{"\udfff":1}"#,
        // A raw character after an escaped high surrogate cannot complete it either.
        "[\"\\ud83d😀\"]",
    ] {
        let (checked, canonical) = read(document.as_bytes());
        assert!(
            matches!(checked, Err(JsonError::LoneSurrogate { .. })),
            "{document}: {checked:?}"
        );
        assert!(
            matches!(canonical, Err(JsonError::LoneSurrogate { .. })),
            "{document}: {canonical:?}"
        );
    }
}

#[test]
fn refuses_duplicate_keys_even_when_escaped() {
    for (document, offset) in [
        (r#"{"a":1,"a":1}"#, 7),
        (r#"{"a":1,"\u0061":2}"#, 7),
        (r#"{"\ud83d\ude00":1,"😀":2}"#, 18),
        (r#"[{"x":{"b":1,"b":{}}}]"#, 13),
        // Keys out of order are kept until the object ends: the first repeat in the document's
        // order is reported.
        (r#"{"b":1,"a":1,"b":2}"#, 13),
        (r#"{"b":0,"a":0,"c":0,"a":0,"b":0}"#, 19),
        (r#"{"c":0,"b":{"y":0,"x":0,"y":1},"a":0}"#, 24),
    ] {
        assert_eq!(
            check(document.as_bytes()),
            Err(JsonError::DuplicateKey { offset }),
            "{document}"
        );
        assert_eq!(
            reference::parse(document.as_bytes()).map(drop),
            Err(JsonError::DuplicateKey { offset }),
            "{document}"
        );
    }
    // Equal keys in different objects are fine, and so are keys out of order without a repeat.
    for document in [
        r#"{"a":{"a":1},"b":{"a":2}}"#,
        r#"{"c":1,"b":2,"a":3}"#,
        r#"{"b":{"b":1,"a":2},"a":{"b":1,"a":2}}"#,
    ] {
        assert_eq!(check(document.as_bytes()), Ok(None), "{document}");
    }
    // In canonical JSON a repeat comes right after its twin; other keys out of order are not
    // canonical.
    assert_eq!(
        parse_canonical(br#"{"a":1,"a":1}"#),
        Err(JsonError::DuplicateKey { offset: 7 })
    );
    assert_eq!(
        parse_canonical(br#"{"b":1,"a":1,"b":2}"#),
        Err(JsonError::NotCanonical { offset: 7 })
    );
}

/// Finding a repeat among keys out of order reads each key about once, however long: a document of
/// 1 MiB (a head record's cap) whose keys come out of order, half of it one long key, is checked
/// going through its keys' bytes about twice (each key is compared with the one before it as the
/// object is read). Sorting the keys by their text would compare the key a sort first partitions
/// around with every other one: a long key there costs its length once per key, about 23 GB for
/// this document and hours for an intent's 64 MiB. The sort is replayed to find that place. The
/// work is counted (the bytes of strings gone through), not timed.
#[test]
fn a_long_key_among_keys_out_of_order_is_read_about_once() {
    const LEN: usize = 1024 * 1024;
    // `"0012345":0,` is 12 bytes: half the document is short keys, the other half the long one.
    let count = LEN / 2 / 12;
    // Distinct seven-digit keys, scrambled: 7,919 is prime and does not divide `count`.
    assert_ne!(count % 7_919, 0);
    let keys: Vec<String> = (0..count)
        .map(|n| format!("{:07}", n * 7_919 % count))
        .collect();
    // The object's keys in document order, `format_version` first, as a sort of their text sees
    // them, and how often such a sort compares each.
    let mut names = vec!["format_version"];
    names.extend(keys.iter().map(String::as_str));
    let compared = std::cell::RefCell::new(vec![0_usize; names.len()]);
    let mut order: Vec<usize> = (0..names.len()).collect();
    order.sort_unstable_by(|&a, &b| {
        let mut compared = compared.borrow_mut();
        compared[a] += 1;
        compared[b] += 1;
        names[a].cmp(names[b])
    });
    let compared = compared.into_inner();
    let most = (1..names.len()).max_by_key(|&i| compared[i]).unwrap();
    let least = (1..names.len()).min_by_key(|&i| compared[i]).unwrap();
    // The key at `long` grows by half the document of `~`, which sorts after every digit, so the
    // keys keep their order and a sort compares the same pairs.
    let document = |long: usize| {
        let mut text = String::from(r#"{"format_version":2"#);
        for (i, key) in keys.iter().enumerate() {
            text.push_str(",\"");
            text.push_str(key);
            if i + 1 == long {
                text.push_str(&"~".repeat(LEN / 2));
            }
            text.push_str("\":0");
        }
        text.push('}');
        text.into_bytes()
    };
    for (long, sorted) in [(most, compared[most]), (least, compared[least])] {
        let document = document(long);
        assert!(document.len() <= LEN + 64, "{} bytes", document.len());
        let (checked, gone_through) = scanned::during(|| check(&document));
        assert_eq!(checked, Ok(Some("2")));
        assert!(
            gone_through <= 3 * document.len(),
            "{gone_through} bytes of strings gone through in a document of {}, its long key where \
             a sort compares it {sorted} times",
            document.len()
        );
    }
}

#[test]
fn limits_nesting_to_sixteen_levels() {
    let arrays = |levels: usize| format!("{}{}", "[".repeat(levels), "]".repeat(levels));
    for document in [nested(16), arrays(16)] {
        let (checked, canonical) = read(document.as_bytes());
        assert_eq!(checked, Ok(None));
        assert_eq!(canonical.unwrap().encode(), document.as_bytes());
    }
    // Objects and arrays count alike.
    let mixed = format!("{}[]{}", r#"{"a":["#.repeat(8), "]}".repeat(8));
    // A deep document fails at the 17th level, long before it ends.
    let deep = "[".repeat(1_000_000);
    for (document, offset) in [(nested(17), 80), (arrays(17), 16), (mixed, 48), (deep, 16)] {
        let (checked, canonical) = read(document.as_bytes());
        assert_eq!(checked, Err(JsonError::Depth { offset }));
        assert_eq!(canonical, Err(JsonError::Depth { offset }));
    }
}

#[test]
fn values_have_no_null_and_only_safe_integers() {
    assert_eq!(parse_canonical(br#"{"a":null}"#), Err(JsonError::Null));
    assert_eq!(
        parse_canonical(br#"{"a":[{"b":null}]}"#),
        Err(JsonError::Null)
    );
    for number in [
        "-1",
        "-0",
        "1.0",
        "1e3",
        "1E3",
        "9007199254740992",
        "18446744073709551616",
    ] {
        let document = format!(r#"{{"a":{number}}}"#);
        assert_eq!(
            parse_canonical(document.as_bytes()),
            Err(JsonError::Number),
            "{number}"
        );
        assert_eq!(check(document.as_bytes()), Ok(None), "{number}");
    }
    assert_eq!(
        parse_canonical(br#"{"a":9007199254740991,"b":0}"#),
        Ok(object(&[("a", Value::Int(Int::MAX)), ("b", int(0))]))
    );
}

#[test]
fn integers_are_checked() {
    assert_eq!(Int::new(Int::MAX.get()), Some(Int::MAX));
    assert_eq!(Int::new(Int::MAX.get() + 1), None);
    assert_eq!(Int::MAX.get(), 9_007_199_254_740_991);
    assert_eq!(Int::from(u32::MAX).get(), 4_294_967_295);
    assert_eq!(Int::MAX.to_string(), "9007199254740991");
    for text in ["", "+1", "01", "1 ", "1_0", "١"] {
        assert_eq!(Int::parse(text), None, "{text:?}");
    }
}

#[test]
fn encodes_canonically() {
    let value = object(&[
        (
            "z",
            Value::Array(vec![int(1), int(0), Value::Int(Int::MAX)]),
        ),
        ("a", Value::from("tab\tquote\"")),
        ("B", object(&[("y", false.into()), ("x", true.into())])),
        ("e", Value::Array(Vec::new())),
        ("o", Value::Object(BTreeMap::new())),
    ]);
    assert_eq!(
        String::from_utf8(value.encode()).unwrap(),
        r#"{"B":{"x":true,"y":false},"a":"tab\tquote\"","e":[],"o":{},"z":[1,0,9007199254740991]}"#
    );
}

#[test]
fn escapes_exactly_the_characters_rule_5_names() {
    let mut text = String::new();
    let mut expected = String::from("\"");
    for code in 0..0x20u32 {
        let ch = char::from_u32(code).unwrap();
        text.push(ch);
        expected.push_str(&match ch {
            '\u{8}' => r"\b".to_owned(),
            '\t' => r"\t".to_owned(),
            '\n' => r"\n".to_owned(),
            '\u{c}' => r"\f".to_owned(),
            '\r' => r"\r".to_owned(),
            _ => format!(r"\u{code:04x}"),
        });
    }
    let raw = "\"\\/\u{7f}\u{80}\u{9f}\u{2028}\u{2029}é中😀\u{feff}";
    text.push_str(raw);
    expected.push_str("\\\"\\\\/\u{7f}\u{80}\u{9f}\u{2028}\u{2029}é中😀\u{feff}\"");
    assert_eq!(
        String::from_utf8(Value::String(text.clone()).encode()).unwrap(),
        expected
    );
    // And the canonical reader takes exactly these escapes back.
    assert_eq!(
        parse_canonical(expected.as_bytes()),
        Ok(Value::String(text))
    );
}

#[test]
fn sorts_keys_by_utf8_bytes_not_utf16_units() {
    // U+FF61 is ef bd a1 in UTF-8, before f0 9f 98 80 for 😀; in UTF-16 it comes after d83d.
    let value = object(&[
        ("😀", int(1)),
        ("\u{ff61}", int(2)),
        ("é", int(3)),
        ("z", int(4)),
        ("Z", int(5)),
    ]);
    let encoded = "{\"Z\":5,\"z\":4,\"é\":3,\"\u{ff61}\":2,\"😀\":1}";
    assert_eq!(String::from_utf8(value.encode()).unwrap(), encoded);
    assert_eq!(parse_canonical(encoded.as_bytes()), Ok(value));
    // Keys that canonical JSON escapes sort as the characters they stand for: `"` before `#`,
    // though `\"` starts with a backslash.
    let escaped = object(&[("#", int(1)), ("\"", int(2)), ("\u{1}", int(3))]);
    let encoded = r##"{"\u0001":3,"\"":2,"#":1}"##;
    assert_eq!(String::from_utf8(escaped.encode()).unwrap(), encoded);
    assert_eq!(parse_canonical(encoded.as_bytes()), Ok(escaped));
    assert_eq!(
        parse_canonical(br##"{"#":1,"\"":2}"##),
        Err(JsonError::NotCanonical { offset: 7 })
    );
}

#[test]
#[should_panic(expected = "no canonical encoding")]
fn a_value_nested_too_deeply_cannot_be_encoded() {
    let mut value = Value::Array(Vec::new());
    for _ in 0..16 {
        value = Value::Array(vec![value]);
    }
    let _ = value.encode();
}

#[test]
fn encodes_sixteen_levels() {
    let mut value = Value::Object(BTreeMap::new());
    for _ in 1..16 {
        value = object(&[("a", value)]);
    }
    assert_eq!(value.encode(), nested(16).into_bytes());
}

#[test]
fn accepts_only_canonical_documents() {
    for document in [
        r#"{"a":[true,false,"x"],"b":1,"c":{"y":0,"z":""}}"#,
        r#"{"B":1,"_":2,"a":3,"é":4}"#,
        r#"{"a":{},"b":[]}"#,
        r#"{"s":"\"\\\b\f\n\r\t\u0000\u001f/ "}"#,
        "[]",
        "0",
        "true",
        r#""text""#,
    ] {
        let value = parse_canonical(document.as_bytes()).unwrap();
        assert_eq!(value.encode(), document.as_bytes(), "{document}");
    }
    // The offset is the first byte, front to back, that the canonical encoding would not have
    // there: for an escape, the first byte that differs from the escape rule 5 writes, if any.
    for (document, offset) in [
        (r#"{"a": 1}"#, 5),
        (r#"{"b":1,"a":2}"#, 7),
        (r#"{"a":"\/"}"#, 6),
        (r#"{"a":"\u001F"}"#, 11),
        (r#"{"a":"\u0041"}"#, 6),
        (r#"{"a":"\u7ebf"}"#, 6),
        (r#"{"a":"\u000a"}"#, 7),
        (r#"{"a":"\u0022"}"#, 7),
        (r#"{"a":"\u005c"}"#, 7),
        (r#"{"a":"\u007f"}"#, 6),
        (r#"{"a":"\ud83d\ude00"}"#, 6),
        ("{\"a\":1}\n", 7),
        (" {}", 0),
        ("[1, 2]", 3),
    ] {
        assert_eq!(
            parse_canonical(document.as_bytes()),
            Err(JsonError::NotCanonical { offset }),
            "{document:?}"
        );
        // Every one is JSON.
        assert_eq!(check(document.as_bytes()), Ok(None), "{document:?}");
    }
}

#[test]
fn values_have_accessors() {
    let value = parse_canonical(br#"{"a":[1],"b":"x","c":true,"d":2}"#).unwrap();
    let members = value.as_object().unwrap();
    assert_eq!(members["a"].as_array(), Some(&[int(1)][..]));
    assert_eq!(members["b"].as_str(), Some("x"));
    assert_eq!(members["c"].as_bool(), Some(true));
    assert_eq!(members["d"].as_int(), Int::new(2));
    assert_eq!(members["b"].as_int(), None);
    assert_eq!(members["a"].as_object(), None);
    assert_eq!(members["d"].as_str(), None);
    assert_eq!(members["c"].as_array(), None);
    assert_eq!(members["a"].as_bool(), None);
    assert_eq!(Value::from(String::from("s")), Value::from("s"));
    assert_eq!(Value::from(Int::MAX), Value::Int(Int::MAX));
    assert_eq!(Value::from(vec![int(1)]), Value::Array(vec![int(1)]));
    assert_eq!(Value::from(BTreeMap::new()), Value::Object(BTreeMap::new()));
}

#[test]
fn nodes_read_values_where_they_lie() {
    let document =
        br#"{"a":[1,"x\ty",[],{}],"b":{"c":false,"d":9007199254740991},"e":"","f\"":true}"#;
    let root = canonical(document).unwrap().as_object().unwrap();
    let keys: Vec<_> = root.members().map(|(key, _)| key.into_owned()).collect();
    assert_eq!(keys, ["a", "b", "e", "f\""]);
    let a: Vec<_> = root.get("a").unwrap().as_array().unwrap().collect();
    assert_eq!(a.len(), 4);
    assert_eq!(a[0].as_int(), Int::new(1));
    assert_eq!(a[1].as_str().as_deref(), Some("x\ty"));
    assert_eq!(a[2].as_array().unwrap().count(), 0);
    assert_eq!(a[3].as_object().unwrap().members().count(), 0);
    let b = root.get("b").unwrap().as_object().unwrap();
    assert_eq!(b.get("c").unwrap().as_bool(), Some(false));
    assert_eq!(b.get("d").unwrap().as_int(), Some(Int::MAX));
    assert!(b.get("a").is_none() && b.get("cc").is_none() && b.get("z").is_none());
    assert_eq!(root.get("e").unwrap().as_str().as_deref(), Some(""));
    assert_eq!(root.get("f\"").unwrap().as_bool(), Some(true));
    // A string without escapes is borrowed from the document.
    assert!(matches!(
        root.get("e").unwrap().as_str(),
        Some(Cow::Borrowed(""))
    ));
    assert!(matches!(a[1].as_str(), Some(Cow::Owned(_))));
    // Each accessor takes only its own kind.
    let x = a[1];
    assert!(x.as_int().is_none() && x.as_bool().is_none());
    assert!(x.as_array().is_none() && x.as_object().is_none());
    assert!(a[0].as_str().is_none() && b.get("c").unwrap().as_int().is_none());
    assert_eq!(
        canonical(document).unwrap().to_value(),
        parse_canonical(document).unwrap()
    );
}

fn values() -> impl Strategy<Value = Value> {
    let leaf = prop_oneof![
        any::<bool>().prop_map(Value::Bool),
        prop_oneof![Just(0), Just(Int::MAX.get()), 0..=Int::MAX.get()]
            .prop_map(|n| Value::Int(Int::new(n).unwrap())),
        any::<String>().prop_map(Value::String),
    ];
    // At most 8 levels of containers inside the leaves: canonical documents may nest 16.
    leaf.prop_recursive(8, 64, 6, |inner| {
        prop_oneof![
            prop::collection::vec(inner.clone(), 0..6).prop_map(Value::Array),
            prop::collection::btree_map(any::<String>(), inner, 0..6).prop_map(Value::Object),
        ]
    })
}

/// Text made of JSON's own tokens, so random documents get past the first byte.
fn json_like() -> impl Strategy<Value = Vec<u8>> {
    let tokens: Vec<&'static [u8]> = vec![
        b"{",
        b"}",
        b"[",
        b"]",
        b",",
        b":",
        b"\"",
        b"\\",
        b"\\u",
        b"d83d",
        b"de00",
        b"00",
        b"\"a\"",
        b"\"a\":",
        b"0",
        b"1",
        b"-",
        b".",
        b"e",
        b"+",
        b"true",
        b"null",
        b" ",
        b"\n",
        b"\xe4\xb8\xad",
        b"\xe4",
        b"\xef\xbb\xbf",
        b"\x00",
    ];
    prop::collection::vec(prop::sample::select(tokens), 0..48).prop_map(|tokens| tokens.concat())
}

/// JSON documents written every way RFC 8259 allows and some it does not: white space, keys in
/// any order and repeated under other spellings, escapes of every kind, `null`, numbers of every
/// form, and a `format_version` member here and there.
fn noisy_json() -> impl Strategy<Value = Vec<u8>> {
    let space = prop::sample::select(vec!["", "", "", " ", "\n", "\t ", "\r\n"]);
    let strings = prop::sample::select(vec![
        r#""a""#,
        r#""\u0061""#,
        r#""b""#,
        r#""format_version""#,
        r#""format\u005fversion""#,
        r#""""#,
        r#""\"""#,
        r#""\u0022""#,
        r#""\\""#,
        r#""\/""#,
        r#""/""#,
        r#""\b\f\n\r\t""#,
        r#""\u0008""#,
        r#""\u001f""#,
        r#""\u001F""#,
        r#""\u00e9""#,
        r#""é""#,
        r#""\ud83d\ude00""#,
        r#""😀""#,
        r#""\ud83d""#,
        "\"\u{7f}\"",
    ]);
    let leaf = prop_oneof![
        strings.clone().prop_map(str::to_owned),
        prop::sample::select(vec![
            "true",
            "false",
            "null",
            "0",
            "-0",
            "1",
            "2",
            "12",
            "1.5",
            "1e3",
            "-1E-2",
            "9007199254740991",
            "9007199254740992",
            "01",
        ])
        .prop_map(str::to_owned),
    ];
    let document = leaf.prop_recursive(5, 48, 5, move |inner| {
        let item = (space.clone(), inner, space.clone())
            .prop_map(|(before, value, after)| format!("{before}{value}{after}"));
        prop_oneof![
            prop::collection::vec(item.clone(), 0..5)
                .prop_map(|items| format!("[{}]", items.join(","))),
            prop::collection::vec((strings.clone(), space.clone(), item), 0..5).prop_map(
                |members| {
                    let members: Vec<String> = members
                        .into_iter()
                        .map(|(key, space, value)| format!("{key}{space}:{value}"))
                        .collect();
                    format!("{{{}}}", members.join(","))
                }
            ),
        ]
    });
    document.prop_map(String::into_bytes)
}

/// Bytes for the readers: token soup, noisy documents, and canonical documents one change away.
fn documents() -> impl Strategy<Value = Vec<u8>> {
    prop_oneof![
        json_like(),
        noisy_json(),
        noisy_json().prop_flat_map(strategies::mutated),
        values().prop_flat_map(|value| strategies::mutated(value.encode())),
    ]
}

proptest! {
    #[test]
    fn encoding_then_parsing_returns_the_value(value in values()) {
        let encoded = value.encode();
        prop_assert_eq!(parse_canonical(&encoded), Ok(value.clone()));
        // The general reader takes it too, and finds the same version as the reference.
        let stated = reference::parse(&encoded).map(|json| {
            reference::stated_number(&json).map(str::to_owned)
        });
        prop_assert_eq!(check(&encoded).map(|found| found.map(str::to_owned)), stated);
    }

    /// serde_json, which writes no other escapes than rule 5's, writes strings the same way.
    #[test]
    fn strings_are_written_like_serde_json_writes_them(text in any::<String>()) {
        let ours = Value::String(text.clone()).encode();
        prop_assert_eq!(ours, serde_json::to_vec(&text).unwrap());
    }

    #[test]
    fn parsing_never_panics_on_bytes(bytes in prop::collection::vec(any::<u8>(), 0..512)) {
        let _ = check(&bytes);
        let _ = parse_canonical(&bytes);
    }

    /// Both readers accept and refuse exactly what the reader this module had before did, and
    /// read the same version and value; a document [`check`] accepts, serde_json reads too, unless
    /// a number is beyond the range of a float (RFC 8259 allows any).
    #[test]
    fn the_readers_agree_with_the_reference(bytes in documents()) {
        let model = reference::parse(&bytes);
        let stated = model.as_ref().map(|json| reference::stated_number(json));
        prop_assert_eq!(
            check(&bytes).map_err(drop),
            stated.map_err(drop),
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        prop_assert_eq!(
            parse_canonical(&bytes).map_err(drop),
            reference::parse_canonical(&bytes).map_err(drop),
            "{}",
            String::from_utf8_lossy(&bytes)
        );
        let theirs = serde_json::from_slice::<serde_json::Value>(&bytes);
        if let (Ok(_), Err(error)) = (check(&bytes), theirs) {
            prop_assert!(error.to_string().contains("number out of range"), "{}", error);
        }
        if let Ok(value) = parse_canonical(&bytes) {
            prop_assert_eq!(value.encode(), bytes);
        }
    }

    /// [`check`] reports the reference's problem, but for a key repeated in an object whose keys
    /// came out of order: that waits for the object's end, so a problem met before then comes
    /// first.
    #[test]
    fn check_reports_what_the_reference_reports(bytes in documents()) {
        let text = String::from_utf8_lossy(&bytes);
        match (check(&bytes), reference::parse(&bytes)) {
            (Ok(_), Ok(_)) => {}
            (Err(error), Err(JsonError::DuplicateKey { offset })) => {
                prop_assert!(offset_of(error) >= offset, "{:?} before {} in {}", error, offset, text);
            }
            (ours, theirs) => prop_assert_eq!(ours.map(drop), theirs.map(drop), "{}", text),
        }
    }
}

/// Where a problem of plain JSON is; [`check`] reports no other.
fn offset_of(error: JsonError) -> usize {
    match error {
        JsonError::Utf8 { offset }
        | JsonError::Syntax { offset }
        | JsonError::Depth { offset }
        | JsonError::DuplicateKey { offset }
        | JsonError::LoneSurrogate { offset } => offset,
        other => panic!("check reported {other:?}"),
    }
}
