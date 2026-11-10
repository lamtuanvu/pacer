#![allow(clippy::unwrap_used)]

use pacer_lifecycle::{AdmissionValue, parse_delegate_brief_json};

#[test]
fn decoding_and_serializing_strings_is_lossless() {
    for (source, expected) in [
        (r#""\ud800""#, r#""\ud800""#),
        (r#""\uDFFF""#, r#""\udfff""#),
        (r#""\ud800\udfff""#, "\"𐏿\""),
        (r#""\udfff\ud800""#, r#""\udfff\ud800""#),
        (r#""\\ud800""#, r#""\\ud800""#),
        (
            r#""\"\\\/\b\f\n\r\t\u0000""#,
            r#""\"\\/\u0008\u000c\u000a\u000d\u0009\u0000""#,
        ),
        (r#""a\ud800😀\udfffz""#, "\"a\\ud800😀\\udfffz\""),
        (
            r#"{"\ud800":1,"\ud800":2,"\\ud800":3}"#,
            r#"{"\\ud800":3,"\ud800":2}"#,
        ),
    ] {
        assert_eq!(
            AdmissionValue::parse(source).unwrap().to_json(),
            expected,
            "{source}"
        );
    }
    assert_eq!(
        parse_delegate_brief_json(r#"{"goal":"\ud800"}"#, "/tmp")
            .unwrap()
            .to_json(),
        r#"{"brief":{"goal":"\ud800","repo":"/tmp"},"input":{"difficultySource":"unspecified"}}"#,
    );
}

#[test]
fn lossless_decoder_still_rejects_invalid_json() {
    for source in [
        "01",
        "-01",
        "1.",
        "1e",
        "1e+",
        "-.1",
        "NaN",
        "Infinity",
        "+1",
        "\"",
        "\"\\",
        r#""\u""#,
        r#""\ud80""#,
        r#""\ud80g""#,
        r#""\x80""#,
        "\"\n\"",
        "\"\0\"",
        r#"{"goal":"\ud800",}"#,
        r#"["\ud800" true]"#,
        r#""\ud800" "extra""#,
        r#"{1:"value"}"#,
        r#"["\ud800""#,
    ] {
        assert!(AdmissionValue::parse(source).is_err(), "{source:?}");
    }
}

#[test]
fn json_numbers_follow_binary64_before_admission() {
    assert_eq!(
        AdmissionValue::parse("9007199254740993").unwrap().to_json(),
        "9007199254740992"
    );
    assert_eq!(AdmissionValue::parse("1e400").unwrap().to_json(), "null");
    assert_eq!(AdmissionValue::parse("-1e400").unwrap().to_json(), "null");
    assert_eq!(AdmissionValue::parse("1e-400").unwrap().to_json(), "0");
}
