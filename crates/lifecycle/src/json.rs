//! Admission JSON retains JavaScript strings as UTF-16, including unpaired surrogates.
//! String tokens are decoded here; serde_json still validates the JSON structure.
use crate::AdmissionError;
use serde_json::Number;
use std::{collections::BTreeMap, fmt::Write, ops::Index};

/// JavaScript string code units. `Display` uses UTF-8 replacement for host
/// paths/argv; use `to_json` when the string must remain lossless.
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct AdmissionString {
    units: Vec<u16>,
    text: Option<String>,
}

impl From<&str> for AdmissionString {
    fn from(text: &str) -> Self {
        Self::new(text.encode_utf16().collect())
    }
}
impl From<String> for AdmissionString {
    fn from(text: String) -> Self {
        Self::from(text.as_str())
    }
}
impl std::fmt::Display for AdmissionString {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&String::from_utf16_lossy(&self.units))
    }
}
impl AdmissionString {
    fn new(units: Vec<u16>) -> Self {
        let text = String::from_utf16(&units).ok();
        Self { units, text }
    }
    pub fn as_str(&self) -> Option<&str> {
        self.text.as_deref()
    }
    pub fn utf16_len(&self) -> usize {
        self.units.len()
    }
    /// String iteration length: a valid surrogate pair counts once, each lone unit once.
    pub fn codepoint_len(&self) -> usize {
        char::decode_utf16(self.units.iter().copied()).count()
    }
    pub fn is_empty(&self) -> bool {
        self.units.is_empty()
    }
    /// ECMAScript WhiteSpace and LineTerminator, never surrogate code units.
    pub(crate) fn trim(&self) -> Self {
        let whitespace = |c: &u16| {
            matches!(*c,
            0x0009..=0x000d | 0x0020 | 0x00a0 | 0x1680 | 0x2000..=0x200a |
            0x2028 | 0x2029 | 0x202f | 0x205f | 0x3000 | 0xfeff)
        };
        let start = self.units.iter().take_while(|c| whitespace(c)).count();
        let end = self.units.len()
            - self.units[start..]
                .iter()
                .rev()
                .take_while(|c| whitespace(c))
                .count();
        Self::new(self.units[start..end].to_vec())
    }
    /// Serialize with lone surrogates escaped, as in JSON.stringify.
    pub fn to_json(&self) -> String {
        let mut out = String::new();
        self.write_json(&mut out);
        out
    }
    pub(crate) fn surround(prefix: &str, value: &Self, suffix: &str) -> Self {
        Self::new(
            prefix
                .encode_utf16()
                .chain(value.units.iter().copied())
                .chain(suffix.encode_utf16())
                .collect(),
        )
    }
    fn write_json(&self, out: &mut String) {
        out.push('"');
        for point in char::decode_utf16(self.units.iter().copied()) {
            match point {
                Ok('"') => out.push_str("\\\""),
                Ok('\\') => out.push_str("\\\\"),
                Ok(c) if c < '\u{20}' => {
                    let _ = write!(out, "\\u{:04x}", c as u16);
                }
                Ok(c) => out.push(c),
                Err(e) => {
                    let _ = write!(out, "\\u{:04x}", e.unpaired_surrogate());
                }
            }
        }
        out.push('"');
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub(crate) struct Map(BTreeMap<AdmissionString, Value>);
impl Map {
    pub(crate) fn new() -> Self {
        Self::default()
    }
    pub(crate) fn insert(&mut self, key: AdmissionString, value: Value) {
        self.0.insert(key, value);
    }
    pub(crate) fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(&AdmissionString::from(key))
    }
    pub(crate) fn keys(&self) -> impl Iterator<Item = &AdmissionString> {
        self.0.keys()
    }
    pub(crate) fn iter(&self) -> impl Iterator<Item = (&AdmissionString, &Value)> {
        self.0.iter()
    }
    pub(crate) fn entry(
        &mut self,
        key: &str,
    ) -> std::collections::btree_map::Entry<'_, AdmissionString, Value> {
        self.0.entry(key.into())
    }
}
impl<'a> IntoIterator for &'a Map {
    type Item = (&'a AdmissionString, &'a Value);
    type IntoIter = std::collections::btree_map::Iter<'a, AdmissionString, Value>;
    fn into_iter(self) -> Self::IntoIter {
        self.0.iter()
    }
}
impl FromIterator<(AdmissionString, Value)> for Map {
    fn from_iter<T: IntoIterator<Item = (AdmissionString, Value)>>(iter: T) -> Self {
        Self(iter.into_iter().collect())
    }
}

