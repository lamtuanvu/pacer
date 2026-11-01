//! Persisted `session.*` JSON shapes and retention names. ANSI remains opaque.
use serde::{Deserialize, Serialize};
use std::{fs, io, path::Path};

/// Write a complete replacement beside `path`, then publish it in one rename.
/// A failed writer leaves the previous destination intact and drops the temp file.
pub fn atomic_replace_with(
    path: &Path,
    write: impl FnOnce(&mut fs::File) -> io::Result<()>,
) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("missing parent directory"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    let mut temp = tempfile::Builder::new()
        .prefix(".session-")
        .suffix(".tmp")
        .tempfile_in(parent)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        temp.as_file()
            .set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    write(temp.as_file_mut())?;
    temp.persist(path).map_err(|error| error.error)?;
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionLaunch {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interaction_mode: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion_nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub takeover: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interactive: Option<bool>,
    pub argv: Vec<String>,
    pub cwd: String,
    #[serde(
        skip_serializing_if = "Option::is_none",
        default,
        deserialize_with = "crate::json_number::optional_u64_safe"
    )]
    pub cap_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pacer_home: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub keep_color: Option<Vec<String>>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SessionState {
    #[serde(deserialize_with = "crate::json_number::u64_safe")]
    pub viewers: u64,
    pub controller: Option<String>,
    #[serde(deserialize_with = "crate::json_number::u32_value")]
    pub cols: u32,
    #[serde(deserialize_with = "crate::json_number::u32_value")]
    pub rows: u32,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Checkpoint {
    #[serde(deserialize_with = "crate::json_number::u64_safe")]
    pub generation: u64,
    #[serde(deserialize_with = "crate::json_number::u64_safe")]
    pub output_offset: u64,
    #[serde(deserialize_with = "crate::json_number::u32_value")]
    pub cols: u32,
    #[serde(deserialize_with = "crate::json_number::u32_value")]
    pub rows: u32,
    pub scrollback_ansi: String,
    pub screen_ansi: String,
    pub modes: serde_json::Map<String, serde_json::Value>,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Names removed for terminal tasks; stdout/stderr/exit are deliberately retained.
pub const PRUNED_SESSION_ARTIFACTS: &[&str] = &[
    "session.state",
    "session.state.tmp",
    "session.activity",
    "session.log",
    "session.log.1",
    "session.ckpt",
    "session.ckpt.tmp",
    "session.sock.path",
    "session.host",
    "session.version",
    "session.json",
];

pub fn retention_due(terminal: bool, now: f64, settled: f64, days: f64) -> bool {
    terminal && now - settled > days * 86_400.0
}
