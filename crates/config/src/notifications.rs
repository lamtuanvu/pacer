//! Notification setting writes. Config-change publication remains with the caller.

use serde_json::{Map, Value, json};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::sync::atomic::{AtomicU64, Ordering};
use std::{fs, io, path::Path};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

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

fn read_object(path: &Path) -> io::Result<SettingsObject> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(_) => return Ok(Default::default()),
    };
    let value = match serde_json::from_slice::<Value>(&bytes) {
        Ok(value) => value,
        Err(_) => {
            // JSON.parse accepts lone UTF-16 surrogates, which serde_json cannot
            // represent. Detect otherwise valid JSON and refuse to overwrite it.
            let mut sanitized = bytes.clone();
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
            if sanitized != bytes && serde_json::from_slice::<Value>(&sanitized).is_ok() {
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
    let temp = path.with_file_name(format!(
        "settings.json.{}.{}.tmp",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        use std::io::Write;
        let mut file = options.open(&temp)?;
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
            serde_json::to_writer(&mut file, &ordered)?;
        }
        file.flush()?;
        fs::rename(&temp, path)
    })();
    let _ = fs::remove_file(temp);
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
