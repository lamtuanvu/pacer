//! Notification setting writes. Config-change publication remains with the caller.

use serde::Deserialize;
use serde_json::{Map, Value, json};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{fs, io, path::Path};

#[derive(Debug, thiserror::Error)]
pub enum NotificationError {
    #[error("notifications must be off, important or all")]
    InvalidLevel,
    #[error(transparent)]
    Io(#[from] io::Error),
}

fn valid(level: &str) -> bool {
    matches!(level, "off" | "important" | "all")
}

type SettingsObject = (Map<String, Value>, Option<Vec<u16>>);

fn parse_settings(bytes: &[u8]) -> Result<Value, serde_json::Error> {
    let mut parser = serde_json::Deserializer::from_slice(bytes);
    parser.disable_recursion_limit();
    let value = Value::deserialize(&mut parser)?;
    parser.end()?;
    Ok(value)
}

fn read_object(path: &Path) -> io::Result<SettingsObject> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(Default::default()),
    };
    let normalized = normalize_numbers(&bytes);
    // Bound stack use without ever treating an unsupported deep document as empty.
    // Count delimiters outside strings; false positives for invalid JSON are safe.
    let mut depth = 0usize;
    let mut in_string = false;
    let mut escaped = false;
    for &byte in &normalized {
        if in_string {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                in_string = false;
            }
        } else if byte == b'"' {
            in_string = true;
        } else if matches!(byte, b'[' | b'{') {
            depth += 1;
            if depth > 512 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "settings nesting exceeds supported depth",
                ));
            }
        } else if matches!(byte, b']' | b'}') {
            depth = depth.saturating_sub(1);
        }
    }
    let value = match parse_settings(&normalized) {
        Ok(value) => value,
        Err(_) => {
            // JSON.parse accepts lone UTF-16 surrogates, which serde_json cannot
            // represent. Detect otherwise valid JSON and refuse to overwrite it.
            let mut sanitized = normalized.clone();
            let mut i = 0;
            while i + 5 < sanitized.len() {
                if sanitized[i] == b'\\' {
                    if sanitized[i + 1] == b'u'
                        && let Ok(hex) = std::str::from_utf8(&sanitized[i + 2..i + 6])
                        && let Ok(unit) = u16::from_str_radix(hex, 16)
                        && (0xd800..=0xdfff).contains(&unit)
                    {
                        sanitized[i + 2..i + 6].copy_from_slice(b"0000");
                    }
                    i += 2;
                } else {
                    i += 1;
                }
            }
            if sanitized != normalized && parse_settings(&sanitized).is_ok() {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "settings contain unsupported UTF-16 surrogates",
                ));
            }
            return Ok(Default::default());
        }
    };
    Ok(match value {
        Value::Object(object) => (object, None),
        Value::Array(array) => (
            array
                .into_iter()
                .enumerate()
                .map(|(i, value)| (i.to_string(), value))
                .collect(),
            None,
        ),
        Value::String(string) => (Map::new(), Some(string.encode_utf16().collect())),
        _ => (Map::new(), None),
    })
}

// Normalize valid JSON number tokens to the doubles used by JSON.parse. Do not
// touch strings or invalid tokens: serde_json still decides whether the document
// is valid. Non-finite doubles stringify as null in JavaScript.
fn normalize_numbers(bytes: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    let mut in_string = false;
    while i < bytes.len() {
        let byte = bytes[i];
        if in_string {
            out.push(byte);
            i += 1;
            if byte == b'\\' && i < bytes.len() {
                out.push(bytes[i]);
                i += 1;
            } else if byte == b'"' {
                in_string = false;
            }
        } else if byte == b'"' {
            in_string = true;
            out.push(byte);
            i += 1;
        } else if byte == b'-' || byte.is_ascii_digit() {
            let start = i;
            while i < bytes.len()
                && (bytes[i].is_ascii_digit()
                    || matches!(bytes[i], b'-' | b'+' | b'.' | b'e' | b'E'))
            {
                i += 1;
            }
            let token = &bytes[start..i];
            if valid_number(token)
                && let Ok(text) = std::str::from_utf8(token)
                && let Ok(number) = text.parse::<f64>()
            {
                if let Some(number) = serde_json::Number::from_f64(number) {
                    out.extend_from_slice(crate::js_semantics::number_text(&number).as_bytes());
                } else {
                    out.extend_from_slice(b"null");
                }
                continue;
            }
            out.extend_from_slice(token);
        } else {
            out.push(byte);
            i += 1;
        }
    }
    out
}

