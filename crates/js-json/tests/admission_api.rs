//! Row 28 (F3): `admission_json_eq` (additive, §4.8) over wide objects with
//! descending numeric keys, interleaved duplicates and hidden keys. A separate
//! target: it does not compile until the method exists. Ignored by default and
//! not a CI timing gate; run explicitly and record the n against 4n timings.
#![allow(clippy::unwrap_used)]
use pacer_js_json::WireReply;
use std::fmt::Write;

fn wire(text: &str) -> WireReply {
    WireReply::parse(text).unwrap_or_else(|e| panic!("parse rejected {} bytes: {e}", text.len()))
}

/// The row 28 shape: per i (descending) a number, a hidden key and a duplicate
/// that replaces the number at its first position.
fn descending(n: usize) -> String {
    let mut out = String::from("{");
    for i in (0..n).rev() {
        write!(out, r#""{i}":{i},"\ud800{i}":"\udc00","{i}":"dup","#).unwrap();
    }
    out.push_str(r#""end":true}"#);
    out
}

/// The same members without duplicates, in reverse order. `edit` changes the
/// member at index `n / 2`: `key` its hidden key, `value` its hidden value.
fn ascending(n: usize, key: &str, value: &str) -> String {
    let mut out = String::from(r#"{"end":true"#);
    for i in 0..n {
        let (key, value) = if i == n / 2 {
            (key, value)
        } else {
            (r"\ud800", r"\udc00")
        };
        write!(out, r#","{key}{i}":"{value}","{i}":"dup""#).unwrap();
    }
    out.push('}');
    out
}

#[test]
#[ignore = "resource pin; run explicitly"]
fn row28_wide_object_admission_json_eq_stays_linear() {
    let mut elapsed = vec![];
    for n in [50_000, 200_000] {
        let base = wire(&descending(n));
        let same = wire(&descending(n));
        let reordered = wire(&ascending(n, r"\ud800", r"\udc00"));
        let other_key = wire(&ascending(n, r"\ud801", r"\udc00"));
        let other_value = wire(&ascending(n, r"\ud800", r"\udc01"));
        assert_eq!(
            base.preview(),
            other_key.preview(),
            "hidden keys are not in the preview"
        );
        let start = std::time::Instant::now();
        let results = [
            base.admission_json_eq(&same),
            base.admission_json_eq(&reordered),
            reordered.admission_json_eq(&base),
            base.admission_json_eq(&other_key),
            other_key.admission_json_eq(&base),
            base.admission_json_eq(&other_value),
        ];
        elapsed.push(start.elapsed());
        assert_eq!(results, [true, true, true, false, false, false], "n={n}");
        eprintln!(
            "row28 admission_json_eq n={n}: {:?}",
            elapsed.last().unwrap()
        );
    }
    assert!(
        elapsed[1] < elapsed[0] * 16,
        "4n took {:?} against n {:?}",
        elapsed[1],
        elapsed[0]
    );
}
