#![allow(clippy::unwrap_used)]
use pacer_plugin_wire::{Utf16String, WireReply};
use serde_json::json;
#[test]
fn parses_escaped_lone_surrogates_and_preserves_them_across_metadata_changes() {
    let raw = r#"{"question":{"text":"a\ud83d"},"items":["\ude00","😀"],"rev":1}"#;
    let mut next = WireReply::parse(raw).unwrap();
    next.put("/rev", WireReply::new(json!(2))).unwrap();
    assert_eq!(next.preview()["rev"], json!(2));
    assert!(next.to_json().unwrap().contains(r#""text":"a\ud83d""#));
    assert!(next.to_json().unwrap().contains(r#""\ude00""#));
    assert!(next.into_value().is_err());
    let mut value = WireReply::parse(raw).unwrap();
    value.replace("/question/text", Utf16String::slice("fixed", 0, 5));
    assert!(value.to_json().unwrap().contains(r#""text":"fixed""#));
}
#[test]
fn object_order_and_literal_escapes_survive_lossless_parsing() {
    let raw = r#"{"z":"\\ud800","a":"\ud800","nested":{"z":1,"a":2}}"#;
    let reply = WireReply::parse(raw).unwrap();
    assert_eq!(reply.to_json().unwrap(), raw);
}
