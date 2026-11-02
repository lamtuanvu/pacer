#![allow(clippy::unwrap_used)]
use pacer_read_model::{events::parse_cursor, js::stringify};
use serde_json::json;
#[test]
fn js_cursor_numbers_and_wire_numbers() {
    for s in [
        "",
        "  \u{feff}0\u{a0}",
        "0x10",
        "1e2",
        "9007199254740991",
        "-0",
    ] {
        assert!(parse_cursor(Some(s), Some("-1")).is_ok(), "{s:?}");
    }
    for s in ["9007199254740992", "1.2", "NaN", "-1", "\u{85}0"] {
        assert!(parse_cursor(Some(s), None).is_err(), "{s:?}");
    }
    assert_eq!(
        stringify(&json!([
            1.0,
            -0.0,
            1e-7,
            1e-6,
            1e20,
            1e21,
            9007199254740993u64
        ])),
        "[1,0,1e-7,0.000001,100000000000000000000,1e+21,9007199254740992]"
    );
}

#[test]
fn utf16_documents_and_numeric_property_order_have_no_sentinel_collision() {
    let mut doc = pacer_read_model::wire::Document::new(
        json!({"text":"placeholder","nested":{"text":"ordinary"}}),
    );
    doc.substring("/text".into(), "a😀", 2);
    assert_eq!(
        doc.json(),
        "{\"text\":\"a\\ud83d\",\"nested\":{\"text\":\"ordinary\"}}"
    );
    assert_eq!(doc.at("/text").json(), "\"a\\ud83d\"");
    assert_eq!(doc.at("/nested/text").json(), "\"ordinary\"");
    let ordered: serde_json::Value =
        serde_json::from_str(r#"{"b":1,"10":1,"2":1,"01":1,"a":1}"#).unwrap();
    assert_eq!(stringify(&ordered), r#"{"2":1,"10":1,"b":1,"01":1,"a":1}"#);
    assert_eq!(
        pacer_read_model::js::trim("\u{feff}\u{a0}text\u{3000}"),
        "text"
    );
    assert_eq!(
        pacer_read_model::js::trim("\u{85}text\u{85}"),
        "\u{85}text\u{85}"
    );
}
