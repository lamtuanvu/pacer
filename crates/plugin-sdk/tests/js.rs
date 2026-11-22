//! Integration tests for the public ECMAScript-semantics helpers in `pacer_plugin::js`,
//! matching `@pacer/plugin`'s string/number/base64 behaviours.

#![allow(clippy::unwrap_used)]
use pacer_plugin::js::{
    base64, finite_number, number_string, safe_integer, slice_utf16, trim, utf16_len,
};
use serde_json::json;

#[test]
fn trim_matches_ecmascript_surface() {
    assert_eq!(trim(" \n\t  hello  \r\n "), "hello");
    assert_eq!(trim("\u{feff}x"), "x");
    assert_eq!(trim(""), "");
    // ZWSP is not UI-said whitespace in ECMAScript.
    assert_eq!(trim("\u{200b}a\u{200b}"), "\u{200b}a\u{200b}");
}

#[test]
fn utf16_length_counts_code_units_not_scalars() {
    assert_eq!(utf16_len("plain"), 5);
    assert_eq!(utf16_len("a\u{1f600}b"), 4); // surrogate pair counts as 2
    assert_eq!(utf16_len(""), 0);
}

#[test]
fn slice_utf16_handles_surrogates_and_ranges() {
    assert_eq!(slice_utf16("hello world", 6, None), "world");
    assert_eq!(slice_utf16("hello", 1, Some(3)), "el");
    // Splitting a surrogate pair yields U+FFFD (documented deviation).
    assert_eq!(slice_utf16("a\u{1f600}b", -2, None), "\u{fffd}b");
    assert_eq!(slice_utf16("abc", 5, None), "");
    assert_eq!(slice_utf16("abc", 2, Some(1)), "");
}

#[test]
fn number_string_matches_number_to_string() {
    assert_eq!(number_string(0.0), "0");
    assert_eq!(number_string(-0.0), "0");
    assert_eq!(number_string(1.0), "1");
    assert_eq!(number_string(1e21), "1e+21");
    assert_eq!(number_string(0.5), "0.5");
    assert_eq!(number_string(0.1 + 0.2), "0.30000000000000004");
    assert_eq!(number_string(42.0), "42");
}

#[test]
fn safe_integer_only_accepts_representable_integrals() {
    assert_eq!(safe_integer(&json!(7)), Some(7));
    assert_eq!(safe_integer(&json!(7.0)), Some(7));
    assert_eq!(
        safe_integer(&json!(9007199254740991u64)),
        Some(9007199254740991)
    );
    assert_eq!(safe_integer(&json!(9007199254740992u64)), None);
    assert_eq!(safe_integer(&json!(-9007199254740992i64)), None);
    assert_eq!(safe_integer(&json!(1.5)), None);
    assert_eq!(safe_integer(&json!("1")), None);
    assert_eq!(safe_integer(&json!(null)), None);
}

#[test]
fn finite_number_checks_number_and_range() {
    assert_eq!(finite_number(&json!(3.5)), Some(3.5));
    assert_eq!(finite_number(&json!("nope")), None);
    assert_eq!(finite_number(&json!(null)), None);
    // JSON cannot represent Infinity/NaN directly, so non-finite never appears.
    assert_eq!(finite_number(&json!(false)), None);
}

#[test]
fn base64_round_trip_and_lenient_forms() {
    let bytes = b"\x00\x01\x02binary\xffdata";
    let enc = base64::encode(bytes);
    assert_eq!(base64::decode(&enc).unwrap(), bytes);
    assert_eq!(base64::decode_lenient(&enc), bytes);
}

#[test]
fn base64_lenient_accepts_whitespace_and_missing_padding() {
    assert_eq!(base64::decode_lenient("eA"), vec![0x78]);
    assert_eq!(base64::decode_lenient("e A=="), vec![0x78]);
    assert_eq!(base64::decode_lenient(" eA\n== "), vec![0x78]);
    assert_eq!(base64::decode_lenient("aGVs bG8="), b"hello".to_vec());
}

#[test]
fn base64_strict_rejects_bad_length() {
    assert_eq!(base64::decode("eA"), None);
    assert_eq!(base64::decode("eA=="), Some(vec![0x78]));
    assert_eq!(base64::decode("!!!!"), None);
}
