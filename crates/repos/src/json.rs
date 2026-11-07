use serde_json::Value;

/// `JSON.stringify`: binary64 numbers, integer-index keys first, then other keys in
/// insertion order (including nested objects).
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

/// JavaScript truthiness of a parsed JSON value.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
