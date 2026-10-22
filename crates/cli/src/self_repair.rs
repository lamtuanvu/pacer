//! Verified, bounded installation of the core belonging to this front door's version.
mod download;
mod process;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Debug, thiserror::Error)]
pub enum RepairError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("invalid release: {0}")]
    Invalid(String),
    #[error("release download failed: {0}")]
    Download(String),
}

pub fn core_version(core: &Path) -> Option<String> {
    let bytes = process::output(core, &["--version"], 5)?;
    let text = std::str::from_utf8(&bytes).ok()?;
    let mut words = text.split_whitespace();
    if words.next()? != "pacer" {
        return None;
    }
    let version = words.next()?.to_owned();
    words.next().is_none().then_some(version)
}

struct Stage(PathBuf);
impl Drop for Stage {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn stage(dir: &Path, prefix: &str, mode: u32) -> Result<(Stage, File), RepairError> {
    for n in 0..100 {
        let tick = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let path = dir.join(format!(".{prefix}-{}-{tick}-{n}", std::process::id()));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&path)
        {
            Ok(file) => return Ok((Stage(path), file)),
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    Err(RepairError::Invalid("cannot allocate staged core".into()))
}

fn target_ok(core: &Path) -> Result<(), RepairError> {
    match fs::symlink_metadata(core) {
        Ok(meta) if !meta.file_type().is_file() => Err(RepairError::Invalid(
            "pacer-core must be a regular file".into(),
        )),
        Ok(_) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

pub fn repair(exe: &Path, version: &str, base: &str) -> Result<PathBuf, RepairError> {
    let dir = exe
        .parent()
        .ok_or_else(|| RepairError::Invalid("executable has no parent".into()))?;
    let core = dir.join("pacer-core");
    target_ok(&core)?;
    // The descriptor lock releases even on process failure. Never remove its inode while locked.
    let lock_path = dir.join(".pacer-core-repair.lock");
    if fs::symlink_metadata(&lock_path).is_ok_and(|m| !m.file_type().is_file()) {
        return Err(RepairError::Invalid(
            "repair lock must be a regular file".into(),
        ));
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .open(lock_path)?;
    lock.try_lock()
        .map_err(|e| RepairError::Invalid(format!("another core repair is running: {e}")))?;
    if core_version(&core).as_deref() == Some(version) {
        return Ok(core);
    }
    // Probe/stage before contacting the network, so unwritable installs fail locally.
    let (staged, mut file) = stage(dir, "pacer-core", 0o700)?;
    let deadline = Instant::now() + Duration::from_secs(60);
    let manifest = download::fetch(
        download::release_url(base, version, "manifest.json")?,
        256 * 1024,
        deadline,
    )?;
    let value: serde_json::Value =
        serde_json::from_slice(&manifest).map_err(|e| RepairError::Invalid(e.to_string()))?;
    if value["version"].as_str() != Some(version) {
        return Err(RepairError::Invalid(
            "manifest version differs from front door".into(),
        ));
    }
    let os = if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let assets = value["assets"]
        .as_array()
        .ok_or_else(|| RepairError::Invalid("manifest has no assets".into()))?;
    let matching: Vec<_> = assets
        .iter()
        .filter(|a| a["os"] == os && a["arch"] == arch)
        .collect();
    if matching.len() != 1 {
        return Err(RepairError::Invalid(
            "manifest must contain exactly one host asset".into(),
        ));
    }
    let companions = matching[0]["companions"]
        .as_array()
        .ok_or_else(|| RepairError::Invalid("manifest has no core companion".into()))?;
    let expected_file = format!("pacer-core-{os}-{arch}");
    if companions.len() != 1
        || companions[0]["name"] != "pacer-core"
        || companions[0]["file"] != expected_file
    {
        return Err(RepairError::Invalid(
            "manifest core companion has an invalid name or file".into(),
        ));
    }
    let companion = &companions[0];
    let size = companion["size"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= 200 * 1024 * 1024)
        .ok_or_else(|| RepairError::Invalid("invalid core size (maximum 200 MB)".into()))?;
    let hash = companion["sha256"]
        .as_str()
        .filter(|h| {
            h.len() == 64
                && h.bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
        .ok_or_else(|| RepairError::Invalid("invalid core checksum".into()))?;
    let bytes = download::fetch(
        download::release_url(base, version, &expected_file)?,
        size,
        deadline,
    )?;
    if bytes.len() as u64 != size || format!("{:x}", Sha256::digest(&bytes)) != hash {
        return Err(RepairError::Invalid(
            "core size or checksum mismatch".into(),
        ));
    }
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    process::sign(&staged.0)?;
    fs::set_permissions(&staged.0, fs::Permissions::from_mode(0o755))?;
    if core_version(&staged.0).as_deref() != Some(version) {
        return Err(RepairError::Invalid("core version smoke failed".into()));
    }
    target_ok(&core)?;
    fs::rename(&staged.0, &core)?;
    File::open(dir)?.sync_all()?;
    Ok(core)
}

fn fingerprint(path: &Path) -> Option<serde_json::Value> {
    let meta = fs::metadata(path).ok()?;
    Some(serde_json::json!([
        meta.dev(),
        meta.ino(),
        meta.len(),
        meta.mtime(),
        meta.mtime_nsec(),
        meta.ctime(),
        meta.ctime_nsec()
    ]))
}

fn cached(path: &Path) -> Option<serde_json::Value> {
    let mut bytes = Vec::new();
    File::open(path)
        .ok()?
        .take(16385)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 16384 {
        return None;
    }
    serde_json::from_slice(&bytes).ok()
}

/// Cache only a successful version check, and invalidate it when the executable changes.
pub fn is_current(core: &Path, version: &str, env: &HashMap<String, String>) -> bool {
    let home = env
        .get("PACER_HOME")
        .map(PathBuf::from)
        .or_else(|| env.get("HOME").map(|h| PathBuf::from(h).join(".pacer")));
    let cache = home.map(|h| h.join("run/core-version.json"));
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let signature = fingerprint(core);
    if let (Some(path), Some(signature)) = (&cache, &signature)
        && let Some(v) = cached(path)
        && v["version"] == version
        && v["core"] == core.to_string_lossy().as_ref()
        && v["file"] == *signature
        && v["checked"]
            .as_u64()
            .is_some_and(|t| t <= now && now - t < 3600)
    {
        return true;
    }
    if core_version(core).as_deref() != Some(version) {
        return false;
    }
    if let (Some(path), Some(signature)) = (cache, signature) {
        let _ = (|| -> Result<(), RepairError> {
            let Some(dir) = path.parent() else {
                return Ok(());
            };
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(dir)?;
            let (temp, mut file) = stage(dir, "core-version", 0o600)?;
            let data =
                serde_json::json!({"version":version,"core":core,"file":signature,"checked":now});
            file.write_all(data.to_string().as_bytes())?;
            file.sync_all()?;
            fs::rename(&temp.0, path)?;
            Ok(())
        })();
    }
    true
}
