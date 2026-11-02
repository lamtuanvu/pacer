//! Lossless JS JSON strings over serde_json's Unicode-scalar string type.
//!
//! JSON permits lone UTF-16 surrogates. Reserve F0000..F07FF for those units and
//! F0800 as an escape for genuine input scalars in that range. F0801/F0802
//! represent nonfinite numbers parsed only by this codec, without changing serde
//! features for the other transports. Encoded strings
//! stay private to the MCP boundary; backends use parse_json/stringify_json when
//! transporting values, or from_value for native Rust values. No scalar collides.
use serde_json::Value;
use std::io;
const FIRST: u32 = 0xf0000;
const ESCAPE: char = '\u{f0800}';
const POSITIVE_INFINITY: &str = "\u{f0801}";
const NEGATIVE_INFINITY: &str = "\u{f0802}";
const NUMBER_MARKER: char = '\u{f0803}';
const LAST_RESERVED: u32 = 0xf0803;

fn scalar(c: char, out: &mut String) {
    if (FIRST..=LAST_RESERVED).contains(&(c as u32)) {
        out.push(ESCAPE);
    }
    out.push(c);
}

/// Encode a native serde_json value for the lossless MCP/backend boundary.
pub fn from_value(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(from_string(&s)),
        Value::Array(a) => Value::Array(a.into_iter().map(from_value).collect()),
        Value::Object(o) => Value::Object(
            o.into_iter()
                .map(|(k, v)| (from_string(&k), from_value(v)))
                .collect(),
        ),
        Value::Number(n) => n
            .as_f64()
            .filter(|n| n.is_finite())
            .map_or(Value::Number(n), super::wire::number_value),
        v => v,
    }
}

pub(super) fn from_string(text: &str) -> String {
    let mut out = String::new();
    for c in text.chars() {
        scalar(c, &mut out);
    }
    out
}

pub(super) fn code_points(text: &str) -> usize {
    let mut chars = text.chars();
    let mut count = 0;
    while let Some(c) = chars.next() {
        if c == ESCAPE {
            chars.next();
        }
        count += 1;
    }
    count
}

/// JSON.parse-compatible input, including isolated UTF-16 surrogates. The returned
/// Value uses the documented lossless MCP string encoding; use stringify_json to
/// put it on a wire (ordinary serde serialization would expose sentinel scalars).
pub fn parse_json(text: &str) -> Result<Value, serde_json::Error> {
    let invalid = || {
        serde_json::Error::io(io::Error::new(
            io::ErrorKind::InvalidData,
            "invalid JSON string",
        ))
    };
    let mut converted = String::with_capacity(text.len());
    let mut numbers = Vec::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '-' || c.is_ascii_digit() {
            let mut token = c.to_string();
            while let Some(c) = chars
                .peek()
                .copied()
                .filter(|c| c.is_ascii_digit() || matches!(c, 'e' | 'E' | '+' | '-' | '.'))
            {
                token.push(c);
                chars.next();
            }
            if !valid_number(&token) {
                return Err(invalid());
            }
            let number = token.parse::<f64>().map_err(|_| invalid())?;
            // An array placeholder cannot turn an illegal numeric object key
            // into legal JSON. Genuine matching strings are escaped by scalar().
            converted.push_str(
                &Value::Array(vec![Value::String(format!(
                    "{NUMBER_MARKER}{}",
                    numbers.len()
                ))])
                .to_string(),
            );
            numbers.push(number);
            continue;
        }
        if c != '"' {
            converted.push(c);
            continue;
        }
        let mut units = Vec::new();
        loop {
            let c = chars.next().ok_or_else(invalid)?;
            if c == '"' {
                break;
            }
            if c == '\\' {
                let escaped = chars.next().ok_or_else(invalid)?;
                if escaped == 'u' {
                    let mut unit = 0u16;
                    for _ in 0..4 {
                        unit = unit * 16
                            + chars
                                .next()
                                .and_then(|c| c.to_digit(16))
                                .ok_or_else(invalid)? as u16;
                    }
                    units.push(unit);
                } else {
                    units.push(match escaped {
                        '"' => 34,
                        '\\' => 92,
                        '/' => 47,
                        'b' => 8,
                        'f' => 12,
                        'n' => 10,
                        'r' => 13,
                        't' => 9,
                        _ => return Err(invalid()),
                    });
                }
            } else {
                if c <= '\u{1f}' {
                    return Err(invalid());
                }
                let mut buf = [0u16; 2];
                units.extend_from_slice(c.encode_utf16(&mut buf));
            }
        }
        let mut encoded = String::new();
        for unit in char::decode_utf16(units) {
            match unit {
                Ok(c) => scalar(c, &mut encoded),
                Err(e) => {
                    if let Some(c) =
                        char::from_u32(FIRST + u32::from(e.unpaired_surrogate() - 0xd800))
                    {
                        encoded.push(c);
                    }
                }
            }
        }
        converted.push_str(&Value::String(encoded).to_string());
    }
    serde_json::from_str(&converted).map(|value| restore_numbers(value, &numbers))
}

