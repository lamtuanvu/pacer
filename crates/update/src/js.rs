//! The few ECMAScript semantics the TypeScript reference relies on.
use serde_json::Value;

/// A regular-expression `\s` character.
pub(crate) fn space(c: char) -> bool {
    matches!(c,
        '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' |
        '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' |
        '\u{205F}' | '\u{3000}' | '\u{FEFF}'
    )
}

/// A line terminator for multiline `^`, `$` and `.`.
pub(crate) fn line_end(c: char) -> bool {
    matches!(c, '\n' | '\r' | '\u{2028}' | '\u{2029}')
}

/// `String(n)` for a finite number.
pub(crate) fn number_text(n: f64) -> String {
    if n == 0.0 {
        "0".into()
    } else {
        ryu_js::Buffer::new().format(n).to_owned()
    }
}

/// A number as `JSON.parse` would read the text `String(n)` back.
pub(crate) fn number(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        Value::from(n as i64)
    } else {
        serde_json::Number::from_f64(n).map_or(Value::Null, Value::Number)
    }
}

/// JavaScript truthiness of a JSON value.
pub(crate) fn truthy(value: &Value) -> bool {
    match value {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

/// `JSON.stringify` of a parsed JSON value: integer-index keys first, ECMAScript number spelling.
pub(crate) fn stringify(value: &Value) -> String {
    match value {
        Value::Number(n) => n.as_f64().map_or_else(|| "null".into(), number_text),
        Value::Array(items) => format!(
            "[{}]",
            items.iter().map(stringify).collect::<Vec<_>>().join(",")
        ),
        Value::Object(map) => {
            let index = |key: &str| {
                key.parse::<u32>()
                    .ok()
                    .filter(|n| *n < u32::MAX && n.to_string() == key)
            };
            let mut keys: Vec<&String> = map.keys().filter(|k| index(k).is_some()).collect();
            keys.sort_by_key(|k| index(k));
            keys.extend(map.keys().filter(|k| index(k).is_none()));
            let fields: Vec<String> = keys
                .into_iter()
                .map(|k| format!("{}:{}", Value::String(k.clone()), stringify(&map[k])))
                .collect();
            format!("{{{}}}", fields.join(","))
        }
        other => other.to_string(),
    }
}
