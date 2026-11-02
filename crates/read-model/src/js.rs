//! ECMAScript wire primitives. JSON numbers always cross the binary64 boundary.
use serde_json::{Map, Value};
pub fn num(v: &Value) -> f64 {
    v.as_f64().unwrap_or(0.0)
}
pub fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
pub fn array(v: &Value) -> &[Value] {
    v.as_array().map_or(&[], Vec::as_slice)
}
pub fn values(v: &Value) -> Vec<&Value> {
    v.as_object()
        .map_or_else(Vec::new, |m| m.values().collect())
}
pub fn truth(v: &Value) -> bool {
    match v {
        Value::Null | Value::Bool(false) => false,
        Value::Number(_) => num(v) != 0.0,
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}
pub fn number(n: f64) -> Value {
    if n.is_finite() && n.fract() == 0.0 && n >= i64::MIN as f64 && n < i64::MAX as f64 {
        Value::from(n as i64)
    } else {
        serde_json::json!(n)
    }
}
pub use pacer_foundation::js_semantics::{is_js_space as whitespace, js_trim as trim};
/// sliceText from TS: clip by UTF-16 units without leaving a high surrogate.
pub fn slice(s: &str, max: usize) -> String {
    let mut units = 0;
    s.chars()
        .take_while(|c| {
            units += c.len_utf16();
            units <= max
        })
        .collect()
}
pub fn merge(a: &Value, b: &Value) -> Value {
    let mut out = a.as_object().cloned().unwrap_or_default();
    if let Some(b) = b.as_object() {
        out.extend(b.clone());
    }
    Value::Object(out)
}
pub fn remove(v: &mut Value, key: &str) {
    if let Some(m) = v.as_object_mut() {
        m.shift_remove(key);
    }
}
pub fn object() -> Value {
    Value::Object(Map::new())
}
pub fn stringify(v: &Value) -> String {
    match v {
        Value::Number(_) => {
            let n = num(v);
            if !n.is_finite() {
                "null".into()
            } else if n == 0.0 {
                "0".into()
            } else {
                ryu_js::Buffer::new().format(n).to_owned()
            }
        }
        Value::Array(a) => format!(
            "[{}]",
            a.iter().map(stringify).collect::<Vec<_>>().join(",")
        ),
        Value::Object(m) => {
            // JSON.stringify enumerates array-index keys before other own keys.
            let mut indices: Vec<_> = m
                .keys()
                .filter_map(|s| {
                    s.parse::<u32>()
                        .ok()
                        .filter(|n| *n < u32::MAX && n.to_string() == *s)
                        .map(|n| (n, s))
                })
                .collect();
            indices.sort_by_key(|(n, _)| *n);
            let keys = indices
                .iter()
                .map(|(_, s)| *s)
                .chain(m.keys().filter(|s| !indices.iter().any(|(_, k)| *k == *s)));
            format!(
                "{{{}}}",
                keys.map(|k| format!(
                    "{}:{}",
                    stringify(&Value::String(k.clone())),
                    stringify(&m[k])
                ))
                .collect::<Vec<_>>()
                .join(",")
            )
        }
        _ => v.to_string(),
    }
}

/// Compatibility transport clipping, including its three-dot suffix.
pub fn clip(s: &str, max: usize) -> String {
    if s.encode_utf16().count() <= max {
        s.into()
    } else {
        format!("{}...", slice(s, max.saturating_sub(3)))
    }
}
/// Regex \s in JavaScript excludes NEL and includes the byte-order mark.
pub fn regex(pattern: &str) -> Result<regex::Regex, regex::Error> {
    regex::Regex::new(&pattern.replace(r"\s",r"[\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]"))
}
