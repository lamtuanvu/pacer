#![allow(clippy::unwrap_used, clippy::expect_used)]
//! Compare JSON as UTF-16 tokens so JS lone surrogates remain distinguishable.
//! serde_json's normal String decoder correctly rejects those scalar-invalid
//! strings; the golden output intentionally includes JS slice results with them.
#[allow(dead_code)]
#[path = "../examples/decisions.rs"]
mod adapter;
use serde::Deserialize;
use serde_json::{Value, value::RawValue};
#[derive(Deserialize)]
struct Case {
    input: Value,
    expected: Box<RawValue>,
}
fn canonical(text: &str) -> Value {
    let mut chars = text.chars();
    let mut out = String::new();
    while let Some(c) = chars.next() {
        if c != '"' {
            out.push(c);
            continue;
        }
        out.push('"');
        loop {
            let c = chars.next().expect("terminated JSON string");
            if c == '"' {
                break;
            }
            let mut units = vec![];
            if c == '\\' {
                let escape = chars.next().expect("JSON escape");
                if escape == 'u' {
                    let digits: String = chars.by_ref().take(4).collect();
                    units.push(u16::from_str_radix(&digits, 16).expect("hex code unit"));
                } else {
                    let c = match escape {
                        '"' => '"',
                        '\\' => '\\',
                        '/' => '/',
                        'b' => '\u{8}',
                        'f' => '\u{c}',
                        'n' => '\n',
                        'r' => '\r',
                        't' => '\t',
                        _ => panic!("invalid JSON escape"),
                    };
                    units.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
                }
            } else {
                units.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
            }
            for unit in units {
                out.push_str(&format!("{unit:04x}"));
            }
        }
        out.push('"');
    }
    let mut value: Value = serde_json::from_str(&out).expect("canonical JSON");
    fn numbers(v: &mut Value) {
        match v {
            Value::Number(n) => *v = serde_json::json!(n.as_f64().expect("JS number")),
            Value::Array(values) => values.iter_mut().for_each(numbers),
            Value::Object(values) => values.values_mut().for_each(numbers),
            _ => (),
        }
    }
    numbers(&mut value);
    value
}
#[test]
fn current_typescript_goldens() {
    let cases: Vec<Case> =
        serde_json::from_str(include_str!("../../../test/fixtures/p6e/goldens.json"))
            .expect("golden fixture");
    assert!(cases.len() >= 414);
    for (index, case) in cases.iter().enumerate() {
        let actual = adapter::run(&case.input).expect("serialize decision");
        assert_eq!(
            canonical(&actual),
            canonical(case.expected.get()),
            "golden {index}: {}",
            case.input
        );
    }
}
#[test]
fn comparator_preserves_lone_surrogates_and_distinguishes_replacement_characters() {
    assert_eq!(
        canonical(r#"{"v":"\ud83d\ude00"}"#),
        canonical("{\"v\":\"😀\"}")
    );
    assert_ne!(canonical(r#"{"v":"\ud83d"}"#), canonical("{\"v\":\"�\"}"));
}
