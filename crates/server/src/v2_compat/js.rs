//! JavaScript coercions used by the reference adapter (JSON inputs only).
use serde_json::{Map, Value, json};

pub(super) fn spread(value: &Value) -> Value {
    match value {
        Value::Object(_) => value.clone(),
        Value::Array(items) => Value::Object(
            items
                .iter()
                .enumerate()
                .map(|(i, v)| (i.to_string(), v.clone()))
                .collect(),
        ),
        // Object spread indexes UTF-16 code units, not Unicode scalar values.
        Value::String(s) => Value::Object(
            s.encode_utf16()
                .enumerate()
                .map(|(i, c)| (i.to_string(), json!(String::from_utf16_lossy(&[c]))))
                .collect(),
        ),
        _ => Value::Object(Map::new()),
    }
}

pub(super) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub(super) fn string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        Value::Array(a) => a
            .iter()
            .map(|v| {
                if v.is_null() || v.is_array() && v.as_array().is_some_and(Vec::is_empty) {
                    String::new()
                } else {
                    string(v)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => v.to_string(),
    }
}
fn trim(s: &str) -> &str {
    s.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' | '\u{205F}' | '\u{3000}' | '\u{FEFF}'))
}
pub(super) fn number(v: &Value) -> f64 {
    match v {
        Value::Null => 0.0,
        Value::Bool(b) => {
            if *b {
                1.0
            } else {
                0.0
            }
        }
        Value::Number(n) => n.as_f64().unwrap_or(f64::NAN),
        _ => {
            let text = string(v);
            let s = trim(&text);
            if s.is_empty() {
                return 0.0;
            }
            for (prefix, radix) in [
                ("0x", 16),
                ("0X", 16),
                ("0o", 8),
                ("0O", 8),
                ("0b", 2),
                ("0B", 2),
            ] {
                if let Some(digits) = s.strip_prefix(prefix) {
                    if digits.is_empty() {
                        return f64::NAN;
                    }
                    return radix_number(digits, radix);
                }
            }
            if matches!(s, "Infinity" | "+Infinity") {
                return f64::INFINITY;
            }
            if s == "-Infinity" {
                return f64::NEG_INFINITY;
            }
            if s.chars()
                .any(|c| !matches!(c, '0'..='9' | '.' | 'e' | 'E' | '+' | '-'))
            {
                return f64::NAN;
            }
            s.parse().unwrap_or(f64::NAN)
        }
    }
}
pub(super) fn numeric(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n >= i64::MIN as f64 && n < i64::MAX as f64 {
        json!(n as i64)
    } else {
        json!(n)
    }
}

// Match Bun/JavaScriptCore's parseIntOverflow, including its rounding order.
// https://github.com/WebKit/WebKit/blob/main/Source/JavaScriptCore/runtime/ParseInt.h
// RUST-7 requires the reference behavior rather than an ideal integer conversion.
fn radix_number(digits: &str, radix: u32) -> f64 {
    if digits.chars().any(|c| c.to_digit(radix).is_none()) {
        return f64::NAN;
    }
    let mut number = 0.0;
    let mut multiplier = 1.0_f64;
    for c in digits.chars().rev() {
        let digit = c.to_digit(radix).unwrap_or(0);
        if multiplier.is_infinite() {
            if digit != 0 {
                return f64::INFINITY;
            }
        } else {
            number += f64::from(digit) * multiplier;
        }
        multiplier *= f64::from(radix);
    }
    number
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn radix_matches_reference_rounding_order() {
        let n = number(&json!("0x9adffc28f123abcd"));
        let expected = number(&json!(11159915654421918000_u64));
        assert_eq!(n, expected, "{n:.0} != {expected:.0}");
    }
}
