//! Notification setting writes. Config-change publication remains with the caller.

use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{fs, io, path::Path};

#[derive(Debug, thiserror::Error)]
pub enum NotificationError {
    #[error("notifications must be off, important or all")]
    InvalidLevel,
    #[error("notificationSound must be pacer, default or off")]
    InvalidSound,
    #[error("provide level or sound")]
    Empty,
    #[error(transparent)]
    Io(#[from] io::Error),
}

fn valid(level: &str) -> bool {
    matches!(level, "off" | "important" | "all")
}

fn valid_sound(sound: &str) -> bool {
    matches!(sound, "pacer" | "default" | "off")
}

fn write_bytes(path: &Path, bytes: Vec<u8>) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("settings has no parent"))?;
    fs::create_dir_all(parent)?;
    #[cfg(unix)]
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    let (temp, mut file) = crate::temp_file::create(path)?;
    let result = (|| {
        use std::io::Write;
        file.write_all(&bytes)?;
        file.flush()?;
        fs::rename(&temp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temp);
    }
    result
}

fn write_level(path: &Path, level: &str) -> io::Result<()> {
    write_bytes(path, crate::notification_json::settings(path, level))
}

/// The effective sound, read without writing; absent or invalid means `pacer`.
fn effective_sound(path: &Path) -> String {
    crate::notification_json::sound(path)
        .filter(|v| valid_sound(v))
        .unwrap_or_else(|| "pacer".into())
}

/// The effective level read only (no legacy migration, no write), as TypeScript
/// reports for a `set` whose level was not part of the request.
fn effective_level_no_write(path: &Path) -> String {
    crate::notification_json::level(path)
        .filter(|v| valid(v))
        .unwrap_or_else(|| "important".into())
}

/// Read the effective level; an absent or invalid primary level is copied from
/// the legacy plugin setting, or initialized to `important`, as in TypeScript.
/// The sound is computed read-only (default `pacer`); it never writes.
pub fn get_level(home: &Path, legacy_plugin_data: &Path) -> Result<Value, NotificationError> {
    let path = home.join("settings.json");
    let sound = effective_sound(&path);
    if let Some(level) = crate::notification_json::level(&path).filter(|v| valid(v)) {
        return Ok(json!({"level":level,"sound":sound}));
    }
    let legacy = legacy_plugin_data.join("settings.json");
    let level = crate::notification_json::level(&legacy)
        .filter(|v| valid(v))
        .unwrap_or_else(|| "important".into());
    write_level(&path, &level)?;
    Ok(json!({"level":level,"sound":sound}))
}

/// Write only the present key(s) and return the effective `{level, sound}`.
/// The non-written field is the effective pre-write value (level `important`,
/// sound `pacer`), computed without a legacy migration, matching TypeScript.
pub fn set(
    home: &Path,
    level: Option<&str>,
    sound: Option<&str>,
) -> Result<Value, NotificationError> {
    if level.is_none() && sound.is_none() {
        return Err(NotificationError::Empty);
    }
    if level.is_some_and(|v| !valid(v)) {
        return Err(NotificationError::InvalidLevel);
    }
    if sound.is_some_and(|v| !valid_sound(v)) {
        return Err(NotificationError::InvalidSound);
    }
    let path = home.join("settings.json");
    // Effective values come from the pre-write file, as in TypeScript.
    let result_level = level.map_or_else(|| effective_level_no_write(&path), str::to_owned);
    let result_sound = sound.map_or_else(|| effective_sound(&path), str::to_owned);
    let mut pairs = Vec::new();
    if let Some(value) = level {
        pairs.push(("notifications", value));
    }
    if let Some(value) = sound {
        pairs.push(("notificationSound", value));
    }
    // One atomic write, so a failure never leaves only one of the two changed.
    write_bytes(
        &path,
        crate::notification_json::settings_keys(&path, &pairs),
    )?;
    Ok(json!({"level":result_level,"sound":result_sound}))
}

pub fn set_level(home: &Path, level: &str) -> Result<Value, NotificationError> {
    set(home, Some(level), None)
}

pub fn set_sound(home: &Path, sound: &str) -> Result<Value, NotificationError> {
    set(home, None, Some(sound))
}
