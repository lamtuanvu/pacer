#![allow(clippy::unwrap_used)]

use pacer_config::settings::{js_trim, parse_pacing_order};
use serde_json::Value;

#[test]
fn shared_order_cases() {
    let cases: Vec<Value> = serde_json::from_str(include_str!(
        "../../../test/fixtures/config-settings/order.json"
    ))
    .unwrap();
    for case in cases {
        let expected: Option<Vec<String>> =
            serde_json::from_value(case["expected"].clone()).unwrap();
        assert_eq!(
            parse_pacing_order(case["input"].as_str().unwrap()),
            expected
        );
    }
}

#[test]
fn javascript_whitespace_set() {
    for c in [
        '\u{9}', '\u{a}', '\u{b}', '\u{c}', '\u{d}', ' ', '\u{a0}', '\u{1680}', '\u{2000}',
        '\u{2001}', '\u{2002}', '\u{2003}', '\u{2004}', '\u{2005}', '\u{2006}', '\u{2007}',
        '\u{2008}', '\u{2009}', '\u{200a}', '\u{2028}', '\u{2029}', '\u{202f}', '\u{205f}',
        '\u{3000}', '\u{feff}',
    ] {
        assert_eq!(js_trim(&format!("{c}x{c}")), "x");
    }
    assert_eq!(js_trim("\u{85}x\u{85}"), "\u{85}x\u{85}");
}
