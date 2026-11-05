//! `number_at` and `normalize_js_numbers` (additive, §4.7). A separate target:
//! it does not compile until both methods exist.
#![allow(clippy::unwrap_used)]
use pacer_js_json::WireReply;

#[test]
fn number_at_reports_finite_numbers_and_signed_overflow() {
    let reply = WireReply::parse(
        r#"{"a":1,"b":1e400,"c":-1e400,"d":"1","e":null,"f":2.5,"g":[3],"h":{"x":-0}}"#,
    )
    .unwrap();
    assert_eq!(reply.number_at("/a"), Some(1.0));
    assert_eq!(reply.number_at("/b"), Some(f64::INFINITY));
    assert_eq!(reply.number_at("/c"), Some(f64::NEG_INFINITY));
    assert_eq!(reply.number_at("/d"), None);
    assert_eq!(reply.number_at("/e"), None);
    assert_eq!(reply.number_at("/f"), Some(2.5));
    assert_eq!(reply.number_at("/g/0"), Some(3.0));
    assert_eq!(reply.number_at("/g/00"), None);
    assert!(reply.number_at("/h/x").unwrap().is_sign_negative());
    assert_eq!(reply.number_at("/missing"), None);
}

#[test]
fn normalize_js_numbers_keeps_the_base_import_rule() {
    // Base `import_numbers` (store/src/task.rs): zero becomes integer 0, any
    // other finite number becomes json!(f64); Overflow stays serialized null.
    let mut reply = WireReply::parse(
        r#"{"a":-0,"b":1,"c":1.5,"d":[0,2,{"e":-0.0}],"f":18446744073709551615,"g":1e400,"s":"\ud800"}"#,
    )
    .unwrap();
    reply.normalize_js_numbers();
    assert_eq!(
        reply.to_json().unwrap(),
        r#"{"a":0,"b":1.0,"c":1.5,"d":[0,2.0,{"e":0}],"f":1.8446744073709552e+19,"g":null,"s":"\ud800"}"#
    );
    assert_eq!(reply.number_at("/g"), Some(f64::INFINITY));
}