/// Lossless admission value. Use `parse`/`to_json` at JSON boundaries instead of
/// serde_json::Value, whose UTF-8 strings cannot represent lone UTF-16 surrogates.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Value {
    Null,
    Bool(bool),
    Number(Number),
    NonFinite(f64),
    String(AdmissionString),
    Array(Vec<Self>),
    Object(Map),
}
impl Value {
    pub fn parse(source: &str) -> Result<Self, AdmissionError> {
        let mut tokens = Vec::new();
        let mut structural = String::new();
        let mut chars = source.chars().peekable();
        while let Some(c) = chars.next() {
            if c == '-' || c.is_ascii_digit() {
                let mut lexeme = String::from(c);
                while let Some(c) =
                    chars.next_if(|c| matches!(c, '0'..='9' | '-' | '+' | '.' | 'e' | 'E'))
                {
                    lexeme.push(c);
                }
                let number = parse_number(&lexeme)?;
                let _ = write!(structural, "{}", tokens.len());
                tokens.push(number);
                continue;
            }
            if c != '"' {
                structural.push(c);
                continue;
            }
            let mut units = Vec::new();
            loop {
                let c = chars.next().ok_or_else(invalid_json)?;
                match c {
                    '"' => break,
                    '\\' => {
                        let escape = chars.next().ok_or_else(invalid_json)?;
                        let unit = match escape {
                            '"' => 0x22,
                            '\\' => 0x5c,
                            '/' => 0x2f,
                            'b' => 8,
                            'f' => 12,
                            'n' => 10,
                            'r' => 13,
                            't' => 9,
                            'u' => {
                                let mut n = 0u16;
                                for _ in 0..4 {
                                    let digit = chars
                                        .next()
                                        .filter(char::is_ascii_hexdigit)
                                        .and_then(|c| c.to_digit(16))
                                        .ok_or_else(invalid_json)?;
                                    n = (n << 4) | digit as u16;
                                }
                                n
                            }
                            _ => return Err(invalid_json()),
                        };
                        units.push(unit);
                    }
                    c if c < '\u{20}' => return Err(invalid_json()),
                    c => {
                        let mut buf = [0; 2];
                        units.extend_from_slice(c.encode_utf16(&mut buf));
                    }
                }
            }
            let _ = write!(structural, "\"{}\"", tokens.len());
            tokens.push(Value::String(AdmissionString::new(units)));
        }
        let shape: serde_json::Value = serde_json::from_str(&structural)
            .map_err(|e| AdmissionError(format!("invalid JSON: {e}")))?;
        fn restore(value: serde_json::Value, tokens: &[Value]) -> Result<Value, AdmissionError> {
            use serde_json::Value as SerdeValue;
            let token = |index: &str| {
                index
                    .parse::<usize>()
                    .ok()
                    .and_then(|i| tokens.get(i))
                    .cloned()
                    .ok_or_else(invalid_json)
            };
            Ok(match value {
                SerdeValue::Null => Value::Null,
                SerdeValue::Bool(b) => Value::Bool(b),
                SerdeValue::Number(n) => token(&n.to_string())?,
                SerdeValue::String(index) => token(&index)?,
                SerdeValue::Array(items) => Value::Array(
                    items
                        .into_iter()
                        .map(|v| restore(v, tokens))
                        .collect::<Result<_, _>>()?,
                ),
                SerdeValue::Object(fields) => {
                    let mut map = Map::new();
                    for (index, value) in fields {
                        let Value::String(key) = token(&index)? else {
                            return Err(invalid_json());
                        };
                        map.insert(key, restore(value, tokens)?);
                    }
                    Value::Object(map)
                }
            })
        }
        restore(shape, &tokens)
    }
    pub fn to_json(&self) -> String {
        fn write(value: &Value, out: &mut String) {
            match value {
                Value::Null => out.push_str("null"),
                Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
                Value::Number(n) => out.push_str(&n.to_string()),
                Value::NonFinite(_) => out.push_str("null"),
                Value::String(s) => s.write_json(out),
                Value::Array(items) => {
                    out.push('[');
                    for (i, v) in items.iter().enumerate() {
                        if i > 0 {
                            out.push(',');
                        }
                        write(v, out);
                    }
                    out.push(']');
                }
                Value::Object(fields) => {
                    out.push('{');
                    for (i, (k, v)) in fields.iter().enumerate() {
                        if i > 0 {
                            out.push(',');
                        }
                        k.write_json(out);
                        out.push(':');
                        write(v, out);
                    }
                    out.push('}');
                }
            }
        }
        let mut out = String::new();
        write(self, &mut out);
        out
    }
    pub fn get(&self, key: &str) -> Option<&Self> {
        self.as_object()?.get(key)
    }
    pub fn as_str(&self) -> Option<&str> {
        self.as_js_string()?.as_str()
    }
    pub(crate) fn as_js_string(&self) -> Option<&AdmissionString> {
        if let Self::String(s) = self {
            Some(s)
        } else {
            None
        }
    }
    pub(crate) fn as_object(&self) -> Option<&Map> {
        if let Self::Object(m) = self {
            Some(m)
        } else {
            None
        }
    }
    pub(crate) fn as_array(&self) -> Option<&Vec<Self>> {
        if let Self::Array(a) = self {
            Some(a)
        } else {
            None
        }
    }
    pub(crate) fn as_f64(&self) -> Option<f64> {
        match self {
            Self::Number(n) => n.as_f64(),
            Self::NonFinite(n) => Some(*n),
            _ => None,
        }
    }
    pub(crate) fn is_object(&self) -> bool {
        matches!(self, Self::Object(_))
    }
    pub(crate) fn is_boolean(&self) -> bool {
        matches!(self, Self::Bool(_))
    }
    pub(crate) fn pointer(&self, pointer: &str) -> Option<&Self> {
        pointer
            .strip_prefix('/')?
            .split('/')
            .try_fold(self, |v, key| v.get(key))
    }
}
/// Validate the JSON number grammar separately: JSON.parse accepts exponent
/// overflow as infinity, whereas serde_json rejects it before field validation.
/// JSON.parse represents every number as binary64, including integer lexemes.
/// Canonicalize integral values where serde_json can retain an integer exactly.
pub(crate) fn js_numbers(value: &Value) -> Value {
    match value {
        Value::Number(original) => {
            let Some(n) = original.as_f64().filter(|n| n.is_finite()) else {
                return value.clone();
            };
            if n == 0.0 && n.is_sign_negative() {
                Number::from_f64(n).map_or_else(|| value.clone(), Value::Number)
            } else if n.fract() == 0.0 && (0.0..18_446_744_073_709_551_616.0).contains(&n) {
                Value::Number(Number::from(n as u64))
            } else if n.fract() == 0.0 && (-9_223_372_036_854_775_808.0..0.0).contains(&n) {
                Value::Number(Number::from(n as i64))
            } else {
                Number::from_f64(n).map_or_else(|| value.clone(), Value::Number)
            }
        }
        Value::Array(items) => Value::Array(items.iter().map(js_numbers).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .iter()
                .map(|(key, item)| (key.clone(), js_numbers(item)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

fn parse_number(lexeme: &str) -> Result<Value, AdmissionError> {
    let mut bytes = lexeme.bytes().peekable();
    bytes.next_if_eq(&b'-');
    match bytes.next() {
        Some(b'0') => (),
        Some(b'1'..=b'9') => while bytes.next_if(u8::is_ascii_digit).is_some() {},
        _ => return Err(invalid_json()),
    }
    if bytes.next_if_eq(&b'.').is_some() {
        if bytes.next_if(u8::is_ascii_digit).is_none() {
            return Err(invalid_json());
        }
        while bytes.next_if(u8::is_ascii_digit).is_some() {}
    }
    if bytes.next_if(|b| matches!(b, b'e' | b'E')).is_some() {
        bytes.next_if(|b| matches!(b, b'+' | b'-'));
        if bytes.next_if(u8::is_ascii_digit).is_none() {
            return Err(invalid_json());
        }
        while bytes.next_if(u8::is_ascii_digit).is_some() {}
    }
    if bytes.next().is_some() {
        return Err(invalid_json());
    }
    let n: f64 = lexeme.parse().map_err(|_| invalid_json())?;
    Ok(js_numbers(
        &Number::from_f64(n).map_or(Value::NonFinite(n), Value::Number),
    ))
}

fn invalid_json() -> AdmissionError {
    AdmissionError("invalid JSON string".into())
}
impl Index<&str> for Value {
    type Output = Self;
    fn index(&self, key: &str) -> &Self {
        self.get(key).unwrap_or(&Self::Null)
    }
}
impl PartialEq<str> for Value {
    fn eq(&self, other: &str) -> bool {
        self.as_js_string()
            .is_some_and(|s| s.units.iter().copied().eq(other.encode_utf16()))
    }
}
impl PartialEq<&str> for Value {
    fn eq(&self, other: &&str) -> bool {
        self == *other
    }
}
impl From<serde_json::Value> for Value {
    fn from(value: serde_json::Value) -> Self {
        use serde_json::Value;
        match value {
            Value::Null => Self::Null,
            Value::Bool(b) => Self::Bool(b),
            Value::Number(n) => Self::Number(n),
            Value::String(s) => Self::String(s.into()),
            Value::Array(a) => Self::Array(a.into_iter().map(Self::from).collect()),
            Value::Object(m) => {
                Self::Object(m.into_iter().map(|(k, v)| (k.into(), v.into())).collect())
            }
        }
    }
}

/// A JSON admission result with lossless UTF-16 strings. Serialize through
/// `to_json`; converting it to serde_json::Value can reject lone surrogates.
#[derive(Clone, Debug, PartialEq)]
pub struct AdmissionValue(pub(crate) Value);
impl AdmissionValue {
    pub fn parse(source: &str) -> Result<Self, AdmissionError> {
        Value::parse(source).map(Self)
    }
    pub fn to_json(&self) -> String {
        self.0.to_json()
    }
}
