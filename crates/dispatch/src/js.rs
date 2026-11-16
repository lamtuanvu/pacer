//! The JavaScript semantics the decision functions rely on.
use pacer_js_json::stringify;
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
