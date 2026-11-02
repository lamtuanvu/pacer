use serde_json::{Number, Value};

/// JSON.parse represents every number as binary64, including integer lexemes.
/// Canonicalize integral values where serde_json can retain an integer exactly.
pub(crate) fn js_numbers(value: &Value) -> Value {
    match value {
        Value::Number(original) => {
            let Some(n) = original.as_f64().filter(|n| n.is_finite()) else {
                return value.clone();
            };
            if n == 0.0 && n.is_sign_negative() {
                Number::from_f64(n).map_or_else(|| value.clone(), Value::Number)
            } else if n.fract() == 0.0 && (0.0..18_446_744_073_709_551_616.0).contains(&n) {
                Value::Number(Number::from(n as u64))
            } else if n.fract() == 0.0 && (-9_223_372_036_854_775_808.0..0.0).contains(&n) {
                Value::Number(Number::from(n as i64))
            } else {
                Number::from_f64(n).map_or_else(|| value.clone(), Value::Number)
            }
        }
        Value::Array(items) => Value::Array(items.iter().map(js_numbers).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, item)| (key.clone(), js_numbers(item)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

/// ECMAScript WhiteSpace and LineTerminator, used by String.prototype.trim.
pub(crate) fn js_trim(s: &str) -> &str {
    s.trim_matches(|c| {
        matches!(
            c,
            '\u{0009}'..='\u{000D}'
                | '\u{0020}'
                | '\u{00A0}'
                | '\u{1680}'
                | '\u{2000}'..='\u{200A}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202F}'
                | '\u{205F}'
                | '\u{3000}'
                | '\u{FEFF}'
        )
    })
}

/// JSON.stringify for snapshots: binary64 numbers, integer-index keys first,
/// then other keys in insertion order (including nested objects).
pub(crate) fn stringify(value: &Value) -> Result<String, serde_json::Error> {
    fn index(key: &str) -> Option<u32> {
        let n = key.parse::<u32>().ok()?;
        (n != u32::MAX && n.to_string() == key).then_some(n)
    }
    fn write(value: &Value, out: &mut String) -> Result<(), serde_json::Error> {
        match value {
            Value::Number(n) => {
                let n = n.as_f64().unwrap_or(f64::NAN);
                if !n.is_finite() {
                    out.push_str("null");
                } else {
                    out.push_str(ryu_js::Buffer::new().format(n));
                }
            }
            Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(item, out)?;
                }
                out.push(']');
            }
            Value::Object(fields) => {
                let mut keys: Vec<_> = fields.keys().collect();
                keys.sort_by_key(|k| index(k).map_or((1, 0), |n| (0, n)));
                out.push('{');
                for (i, key) in keys.into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(key)?);
                    out.push(':');
                    write(&fields[key], out)?;
                }
                out.push('}');
            }
            _ => out.push_str(&serde_json::to_string(value)?),
        }
        Ok(())
    }
    let mut out = String::new();
    write(value, &mut out)?;
    Ok(out)
}