fn restore_numbers(value: Value, numbers: &[f64]) -> Value {
    match value {
        Value::Array(items) => {
            if items.len() == 1
                && let Some(index) = items[0]
                    .as_str()
                    .and_then(|s| s.strip_prefix(NUMBER_MARKER))
                    .and_then(|s| s.parse::<usize>().ok())
                && let Some(number) = numbers.get(index).copied()
            {
                return if number.is_finite() {
                    super::wire::number_value(number)
                } else {
                    Value::String(
                        if number.is_sign_negative() {
                            NEGATIVE_INFINITY
                        } else {
                            POSITIVE_INFINITY
                        }
                        .into(),
                    )
                };
            }
            Value::Array(
                items
                    .into_iter()
                    .map(|v| restore_numbers(v, numbers))
                    .collect(),
            )
        }
        Value::Object(items) => Value::Object(
            items
                .into_iter()
                .map(|(k, v)| (k, restore_numbers(v, numbers)))
                .collect(),
        ),
        v => v,
    }
}

pub(super) fn nonfinite(value: &Value) -> Option<&'static str> {
    match value.as_str() {
        Some(POSITIVE_INFINITY) => Some("Infinity"),
        Some(NEGATIVE_INFINITY) => Some("-Infinity"),
        _ => None,
    }
}

/// Read a JavaScript number from a lossless boundary value (including infinities).
pub fn number(value: &Value) -> Option<f64> {
    match nonfinite(value) {
        Some("Infinity") => Some(f64::INFINITY),
        Some("-Infinity") => Some(f64::NEG_INFINITY),
        _ => value.as_f64(),
    }
}

fn valid_number(text: &str) -> bool {
    let bytes = text.as_bytes();
    let mut i = usize::from(bytes.first() == Some(&b'-'));
    match bytes.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => {
            i += 1;
            while bytes.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
        }
        _ => return false,
    }
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if start == i {
            return false;
        }
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if start == i {
            return false;
        }
    }
    i == bytes.len()
}

pub(super) fn quote(text: &str) -> String {
    let mut out = String::from("\"");
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c == ESCAPE {
            if let Some(c) = chars.next() {
                out.push(c);
            }
        } else if (FIRST..ESCAPE as u32).contains(&(c as u32)) {
            out.push_str(&format!("\\u{:04x}", 0xd800 + c as u32 - FIRST));
        } else {
            let quoted = Value::String(c.to_string()).to_string();
            out.push_str(&quoted[1..quoted.len() - 1]);
        }
    }
    out.push('"');
    out
}

pub(super) fn object_keys(object: &serde_json::Map<String, Value>) -> Vec<&String> {
    let mut keys: Vec<_> = object.keys().collect();
    keys.sort_by_key(|key| {
        key.parse::<u32>()
            .ok()
            .filter(|n| *n != u32::MAX && n.to_string() == **key)
            .map_or((1, 0), |n| (0, n))
    });
    keys
}
