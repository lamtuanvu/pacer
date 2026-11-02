//! Notification setting writes. Config-change publication remains with the caller.

use serde_json::{Value, json};
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

fn write_settings(path: &Path, level: &str) -> io::Result<()> {
    let bytes = crate::notification_json::settings(path, level);
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

/// Read the effective level; an absent or invalid primary level is copied from
/// the legacy plugin setting, or initialized to `important`, as in TypeScript.
pub fn get_level(home: &Path, legacy_plugin_data: &Path) -> Result<Value, NotificationError> {
    let path = home.join("settings.json");
    if let Some(level) = crate::notification_json::level(&path).filter(|v| valid(v)) {
        return Ok(json!({"level":level}));
    }
    let legacy = legacy_plugin_data.join("settings.json");
    let level = crate::notification_json::level(&legacy)
        .filter(|v| valid(v))
        .unwrap_or_else(|| "important".into());
    write_settings(&path, &level)?;
    Ok(json!({"level":level}))
}

pub fn set_level(home: &Path, level: &str) -> Result<Value, NotificationError> {
    if !valid(level) {
        return Err(NotificationError::InvalidLevel);
    }
    let path = home.join("settings.json");
    write_settings(&path, level)?;
    Ok(json!({"level":level}))
}
