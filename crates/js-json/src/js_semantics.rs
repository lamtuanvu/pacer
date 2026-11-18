use serde_json::Value;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// JSON numbers are JavaScript numbers at the TypeScript protocol boundary.
pub fn safe_u64(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&number))
        .then_some(number as u64)
}

pub fn safe_i64(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER)
        .then_some(number as i64)
}

pub fn finite_f64(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub fn codepoint_len(value: &str) -> usize {
    value.chars().count()
}

pub fn trim(value: &str) -> &str {
    value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

#[cfg(test)]
mod tests;

/// Persisted JSON is parsed as JavaScript Number by TS. serde_json retains an
/// integer/float representation distinction that must not revoke an owner.
pub fn json_equal(left: &Value, right: &Value) -> bool {
    match (left, right) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, a)| b.get(k).is_some_and(|b| json_equal(a, b)))
        }
        _ => left == right,
    }
}

/// The finite Number(text) contract used by fixed wrapper/SSH fact readers.
pub fn number_text(text: &str) -> Option<f64> {
    if trim(text).is_empty() {
        return None;
    }
    Some(string_to_number(text)).filter(|value| value.is_finite())
}

/// `Number(text)`: blank text is 0, `Infinity` and decimal overflow are infinite, and text
/// that is not a numeric literal is NaN.
pub fn string_to_number(text: &str) -> f64 {
    let text = trim(text);
    if text.is_empty() {
        return 0.0;
    }
    match text {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    if let Some((radix, digits)) = text
        .strip_prefix("0x")
        .or_else(|| text.strip_prefix("0X"))
        .map(|s| (16, s))
        .or_else(|| {
            text.strip_prefix("0b")
                .or_else(|| text.strip_prefix("0B"))
                .map(|s| (2, s))
        })
        .or_else(|| {
            text.strip_prefix("0o")
                .or_else(|| text.strip_prefix("0O"))
                .map(|s| (8, s))
        })
    {
        // Bun's JavaScriptCore Number parser accumulates overflowing radix
        // literals from the least significant digit. Preserve its intermediate
        // IEEE-754 rounding rather than rounding an arbitrary-precision integer
        // once: the two differ for adversarial literals beyond 53 bits.
        let digits: Option<Vec<_>> = digits.chars().map(|c| c.to_digit(radix)).collect();
        let Some(digits) = digits.filter(|digits| !digits.is_empty()) else {
            return f64::NAN;
        };
        let mut value = 0.0;
        let mut place = 1.0_f64;
        for digit in digits.into_iter().rev() {
            if place.is_infinite() {
                if digit != 0 {
                    return f64::INFINITY;
                }
            } else {
                value += f64::from(digit) * place;
            }
            place *= f64::from(radix);
        }
        return value;
    }
    // Rust's float grammar also reads `inf` and `nan`, which are not JavaScript literals.
    if !text
        .bytes()
        .all(|b| b.is_ascii_digit() || matches!(b, b'.' | b'e' | b'E' | b'+' | b'-'))
    {
        return f64::NAN;
    }
    text.parse::<f64>().unwrap_or(f64::NAN)
}

/// JavaScript truthiness of a parsed JSON value.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub fn json_option_equal(left: Option<&Value>, right: Option<&Value>) -> bool {
    match (left, right) {
        (None, None) => true,
        (Some(a), Some(b)) => json_equal(a, b),
        _ => false,
    }
}

/// JavaScript's non-Unicode /[^A-Za-z0-9._-]/g replaces each UTF-16 unit.
pub fn path_tag(value: &str) -> String {
    value
        .encode_utf16()
        .map(|unit| {
            u8::try_from(unit)
                .ok()
                .filter(|b| b.is_ascii_alphanumeric() || b"._-".contains(b))
                .map(char::from)
                .unwrap_or('_')
        })
        .collect()
}
