//! Scanner and walk paths the acceptance rows do not reach: insignificant
//! whitespace, escape-equivalent duplicate keys, the indexed duplicate path
//! of larger objects, and number normalization inside withheld content.
#![allow(clippy::unwrap_used)]
mod support;
use pacer_js_json::WireReply;
use serde_json::json;
use support::*;

#[test]
fn insignificant_whitespace_renders_compact_like_serde() {
    let text = " \t\n{ \"a\" : [ 1 , \"\\ud800\" , { } , [ ] ] ,\r\n \"b\" : null } \n";
    let reply = WireReply::parse(text).unwrap();
    assert_eq!(
        reply.to_json().unwrap(),
        r#"{"a":[1,"\ud800",{},[]],"b":null}"#
    );
    assert_eq!(reply.preview(), &json!({"a":[1,"\u{fffd}",{},[]],"b":null}));
    assert_eq!(js_canonical(&reply.to_json().unwrap()), js_canonical(text));
}

#[test]
fn escape_equivalent_keys_are_duplicates() {
    let text = r#"{"a":1,"b":0,"\u0061":2,"\/":3,"/":4}"#;
    let reply = WireReply::parse(text).unwrap();
    assert_eq!(reply.to_json().unwrap(), r#"{"a":2,"b":0,"/":4}"#);
    assert_eq!(js_canonical(&reply.to_json().unwrap()), js_canonical(text));
}

#[test]
fn larger_objects_keep_the_last_value_at_the_first_position() {
    let mut text = String::from("{");
    for i in 0..12 {
        text.push_str(&format!(r#""k{i}":{i},"\ud800{i}":{i},"#));
    }
    text.push_str(r#""k3":"x","\ud8003":"y","k11":[1]}"#);
    let reply = WireReply::parse(&text).unwrap();
    let mut expected = String::from("{");
    for i in 0..12 {
        let (k, h) = match i {
            3 => (r#""x""#.to_owned(), r#""y""#.to_owned()),
            11 => ("[1]".to_owned(), "11".to_owned()),
            _ => (i.to_string(), i.to_string()),
        };
        if i > 0 {
            expected.push(',');
        }
        expected.push_str(&format!(r#""k{i}":{k},"\ud800{i}":{h}"#));
    }
    expected.push('}');
    assert_eq!(reply.to_json().unwrap(), expected);
    assert_eq!(js_canonical(&expected), js_canonical(&text));
    assert_eq!(reply.preview().as_object().unwrap().len(), 12);
}

#[test]
fn normalize_js_numbers_reaches_hidden_and_withheld_content() {
    let mut reply =
        WireReply::parse(&format!(r#"{{"\ud800":-0,"d":{}}}"#, arrays(140, "2"))).unwrap();
    reply.normalize_js_numbers();
    assert_eq!(
        reply.to_json().unwrap(),
        format!(r#"{{"\ud800":0,"d":{}}}"#, arrays(140, "2.0"))
    );
    assert!(reply.preview_omits());
}
