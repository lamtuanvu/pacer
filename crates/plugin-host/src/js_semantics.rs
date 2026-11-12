use serde_json::Value;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// JSON numbers are JavaScript numbers at the TypeScript protocol boundary.
pub fn safe_u64(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&number))
        .then_some(number as u64)
}

pub fn safe_i64(value: &Value) -> Option<i64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && number.abs() <= MAX_SAFE_INTEGER)
        .then_some(number as i64)
}

pub fn finite_f64(value: &Value) -> Option<f64> {
    value.as_f64().filter(|number| number.is_finite())
}

pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub fn codepoint_len(value: &str) -> usize {
    value.chars().count()
}

pub fn trim(value: &str) -> &str {
    value.trim_matches(|c| matches!(c, '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'))
}

#[cfg(test)]
mod tests;
