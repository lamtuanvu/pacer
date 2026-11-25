//! JS helper parity tests: the Rust ecma helpers reproduce `String`, `Number`
//! and `Buffer` semantics from `@pacer/plugin`. Each test name matches the
//! slice plan's requirement and the ECMAScript method it ports.

#![allow(clippy::unwrap_used)]
use pacer_plugin::js::{
    base64, finite_number, number_string, safe_integer, slice_utf16, trim, utf16_len,
};
use serde_json::json;

#[test]
fn trim_matches_ecmascript() {
    // ECMAScript WhiteSpace + LineTerminator, including U+FEFF.
    assert_eq!(trim("\u{feff} a \u{3000}\n"), "a");
    // U+200B (ZERO WIDTH SPACE) is not ECMAScript whitespace and stays.
    assert_eq!(trim("\u{200b}a"), "\u{200b}a");
}

#[test]
fn utf16_len_counts_code_units() {
    // "a😀" is 2 UTF-16 code units after 'a', so 3 in total.
    assert_eq!(utf16_len("a😀"), 3);
}

#[test]
fn slice_utf16_follows_string_prototype_slice() {
    assert_eq!(slice_utf16("hello", -3, None), "llo");
    assert_eq!(slice_utf16("hello", 0, Some(200)), "hello");
    // Documented deviation: a split surrogate pair becomes U+FFFD.
    assert_eq!(slice_utf16("a😀b", -2, None), "\u{fffd}b");
    assert_eq!(slice_utf16("abc", 2, Some(1)), "");
}

#[test]
fn number_string_matches_number_to_string() {
    assert_eq!(number_string(0.0), "0");
    assert_eq!(number_string(-0.0), "0");
    assert_eq!(number_string(1e21), "1e+21");
    assert_eq!(number_string(1.5e-7), "1.5e-7");
    assert_eq!(number_string(0.1 + 0.2), "0.30000000000000004");
    assert_eq!(
        number_string(123456789012345680000.0),
        "123456789012345680000"
    );
    assert_eq!(number_string(0.5), "0.5");
}

#[test]
fn safe_integer_accepts_integral_floats_only() {
    // JSON has no integer type; a `1.0` still yields `Some(1)`.
    assert_eq!(safe_integer(&json!(1.0)), Some(1));
    assert_eq!(
        safe_integer(&json!(9007199254740991u64)),
        Some(9007199254740991)
    );
    assert_eq!(safe_integer(&json!(9007199254740992u64)), None);
    assert_eq!(safe_integer(&json!(1.5)), None);
    assert_eq!(safe_integer(&json!("1")), None);
}

#[test]
fn base64_lenient_matches_buffer_from() {
    assert_eq!(base64::decode_lenient("eA"), vec![0x78]);
    assert_eq!(base64::decode_lenient("e A=="), vec![0x78]);
    assert_eq!(base64::decode_lenient("eA==="), vec![0x78]);
    // Strict canonical base64 still rejects `"eA"`.
    assert_eq!(base64::decode("eA"), None);
}

#[test]
fn finite_number_checks_type_and_range() {
    assert_eq!(finite_number(&json!(3.5)), Some(3.5));
    assert_eq!(finite_number(&json!("3.5")), None);
    assert_eq!(finite_number(&json!(null)), None);
    assert_eq!(finite_number(&json!(false)), None);
}
