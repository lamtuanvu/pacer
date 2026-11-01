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

fn read_object(path: &Path) -> Map<String, Value> {
    fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn write_settings(path: &Path, settings: &Map<String, Value>) -> io::Result<()> {
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
        serde_json::to_writer(&mut file, settings)?;
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
    let mut settings = read_object(&path);
    if let Some(level) = settings.get("notifications").and_then(Value::as_str)
        && valid(level)
    {
        return Ok(json!({"level":level}));
    }
    let legacy = legacy_plugin_data.join("settings.json");
    let level = read_object(&legacy)
        .get("notifications")
        .and_then(Value::as_str)
        .filter(|value| valid(value))
        .unwrap_or("important")
        .to_owned();
    settings.insert("notifications".into(), json!(level));
    write_settings(&path, &settings)?;
    Ok(json!({"level":level}))
}

pub fn set_level(home: &Path, level: &str) -> Result<Value, NotificationError> {
    if !valid(level) {
        return Err(NotificationError::InvalidLevel);
    }
    let path = home.join("settings.json");
    let mut settings = read_object(&path);
    settings.insert("notifications".into(), json!(level));
    write_settings(&path, &settings)?;
    Ok(json!({"level":level}))
}
