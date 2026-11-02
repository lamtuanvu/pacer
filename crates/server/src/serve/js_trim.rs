//! ECMAScript String.prototype.trim whitespace, including the line terminators.
pub(super) fn js_trim(value: &str) -> &str {
    value.trim_matches(|c: char| {
        matches!(c, '\t'..='\r' | ' ' | '\u{00a0}' | '\u{1680}' | '\u{2000}'..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}')
    })
}
