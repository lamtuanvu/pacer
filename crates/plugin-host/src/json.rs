//! JSON.parse string compatibility on the serde Value ABI. UTF-8 cannot hold lone
//! UTF-16 units. Internally quote them with a noncharacter prefix; quote that
//! prefix itself too, so every real Unicode string remains distinct. Only this
//! module and settings::js_json cross the wire; the quoting never escapes there.
use serde::Deserialize;
use serde_json::Value;
use std::fmt::Write;
const ESC: char = '\u{fdd0}';

pub fn utf16(s: &str) -> Vec<u16> {
    let mut units = Vec::new();
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == ESC {
            match chars.next() {
                Some(ESC) => units.push(ESC as u16),
                Some(c @ '\u{e000}'..='\u{e7ff}') => units.push(0xd800 + (c as u16 - 0xe000)),
                Some(c) => {
                    units.push(ESC as u16);
                    units.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
                }
                None => units.push(ESC as u16),
            }
        } else {
            units.extend(c.encode_utf16(&mut [0; 2]).iter().copied());
        }
    }
    units
}
fn encode(units: &[u16]) -> String {
    let mut out = String::new();
    for c in char::decode_utf16(units.iter().copied()) {
        match c {
            Ok(ESC) => {
                out.push(ESC);
                out.push(ESC);
            }
            Ok(c) => out.push(c),
            Err(e) => {
                out.push(ESC);
                if let Some(c) = char::from_u32(0xe000 + u32::from(e.unpaired_surrogate() - 0xd800))
                {
                    out.push(c);
                }
            }
        }
    }
    out
}
/// Import values produced by Rust/YAML rather than this decoder. Keep all
/// in-memory plugin strings in the same quoted representation.
pub(crate) fn from_utf8(value: Value) -> Value {
    match value {
        Value::String(s) => Value::String(encode(&s.encode_utf16().collect::<Vec<_>>())),
        Value::Array(items) => Value::Array(items.into_iter().map(from_utf8).collect()),
        Value::Object(fields) => Value::Object(
            fields
                .into_iter()
                .map(|(k, v)| (encode(&k.encode_utf16().collect::<Vec<_>>()), from_utf8(v)))
                .collect(),
        ),
        other => other,
    }
}
pub fn string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in char::decode_utf16(utf16(s)) {
        match c {
            Ok('"') => out.push_str("\\\""),
            Ok('\\') => out.push_str("\\\\"),
            Ok('\n') => out.push_str("\\n"),
            Ok('\r') => out.push_str("\\r"),
            Ok('\t') => out.push_str("\\t"),
            Ok('\u{8}') => out.push_str("\\b"),
            Ok('\u{c}') => out.push_str("\\f"),
            Ok(c) if c < '\u{20}' => {
                let _ = write!(out, "\\u{:04x}", c as u32);
            }
            Ok(c) => out.push(c),
            Err(e) => {
                let _ = write!(out, "\\u{:04x}", e.unpaired_surrogate());
            }
        }
    }
    out.push('"');
    out
}
/// Bound IPC decoding before serde's recursive visitor. A 70-deep view is valid
/// JSON and reaches document validation; pathological envelopes fail explicitly.
/// Decode deeper ordinary envelopes on an owned larger stack, never a Tokio worker.
pub fn parse(bytes: &[u8]) -> Result<Value, String> {
    let source = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    let mut chars = source.chars();
    let mut wire = String::with_capacity(source.len());
    let (mut depth, mut deepest) = (0usize, 0usize);
    while let Some(c) = chars.next() {
        if c != '"' {
            if c == '[' || c == '{' {
                depth += 1;
                deepest = deepest.max(depth);
            }
            if c == ']' || c == '}' {
                depth = depth.saturating_sub(1);
            }
            if deepest > 512 {
                return Err("JSON nesting exceeds 512 levels".into());
            }
            wire.push(c);
            continue;
        }
        let mut units = Vec::new();
        loop {
            let c = chars.next().ok_or("unterminated JSON string")?;
            match c {
                '"' => break,
                '\\' => {
                    let unit = match chars.next().ok_or("invalid JSON escape")? {
                        '"' => 0x22,
                        '\\' => 0x5c,
                        '/' => 0x2f,
                        'b' => 8,
                        'f' => 12,
                        'n' => 10,
                        'r' => 13,
                        't' => 9,
                        'u' => {
                            let mut unit = 0;
                            for _ in 0..4 {
                                unit = (unit << 4)
                                    | chars
                                        .next()
                                        .filter(char::is_ascii_hexdigit)
                                        .and_then(|c| c.to_digit(16))
                                        .ok_or("invalid JSON escape")?
                                        as u16;
                            }
                            unit
                        }
                        _ => return Err("invalid JSON escape".into()),
                    };
                    units.push(unit);
                }
                c if c < '\u{20}' => return Err("invalid JSON control".into()),
                c => units.extend(c.encode_utf16(&mut [0; 2]).iter().copied()),
            }
        }
        wire.push_str(&serde_json::to_string(&encode(&units)).map_err(|e| e.to_string())?);
    }
    fn decode(wire: &str) -> Result<Value, String> {
        let mut decoder = serde_json::Deserializer::from_str(wire);
        decoder.disable_recursion_limit();
        let value = Value::deserialize(&mut decoder).map_err(|e| e.to_string())?;
        decoder.end().map_err(|e| e.to_string())?;
        Ok(value)
    }
    if deepest < 64 {
        return decode(&wire);
    }
    std::thread::Builder::new()
        .name("plugin-json".into())
        .stack_size(16 * 1024 * 1024)
        .spawn(move || decode(&wire))
        .map_err(|e| e.to_string())?
        .join()
        .map_err(|_| "JSON decoder failed".to_owned())?
}
