//! JSON.parse string compatibility on the serde Value ABI. UTF-8 cannot hold lone
//! UTF-16 units. Internally quote them with a noncharacter prefix; quote that
//! prefix itself too, so every real Unicode string remains distinct. Only this
//! module and settings::js_json cross the wire; the quoting never escapes there.
use serde::Deserialize;
use serde_json::Value;
use std::fmt::Write;
const ESC: char = '\u{fdd0}';

// User strings quote ESC twice, so these internal values cannot collide with
// JSON strings. serde's Number cannot represent JSON.parse's signed Infinity.
const POS_INFINITY: &str = "\u{fdd0}+Infinity";
const NEG_INFINITY: &str = "\u{fdd0}-Infinity";
pub fn number(value: &Value) -> Option<f64> {
    match value.as_str() {
        Some(POS_INFINITY) => Some(f64::INFINITY),
        Some(NEG_INFINITY) => Some(f64::NEG_INFINITY),
        _ => value.as_f64(),
    }
}
pub fn nonfinite(value: &Value) -> bool {
    number(value).is_some_and(|n| !n.is_finite())
}

/// Node's UTF-8 file reader replaces malformed sequences, preserving a BOM.
pub fn parse_file(bytes: &[u8]) -> Result<Value, String> {
    parse(String::from_utf8_lossy(bytes).as_bytes())
}
/// Fetch's default TextDecoder replaces malformed sequences and strips one BOM.
pub fn parse_body(bytes: &[u8]) -> Result<Value, String> {
    let text = String::from_utf8_lossy(bytes);
    parse(text.strip_prefix('\u{feff}').unwrap_or(&text).as_bytes())
}

fn json_number(token: &str) -> bool {
    let bytes = token.as_bytes();
    let mut i = usize::from(bytes.first() == Some(&b'-'));
    match bytes.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => {
            i += 1;
            while bytes.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
        }
        _ => return false,
    }
    if bytes.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    if matches!(bytes.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(bytes.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let start = i;
        while bytes.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == bytes.len()
}

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
/// Signals an unsupported native envelope, never malformed JSON. The HTTP
/// read dispatcher forwards the original request to TypeScript on this signal.
pub const NESTING_FALLBACK: &str = "JSON nesting requires TypeScript fallback";

/// Bound native serde values before they reach recursive clone/serialize/drop
/// on a Tokio worker. Deep ordinary JSON remains valid and selects TS fallback.
pub fn parse(bytes: &[u8]) -> Result<Value, String> {
    let source = std::str::from_utf8(bytes).map_err(|e| e.to_string())?;
    let mut chars = source.chars().peekable();
    let mut wire = String::with_capacity(source.len());
    let (mut depth, mut deepest) = (0usize, 0usize);
    while let Some(c) = chars.next() {
        if c != '"' {
            if c == '-' || c.is_ascii_digit() {
                let mut token = c.to_string();
                while chars
                    .peek()
                    .is_some_and(|c| !matches!(c, ' ' | '\t' | '\r' | '\n' | ',' | ']' | '}'))
                {
                    if let Some(c) = chars.next() {
                        token.push(c);
                    }
                }
                if !json_number(&token) {
                    return Err("invalid JSON number".into());
                }
                let n = token.parse::<f64>().map_err(|e| e.to_string())?;
                if n.is_infinite() {
                    wire.push_str(
                        &serde_json::to_string(if n.is_sign_negative() {
                            NEG_INFINITY
                        } else {
                            POS_INFINITY
                        })
                        .map_err(|e| e.to_string())?,
                    );
                } else {
                    wire.push_str(&token);
                }
                continue;
            }
            if c == '[' || c == '{' {
                depth += 1;
                deepest = deepest.max(depth);
            }
            if c == ']' || c == '}' {
                depth = depth.saturating_sub(1);
            }
            if deepest > 512 {
                return Err(NESTING_FALLBACK.into());
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
