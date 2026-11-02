use serde_json::{Number, Value};

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// JSON numbers are JavaScript doubles at the TypeScript validation boundary.
pub(crate) fn number(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite())
}

pub(crate) fn integer(value: &Value) -> Option<f64> {
    number(value).filter(|n| n.fract() == 0.0)
}

pub(crate) fn safe_integer(value: &Value) -> Option<f64> {
    integer(value).filter(|n| n.abs() <= MAX_SAFE_INTEGER)
}

pub(crate) fn code_points(value: &str) -> usize {
    value.chars().count()
}

pub(crate) fn zod_name(value: &str) -> bool {
    let length = code_points(value);
    (1..=256).contains(&length)
}

pub(crate) fn utf16_units(value: &str) -> usize {
    value.encode_utf16().count()
}

pub(crate) fn number_text(value: &Number) -> String {
    let Some(number) = value.as_f64() else {
        return value.to_string();
    };
    if number == 0.0 {
        return "0".into();
    }
    if number.fract() == 0.0 && number.abs() < 1e21 {
        return number.to_string();
    }
    value.to_string()
}