fn valid_number(token: &[u8]) -> bool {
    let mut i = usize::from(token.first() == Some(&b'-'));
    match token.get(i) {
        Some(b'0') => i += 1,
        Some(b'1'..=b'9') => {
            i += 1;
            while token.get(i).is_some_and(u8::is_ascii_digit) {
                i += 1;
            }
        }
        _ => return false,
    }
    if token.get(i) == Some(&b'.') {
        i += 1;
        let start = i;
        while token.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    if matches!(token.get(i), Some(b'e' | b'E')) {
        i += 1;
        if matches!(token.get(i), Some(b'+' | b'-')) {
            i += 1;
        }
        let start = i;
        while token.get(i).is_some_and(u8::is_ascii_digit) {
            i += 1;
        }
        if i == start {
            return false;
        }
    }
    i == token.len()
}

// ECMAScript enumerates array-index keys first, then other keys in insertion order.
fn js_order(value: &mut Value) {
    match value {
        Value::Array(values) => values.iter_mut().for_each(js_order),
        Value::Object(object) => {
            let mut entries: Vec<_> = std::mem::take(object).into_iter().collect();
            for (_, value) in &mut entries {
                js_order(value);
            }
            entries.sort_by_key(|(key, _)| {
                {
                    key.parse::<u32>()
                        .ok()
                        .filter(|index| *index != u32::MAX && index.to_string() == *key)
                }
                .map_or((1, 0), |index| (0, index))
            });
            object.extend(entries);
        }
        _ => {}
    }
}

fn write_js_value(writer: &mut impl io::Write, value: &Value) -> io::Result<()> {
    match value {
        Value::Number(number) => write!(writer, "{}", crate::js_semantics::number_text(number)),
        Value::Array(values) => {
            write!(writer, "[")?;
            for (i, value) in values.iter().enumerate() {
                if i > 0 {
                    write!(writer, ",")?;
                }
                write_js_value(writer, value)?;
            }
            write!(writer, "]")
        }
        Value::Object(values) => {
            write!(writer, "{{")?;
            for (i, (key, value)) in values.iter().enumerate() {
                if i > 0 {
                    write!(writer, ",")?;
                }
                serde_json::to_writer(&mut *writer, key)?;
                write!(writer, ":")?;
                write_js_value(writer, value)?;
            }
            write!(writer, "}}")
        }
        _ => serde_json::to_writer(writer, value).map_err(io::Error::other),
    }
}

fn write_settings(
    path: &Path,
    settings: &Map<String, Value>,
    units: Option<&[u16]>,
) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("settings has no parent"))?;
    fs::create_dir_all(parent)?;
    #[cfg(unix)]
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    let (temp, mut file) = crate::temp_file::create(path)?;
    let result = (|| {
        use std::io::Write;
        if let Some(units) = units {
            write!(file, "{{")?;
            for (i, unit) in units.iter().enumerate() {
                if i > 0 {
                    write!(file, ",")?;
                }
                write!(file, "\"{i}\":")?;
                if (0xd800..=0xdfff).contains(unit) {
                    write!(file, "\"\\u{unit:04x}\"")?;
                } else if let Some(ch) = char::from_u32(u32::from(*unit)) {
                    serde_json::to_writer(&mut file, &ch.to_string())?;
                }
            }
            if !units.is_empty() {
                write!(file, ",")?;
            }
            write!(file, "\"notifications\":")?;
            serde_json::to_writer(&mut file, &settings["notifications"])?;
            write!(file, "}}")?;
        } else {
            let mut ordered = Value::Object(settings.clone());
            js_order(&mut ordered);
            write_js_value(&mut file, &ordered)?;
        }
        file.flush()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

/// Read the effective level; an absent or invalid primary level is copied from
/// the legacy plugin setting, or initialized to `important`, as in TypeScript.
pub fn get_level(home: &Path, legacy_plugin_data: &Path) -> Result<Value, NotificationError> {
    let path = home.join("settings.json");
    let (mut settings, units) = read_object(&path)?;
    if let Some(level) = settings.get("notifications").and_then(Value::as_str)
        && valid(level)
    {
        return Ok(json!({"level":level}));
    }
    let legacy = legacy_plugin_data.join("settings.json");
    let level = read_object(&legacy)?
        .0
        .get("notifications")
        .and_then(Value::as_str)
        .filter(|value| valid(value))
        .unwrap_or("important")
        .to_owned();
    settings.insert("notifications".into(), json!(level));
    write_settings(&path, &settings, units.as_deref())?;
    Ok(json!({"level":level}))
}

pub fn set_level(home: &Path, level: &str) -> Result<Value, NotificationError> {
    if !valid(level) {
        return Err(NotificationError::InvalidLevel);
    }
    let path = home.join("settings.json");
    let (mut settings, units) = read_object(&path)?;
    settings.insert("notifications".into(), json!(level));
    write_settings(&path, &settings, units.as_deref())?;
    Ok(json!({"level":level}))
}
