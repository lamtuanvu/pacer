#![allow(clippy::unwrap_used)]
use pacer_plugin_wire::{Utf16String, WireReply};
use serde_json::json;
#[test]
fn slice_keeps_lone_surrogates_in_json_instead_of_replacing_them() {
    let head = Utf16String::slice("a😀b", 0, 2);
    assert_eq!(head.units(), &[97, 0xd83d]);
    assert_eq!(serde_json::to_string(&head).unwrap(), r#""a\ud83d""#);
    let tail = Utf16String::slice("a😀b", 2, usize::MAX);
    assert_eq!(tail.units(), &[0xde00, 98]);
    assert_eq!(serde_json::to_string(&tail).unwrap(), r#""\ude00b""#);
    let mut reply = WireReply::new(json!({"body":"placeholder","n":2}));
    reply.replace("/body", head);
    assert_eq!(reply.to_json().unwrap(), r#"{"body":"a\ud83d","n":2}"#);
    assert!(reply.into_value().is_err());
}
#[test]
fn scalar_and_control_strings_round_trip_and_user_text_is_not_a_marker() {
    for text in ["😀", "\u{feff}\0\n\"\\", "\\ud83d", "\u{e000}"] {
        let value = Utf16String::slice(text, 0, usize::MAX);
        assert_eq!(
            serde_json::from_str::<String>(&serde_json::to_string(&value).unwrap()).unwrap(),
            text
        );
    }
}
