//! JavaScript JSON string preservation at native state and wire boundaries.
pub mod js_semantics;
mod parse;
use serde::{Serialize, Serializer};
use serde_json::{Value, value::RawValue};
use std::collections::BTreeMap;

/// A JavaScript string is a sequence of UTF-16 code units. In particular, slice
/// may retain one half of a surrogate pair; converting through Rust str loses it.
#[derive(Clone, Debug)]
pub struct Utf16String(Vec<u16>);
impl Utf16String {
    pub fn slice(text: &str, start: usize, end: usize) -> Self {
        Self(
            text.encode_utf16()
                .skip(start)
                .take(end.saturating_sub(start))
                .collect(),
        )
    }
    pub fn units(&self) -> &[u16] {
        &self.0
    }
    fn json(&self) -> String {
        let mut out = String::from("\"");
        for unit in char::decode_utf16(self.0.iter().copied()) {
            match unit {
                Ok('"') => out.push_str("\\\""),
                Ok('\\') => out.push_str("\\\\"),
                Ok(c) if c < ' ' => out.push_str(&format!("\\u{:04x}", c as u32)),
                Ok(c) => out.push(c),
                Err(e) => out.push_str(&format!("\\u{:04x}", e.unpaired_surrogate())),
            }
        }
        out.push('"');
        out
    }
}
impl Serialize for Utf16String {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let raw = RawValue::from_string(self.json()).map_err(serde::ser::Error::custom)?;
        raw.serialize(s)
    }
}
/// A reply retains a scalar preview for admission bookkeeping and a lossless
/// serializer for protocol delivery. Conversion to Value is explicitly fallible.
#[derive(Clone, Debug)]
pub struct WireReply {
    preview: Value,
    strings: BTreeMap<String, Utf16String>,
}
impl WireReply {
    pub fn new(value: Value) -> Self {
        Self {
            preview: value,
            strings: BTreeMap::new(),
        }
    }
    pub fn replace(&mut self, pointer: &str, value: Utf16String) {
        if self.preview.pointer(pointer).is_some_and(Value::is_string) {
            if let Some(slot) = self.preview.pointer_mut(pointer) {
                *slot = Value::String(String::from_utf16_lossy(value.units()));
            }
            self.strings.insert(pointer.into(), value);
        }
    }
    pub fn preview(&self) -> &Value {
        &self.preview
    }
    pub fn into_value(mut self) -> Result<Value, serde_json::Error> {
        for (path, text) in self.strings {
            let raw = text.json();
            let text: Value = serde_json::from_str(&raw)?;
            if let Some(slot) = self.preview.pointer_mut(&path) {
                *slot = text;
            }
        }
        Ok(self.preview)
    }
    pub fn to_json(&self) -> Result<String, serde_json::Error> {
        fn render(
            value: &Value,
            path: &str,
            strings: &BTreeMap<String, Utf16String>,
            out: &mut String,
        ) -> Result<(), serde_json::Error> {
            if let Some(s) = strings.get(path) {
                out.push_str(&s.json());
                return Ok(());
            }
            match value {
                Value::Object(map) => {
                    out.push('{');
                    for (i, (k, v)) in map.iter().enumerate() {
                        if i > 0 {
                            out.push(',');
                        }
                        out.push_str(&serde_json::to_string(k)?);
                        out.push(':');
                        render(
                            v,
                            &format!("{path}/{}", k.replace('~', "~0").replace('/', "~1")),
                            strings,
                            out,
                        )?;
                    }
                    out.push('}');
                }
                Value::Array(a) => {
                    out.push('[');
                    for (i, v) in a.iter().enumerate() {
                        if i > 0 {
                            out.push(',');
                        }
                        render(v, &format!("{path}/{i}"), strings, out)?;
                    }
                    out.push(']');
                }
                _ => out.push_str(&serde_json::to_string(value)?),
            }
            Ok(())
        }
        let mut out = String::new();
        render(&self.preview, "", &self.strings, &mut out)?;
        Ok(out)
    }
}
impl Serialize for WireReply {
    fn serialize<S: Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let raw = RawValue::from_string(self.to_json().map_err(serde::ser::Error::custom)?)
            .map_err(serde::ser::Error::custom)?;
        raw.serialize(s)
    }
}
