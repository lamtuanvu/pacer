use serde_json::Value;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// JSON numbers are JavaScript numbers at the TypeScript protocol boundary.
pub(crate) fn safe_u64(value: &Value) -> Option<u64> {
    let number = value.as_f64()?;
    (number.is_finite() && number.fract() == 0.0 && (0.0..=MAX_SAFE_INTEGER).contains(&number))
        .then_some(number as u64)
}

pub(crate) fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub(crate) fn codepoint_len(value: &str) -> usize {
    value.chars().count()
}

#[cfg(test)]
mod tests;
