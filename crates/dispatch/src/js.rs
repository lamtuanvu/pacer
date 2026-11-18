//! The JavaScript semantics the decision functions rely on.
use pacer_js_json::js_semantics::string_to_number;
use pacer_js_json::{number_string, stringify};
use serde_json::{Map, Value, json};
use std::cmp::Ordering;

/// A JSON object in insertion order.
pub type Object = Map<String, Value>;

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// A JavaScript number as JSON: integral values without a fraction, `-0` as `0`,
/// and non-finite values as `null`, as `JSON.stringify` writes them.
pub(crate) fn num(n: f64) -> Value {
    if !n.is_finite() {
        Value::Null
    } else if n.fract() == 0.0 && n.abs() <= MAX_SAFE {
        json!(n as i64)
    } else {
        json!(n)
    }
}

/// JavaScript truthiness; `None` is `undefined`.
pub(crate) fn truthy(value: Option<&Value>) -> bool {
    value.is_some_and(pacer_js_json::js_semantics::truthy)
}

/// `JSON.stringify(a) === JSON.stringify(b)`; `None` is `undefined`.
pub(crate) fn same_json(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(a), Some(b)) => stringify(a) == stringify(b),
        _ => false,
    }
}

/// String `<` and the default array sort: UTF-16 code unit order.
pub(crate) fn js_cmp(a: &str, b: &str) -> Ordering {
    a.encode_utf16().cmp(b.encode_utf16())
}

/// `Math.round`: halves round toward positive infinity.
pub(crate) fn js_round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `Math.min(...values)`: any NaN makes the result NaN.
pub(crate) fn js_min(values: impl IntoIterator<Item = f64>) -> f64 {
    values.into_iter().fold(f64::INFINITY, |min, n| {
        if min.is_nan() || n.is_nan() {
            f64::NAN
        } else {
            min.min(n)
        }
    })
}

/// `Math.max(...values)`, with the same NaN rule.
pub(crate) fn js_max(values: impl IntoIterator<Item = f64>) -> f64 {
    -js_min(values.into_iter().map(|n| -n))
}

/// A number field, `None` for anything else (including `null`).
pub(crate) fn number(value: Option<&Value>) -> Option<f64> {
    value.filter(|v| v.is_number()).and_then(Value::as_f64)
}

/// A number field read as JavaScript arithmetic would: a missing value is NaN.
pub(crate) fn at(object: &Object, key: &str) -> f64 {
    number(object.get(key)).unwrap_or(f64::NAN)
}

/// `String(value)`, as a template literal writes it; `None` is `undefined`.
pub(crate) fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(b)) => b.to_string(),
        Some(Value::Number(n)) => number_string(n.as_f64().unwrap_or(f64::NAN)),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(Some(item)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

/// `ToNumber` for the primitives a JSON row holds: `null` is 0, `undefined`
/// NaN. Arrays and objects read as NaN.
pub(crate) fn to_number(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => string_to_number(s),
        _ => f64::NAN,
    }
}

/// `a === b` for JSON values: arrays and objects are never equal (distinct references).
pub(crate) fn strict_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => true,
        (Some(Value::Bool(a)), Some(Value::Bool(b))) => a == b,
        (Some(Value::Number(a)), Some(Value::Number(b))) => a.as_f64() == b.as_f64(),
        (Some(Value::String(a)), Some(Value::String(b))) => a == b,
        _ => false,
    }
}

/// An object literal: `None` members are `undefined`, which `JSON.stringify`
/// and the decision hash leave out.
pub(crate) fn object<'a>(entries: impl IntoIterator<Item = (&'a str, Option<Value>)>) -> Value {
    Value::Object(
        entries
            .into_iter()
            .filter_map(|(key, value)| value.map(|v| (key.to_owned(), v)))
            .collect(),
    )
}
