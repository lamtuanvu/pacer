//! `JSON.stringify` over serde Values: binary64 number text, integer-index keys
//! first, then other keys in insertion order (including nested objects).
use serde_json::Value;
use std::fmt::Write;

/// ECMAScript decimal rendering (including exponent thresholds and negative zero).
pub fn number_string(n: f64) -> String {
    ryu_js::Buffer::new().format(n).to_owned()
}

/// `JSON.stringify` of a plain serde Value, whose strings are Unicode text.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write(value, &mut out, &|s| s.encode_utf16().collect(), &|_| None);
    out
}

/// A JSON string literal of UTF-16 units; lone surrogates are escaped.
pub(crate) fn quote(units: impl IntoIterator<Item = u16>, out: &mut String) {
    out.push('"');
    for c in char::decode_utf16(units) {
        match c {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok(c) if c < '\u{20}' => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            Ok(c) => out.push(c),
            Err(e) => {
                let _ = write!(out, "\\u{:04x}", e.unpaired_surrogate());
            }
        }
    }
    out.push('"');
}

/// `units` maps a stored string to its JavaScript code units; `special` may
/// replace a value's text before the generic rules apply.
pub(crate) fn write(
    value: &Value,
    out: &mut String,
    units: &dyn Fn(&str) -> Vec<u16>,
    special: &dyn Fn(&Value) -> Option<&'static str>,
) {
    if let Some(text) = special(value) {
        out.push_str(text);
        return;
    }
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => match n.as_f64().filter(|n| n.is_finite()) {
            Some(n) => out.push_str(ryu_js::Buffer::new().format(n)),
            None => out.push_str("null"),
        },
        Value::String(s) => quote(units(s), out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write(item, out, units, special);
            }
            out.push(']');
        }
        Value::Object(fields) => {
            let mut keys: Vec<_> = fields.keys().collect();
            keys.sort_by_key(|k| array_index(k).map_or((1, 0), |n| (0, n)));
            out.push('{');
            for (i, key) in keys.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                quote(units(key), out);
                out.push(':');
                write(&fields[key], out, units, special);
            }
            out.push('}');
        }
    }
}

/// A canonical array index (0 to 2^32 - 2) enumerates before string keys.
fn array_index(key: &str) -> Option<u32> {
    let n = key.parse::<u32>().ok()?;
    (n != u32::MAX && n.to_string() == key).then_some(n)
}
