use serde::{Serialize, Serializer};
use serde_json::value::RawValue;
use std::cmp::Ordering;

/// JavaScript strings are UTF-16, including slices ending on a lone surrogate.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Text(pub Vec<u16>);
impl Text {
    pub fn new(s: &str) -> Self {
        Self(s.encode_utf16().collect())
    }
    pub fn slice(&self, max: usize) -> Self {
        Self(self.0[..self.0.len().min(max)].to_vec())
    }
    pub(crate) fn clip(&self, max: usize) -> Self {
        if self.0.len() <= max {
            self.clone()
        } else {
            let mut t = self.slice(max - 1);
            t.0.push(0x2026);
            t
        }
    }
}
impl Serialize for Text {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let mut encoded = String::from("\"");
        for unit in &self.0 {
            encoded.push_str(&format!("\\u{unit:04x}"));
        }
        encoded.push('"');
        let raw = RawValue::from_string(encoded).map_err(serde::ser::Error::custom)?;
        raw.serialize(serializer)
    }
}
pub fn number(n: f64) -> String {
    ryu_js::Buffer::new().format(n).to_owned()
}
pub const WHITESPACE: &str =
    r"[\t-\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
pub const NON_WHITESPACE: &str =
    r"[^\t-\r \u{00a0}\u{1680}\u{2000}-\u{200a}\u{2028}\u{2029}\u{202f}\u{205f}\u{3000}\u{feff}]";
pub fn trim(s: &str) -> &str {
    s.trim_matches(|c| matches!(c,'\u{0009}'..='\u{000d}'|'\u{0020}'|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
pub fn compare(a: &str, b: &str) -> Ordering {
    icu_collator::CollatorBorrowed::new_root(Default::default()).compare(a, b)
}
pub fn encode(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}
