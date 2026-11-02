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
    let text = value.to_string();
    let Some((mantissa, exponent)) = text.split_once('e') else {
        return text;
    };
    let Ok(exponent) = exponent.parse::<i32>() else {
        return text;
    };
    if (-6..21).contains(&exponent) {
        let (sign, mantissa) = mantissa
            .strip_prefix('-')
            .map_or(("", mantissa), |v| ("-", v));
        let digits = mantissa.replace('.', "");
        let point = 1 + exponent;
        if point <= 0 {
            return format!("{sign}0.{}{digits}", "0".repeat((-point) as usize));
        }
        let point = point as usize;
        if point >= digits.len() {
            return format!("{sign}{digits}{}", "0".repeat(point - digits.len()));
        }
        return format!("{sign}{}.{}", &digits[..point], &digits[point..]);
    }
    if exponent >= 0 {
        format!("{mantissa}e+{exponent}")
    } else {
        format!("{mantissa}e{exponent}")
    }
}
