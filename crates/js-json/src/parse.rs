use super::{Utf16String, WireReply};
use serde_json::{Value, value::RawValue};
use std::collections::BTreeMap;
struct Fields(Vec<(String, Box<RawValue>)>);
impl<'de> serde::Deserialize<'de> for Fields {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        struct Ordered;
        impl<'de> serde::de::Visitor<'de> for Ordered {
            type Value = Fields;
            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a JSON object")
            }
            fn visit_map<M: serde::de::MapAccess<'de>>(
                self,
                mut map: M,
            ) -> Result<Fields, M::Error> {
                let mut fields = vec![];
                while let Some(entry) = map.next_entry()? {
                    fields.push(entry);
                }
                Ok(Fields(fields))
            }
        }
        d.deserialize_map(Ordered)
    }
}
fn units(raw: &str) -> Result<Vec<u16>, serde_json::Error> {
    if let Ok(text) = serde_json::from_str::<String>(raw) {
        return Ok(text.encode_utf16().collect());
    }
    // RawValue already validates JSON grammar; retain \uXXXX units before a
    // scalar-string deserializer has an opportunity to reject a lone surrogate.
    let mut chars = raw[1..raw.len() - 1].chars();
    let mut out = vec![];
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
            continue;
        }
        let Some(escaped) = chars.next() else {
            return serde_json::from_str::<String>(raw).map(|s| s.encode_utf16().collect());
        };
        let code = match escaped {
            'u' => {
                let hex = chars.by_ref().take(4).collect::<String>();
                u16::from_str_radix(&hex, 16)
                    .map_err(|_| serde::de::Error::custom("invalid unicode escape"))?
            }
            '"' => 34,
            '\\' => 92,
            '/' => 47,
            'b' => 8,
            'f' => 12,
            'n' => 10,
            'r' => 13,
            't' => 9,
            _ => return Err(serde::de::Error::custom("invalid JSON escape")),
        };
        out.push(code);
    }
    Ok(out)
}
fn parse(
    raw: &RawValue,
    path: &str,
    strings: &mut BTreeMap<String, Utf16String>,
    depth: usize,
) -> Result<Value, serde_json::Error> {
    if depth > 128 {
        return Err(serde::de::Error::custom("JSON recursion limit exceeded"));
    }
    let text = raw.get();
    if text.starts_with('"') {
        let units = units(text)?;
        let scalar = String::from_utf16(&units);
        let invalid = scalar.is_err();
        let preview = scalar.unwrap_or_else(|_| String::from_utf16_lossy(&units));
        if invalid {
            strings.insert(path.into(), Utf16String(units));
        }
        return Ok(Value::String(preview));
    }
    if text.starts_with('{') {
        let Fields(fields) = serde_json::from_str(text)?;
        let mut value = serde_json::Map::new();
        for (key, raw) in fields {
            let next = format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"));
            value.insert(key, parse(&raw, &next, strings, depth + 1)?);
        }
        return Ok(Value::Object(value));
    }
    if text.starts_with('[') {
        let items: Vec<Box<RawValue>> = serde_json::from_str(text)?;
        return items
            .iter()
            .enumerate()
            .map(|(i, v)| parse(v, &format!("{path}/{i}"), strings, depth + 1))
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array);
    }
    serde_json::from_str(text)
}
impl WireReply {
    pub fn parse(text: &str) -> Result<Self, serde_json::Error> {
        if let Ok(value) = serde_json::from_str::<Value>(text) {
            return Ok(Self::new(value));
        }
        let raw = RawValue::from_string(text.into())?;
        let mut strings = BTreeMap::new();
        let preview = parse(&raw, "", &mut strings, 0)?;
        Ok(Self { preview, strings })
    }
    /// Preserve exact non-scalar fields while metadata is mutated through the
    /// scalar preview. Explicit text replacement uses replace, even for U+FFFD.
    pub fn preserving(&self, preview: Value) -> Self {
        let strings = self
            .strings
            .iter()
            .filter(|(p, _)| {
                self.preview.pointer(p) == preview.pointer(p)
                    && preview.pointer(p).is_some_and(Value::is_string)
            })
            .map(|(p, s)| (p.clone(), s.clone()))
            .collect();
        Self { preview, strings }
    }
}
