use serde_json::Value;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

pub(crate) fn integer(value: &Value) -> Option<f64> {
    value.as_f64().filter(|n| n.is_finite() && n.fract() == 0.0)
}

pub(crate) fn safe_integer(value: &Value) -> Option<f64> {
    integer(value).filter(|n| n.abs() <= MAX_SAFE_INTEGER)
}

pub(crate) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c| {
        matches!(c,
        '\u{0009}'..='\u{000d}' | '\u{0020}' | '\u{00a0}' | '\u{1680}' |
        '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' |
        '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}

pub(crate) fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

pub(crate) fn codepoint_len(value: &str) -> usize {
    value.chars().count()
}
