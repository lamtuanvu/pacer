//! Shared Q1/Q2 pairs and the existing queue no-op comparator (`drain.rs`).
#![allow(dead_code, clippy::unwrap_used)]
use pacer_js_json::WireReply;
use pacer_lifecycle::AdmissionValue;

/// The existing drain rule: render both exact queues with `WireReply::to_json`
/// and compare after `AdmissionValue::parse`.
pub fn old_equal(a: &str, b: &str) -> bool {
    let parse = |text: &str| {
        AdmissionValue::parse(&WireReply::parse(text).unwrap().to_json().unwrap()).unwrap()
    };
    parse(a) == parse(b)
}

/// The base WireReply parser rejects lone-surrogate keys, so the old drain
/// path never compared them; pin the admission comparator on the raw text.
pub fn admission_equal(a: &str, b: &str) -> bool {
    AdmissionValue::parse(a).unwrap() == AdmissionValue::parse(b).unwrap()
}

pub const NUMBER_PAIRS: &[(&str, &str, bool)] = &[
    ("1", "1.0", true),
    ("0", "-0", false),
    ("0", "0.0", true),
    ("-0", "-0.0", true),
    ("9007199254740992", "9007199254740993", true),
    ("9007199254740992", "9007199254740994", false),
    ("18446744073709551615", "18446744073709551616", true),
    ("18446744073709551615", "1.8446744073709552e19", true),
    ("-9223372036854775808", "-9223372036854775808.0", true),
    ("-9223372036854775808", "-9223372036854775809", true),
    ("1e-7", "0.0000001", true),
    ("5e-324", "4.9e-324", true),
    ("5e-324", "0", false),
    ("1e21", "1000000000000000000000", true),
    ("0.1", "0.10000000000000001", true),
    ("1", "\"1\"", false),
    ("null", "0", false),
    ("true", "1", false),
];

pub const STRUCTURE_PAIRS: &[(&str, &str, bool)] = &[
    (r#"{"a":1,"b":2}"#, r#"{"b":2,"a":1}"#, true),
    (
        r#"{"a":{"x":1,"y":[1,2]}}"#,
        r#"{"a":{"y":[1,2],"x":1.0}}"#,
        true,
    ),
    (r#"[[1,2]]"#, r#"[[2,1]]"#, false),
    (r#"[1,2]"#, r#"[1,2,null]"#, false),
    (r#"{"a":1}"#, r#"{"a":1,"b":null}"#, false),
    (r#""\ud800""#, "\"\u{fffd}\"", false),
    (r#"["\udc00"]"#, r#"["\udc00"]"#, true),
    (r#"{"a":1,"a":2}"#, r#"{"a":2}"#, true),
];

pub const KEY_PAIRS: &[(&str, &str, bool)] = &[
    (r#"{"\ud800":1}"#, "{\"\u{fffd}\":1}", false),
    (r#"{"\ud800":1}"#, r#"{"\ud800":1.0}"#, true),
    (r#"{"\ud800":1,"a":2}"#, r#"{"a":2,"\ud800":1}"#, true),
    (r#"{"\ud800":1}"#, r#"{"\ud801":1}"#, false),
];
