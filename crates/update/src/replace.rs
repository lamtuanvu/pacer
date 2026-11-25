//! Atomic single-binary and pair replacement, ported from `src/update/replace.ts`.
//!
//! A running process keeps its old inode: the new bytes are staged beside the
//! target, validated, then renamed over it. The old file survives as `<target>.bak`.
use crate::{manifest::ReleaseError, sign};
use std::{
    ffi::OsString,
    fs::{File, OpenOptions, Permissions},
    io::Write,
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{io::AsyncReadExt, process::Command};

#[derive(Debug)]
pub struct ReplaceResult {
    pub path: PathBuf,
    pub backup: PathBuf,
}

#[derive(Debug)]
pub struct PairEntry {
    pub target: PathBuf,
    pub bytes: Vec<u8>,
}

/// The three side effects the replacement transaction needs, injectable for tests.
pub trait Staging {
    /// `<path> --version` stdout, or `""` on failure/timeout after 15 s.
    fn smoke(&self, path: &Path) -> String;
    /// `signStaged`; never fails the update.
    fn sign(&self, path: &Path);
    /// The forward rename used to install a staged file or rotate its backup.
    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()>;
}

pub struct System;

/// `<path> --version` with a 15 s bound and capped output, like the TS `runVersion`.
fn version_output(path: &Path) -> String {
    let Some(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .ok()
    else {
        return String::new();
    };
    runtime.block_on(async {
        let mut child = match Command::new(path)
            .arg("--version")
            .env_remove("BUN_OPTIONS")
            .env_remove("NODE_OPTIONS")
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(_) => return String::new(),
        };
        let mut stdout = match child.stdout.take() {
            Some(out) => out,
            None => return String::new(),
        };
        let result = tokio::time::timeout(Duration::from_secs(15), async {
            let mut bytes = Vec::new();
            (&mut stdout)
                .take(65537)
                .read_to_end(&mut bytes)
                .await
                .ok()?;
            if bytes.len() > 65536 {
                return None;
            }
            child.wait().await.ok()?.success().then_some(bytes)
        })
        .await;
        match result {
            Ok(Some(bytes)) => String::from_utf8_lossy(&bytes).into_owned(),
            _ => {
                let _ = child.kill().await;
                String::new()
            }
        }
    })
}

impl Staging for System {
    fn smoke(&self, path: &Path) -> String {
        version_output(path)
    }

    fn sign(&self, path: &Path) {
        let _ = sign::sign_staged(path);
    }

    fn rename(&self, from: &Path, to: &Path) -> std::io::Result<()> {
        std::fs::rename(from, to)
    }
}

/// `reportsVersion`: the output's whitespace-separated words include the version.
pub fn reports_version(output: &str, version: &str) -> bool {
    output.split_whitespace().any(|word| word == version)
}

fn suffixed(path: &Path, suffix: &str) -> PathBuf {
    let mut name = OsString::from(path.as_os_str());
    name.push(suffix);
    PathBuf::from(name)
}

fn update_id() -> String {
    format!("update-{}", std::process::id())
}

/// Stage bytes next to the target, fsync them and make them executable (0755).
fn stage(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o755)
        .open(path)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    drop(file);
    std::fs::set_permissions(path, Permissions::from_mode(0o755))
}

fn copy_new(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut source = File::open(from)?;
    let mut dest = OpenOptions::new().write(true).create_new(true).open(to)?;
    std::io::copy(&mut source, &mut dest)?;
    Ok(())
}

/// Some filesystems refuse fsync on a directory; the rename is still atomic.
fn fsync_dir(dir: &Path) {
    if let Ok(file) = File::open(dir) {
        let _ = file.sync_all();
    }
}

fn disk_error(error: std::io::Error, dir: &Path, real: &Path) -> ReleaseError {
    match error.raw_os_error() {
        Some(code @ (1 | 13 | 30)) => ReleaseError(format!(
            "cannot write to {} ({code}). Reinstall pacer into a directory you own (install.sh defaults to ~/.local/bin)",
            dir.display()
        )),
        _ => ReleaseError(format!("could not replace {}: {error}", real.display())),
    }
}

/// `replaceBinary`: stage, sign, smoke, rotate the backup, then rename over the target.
pub fn replace_binary(
    target: &Path,
    bytes: &[u8],
    version: &str,
    staging: &dyn Staging,
) -> Result<ReplaceResult, ReleaseError> {
    let real = std::fs::canonicalize(target).map_err(|_| {
        ReleaseError(format!(
            "cannot find the running binary at {}",
            target.display()
        ))
    })?;
    let dir = real.parent().unwrap_or(Path::new("/"));
    let name = real
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| ReleaseError("non-UTF-8 executable path".into()))?;
    let tmp = dir.join(format!(".{name}.{}", update_id()));
    let backup = suffixed(&real, ".bak");
    let backup_tmp = suffixed(&backup, &format!(".{}", update_id()));

    let outcome = (|| -> Result<(), ReleaseError> {
        stage(&tmp, bytes).map_err(|e| disk_error(e, dir, &real))?;
        staging.sign(&tmp);
        let out = staging.smoke(&tmp);
        if !reports_version(&out, version) {
            let shown = out.trim();
            let shown = if shown.is_empty() {
                "none"
            } else {
                &shown[..shown.len().min(200)]
            };
            return Err(ReleaseError(format!(
                "the downloaded binary did not report version {version} when run (output: {shown}); nothing was changed"
            )));
        }
        if std::fs::hard_link(&real, &backup_tmp).is_err() {
            std::fs::copy(&real, &backup_tmp).map_err(|e| disk_error(e, dir, &real))?;
        }
        staging
            .rename(&backup_tmp, &backup)
            .map_err(|e| disk_error(e, dir, &real))?;
        staging
            .rename(&tmp, &real)
            .map_err(|e| disk_error(e, dir, &real))?;
        fsync_dir(dir);
        Ok(())
    })();

    if outcome.is_err() {
        let _ = std::fs::remove_file(&tmp);
        let _ = std::fs::remove_file(&backup_tmp);
    }
    outcome?;
    Ok(ReplaceResult { path: real, backup })
}

struct Entry {
    target: PathBuf,
    bytes: Vec<u8>,
    tmp: PathBuf,
    backup: PathBuf,
    backup_tmp: PathBuf,
    existed: bool,
    staged: bool,
    backed_up: bool,
    installed: bool,
}

/// Run the whole pair transaction; errors are plain strings so the caller can wrap
/// them once with `could not replace pair: `, as `replace.ts` does.
fn install_pair(entries: &mut [Entry], version: &str, staging: &dyn Staging) -> Result<(), String> {
    for entry in entries.iter_mut() {
        stage(&entry.tmp, &entry.bytes).map_err(|e| e.to_string())?;
        entry.staged = true;
    }
    for entry in entries.iter() {
        staging.sign(&entry.tmp);
    }
    for entry in entries.iter() {
        let out = staging.smoke(&entry.tmp);
        if !reports_version(&out, version) {
            let name = entry
                .target
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("binary");
            return Err(format!(
                "the downloaded binary {name} did not report version {version}; nothing was changed"
            ));
        }
    }
    for entry in entries.iter_mut() {
        if !entry.existed {
            continue;
        }
        if std::fs::hard_link(&entry.target, &entry.backup_tmp).is_err() {
            copy_new(&entry.target, &entry.backup_tmp).map_err(|e| e.to_string())?;
        }
        entry.backed_up = true;
        staging
            .rename(&entry.backup_tmp, &entry.backup)
            .map_err(|e| e.to_string())?;
    }
    for entry in entries.iter_mut() {
        staging
            .rename(&entry.tmp, &entry.target)
            .map_err(|e| e.to_string())?;
        entry.installed = true;
        if let Some(dir) = entry.target.parent() {
            fsync_dir(dir);
        }
    }
    Ok(())
}

/// `replacePair`: stage and validate both executables before changing either one.
pub fn replace_pair(
    target: &Path,
    bytes: &[u8],
    companions: &[PairEntry],
    version: &str,
    staging: &dyn Staging,
) -> Result<(ReplaceResult, Vec<ReplaceResult>), ReleaseError> {
    let front = std::fs::canonicalize(target).map_err(|_| {
        ReleaseError(format!(
            "cannot find the running binary at {}",
            target.display()
        ))
    })?;
    let front_dir = front.parent().unwrap_or(Path::new("/"));
    let id = update_id();
    let mut seen = std::collections::HashSet::new();
    let mut entries = Vec::new();
    let all = companions
        .iter()
        .map(|entry| (entry.target.as_path(), entry.bytes.as_slice()))
        .chain(std::iter::once((target, bytes)));

    for (path, data) in all {
        let parent = path.parent().unwrap_or(Path::new("."));
        let real_parent = std::fs::canonicalize(parent)
            .map_err(|e| ReleaseError(format!("could not replace pair: {e}")))?;
        let name = path.file_name().and_then(|n| n.to_str()).ok_or_else(|| {
            ReleaseError("could not replace pair: non-UTF-8 executable path".into())
        })?;
        let resolved = real_parent.join(name);
        if resolved.parent() != Some(front_dir) || !seen.insert(resolved.clone()) {
            return Err(ReleaseError(
                "could not replace pair: pair targets must be distinct siblings of the running binary".into(),
            ));
        }
        let existed = match std::fs::symlink_metadata(&resolved) {
            Ok(meta) if meta.is_file() => true,
            Ok(_) => {
                return Err(ReleaseError(format!(
                    "could not replace pair: pair target is not a regular file: {}",
                    resolved.display()
                )));
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => false,
            Err(e) => return Err(ReleaseError(format!("could not replace pair: {e}"))),
        };
        let backup = suffixed(&resolved, ".bak");
        entries.push(Entry {
            tmp: suffixed(&resolved, ".new"),
            backup_tmp: suffixed(&backup, &format!(".{id}")),
            target: resolved,
            bytes: data.to_vec(),
            backup,
            existed,
            staged: false,
            backed_up: false,
            installed: false,
        });
    }

    let result = install_pair(&mut entries, version, staging);
    if let Err(error) = result {
        let mut rollback_errors = Vec::new();
        for entry in entries.iter_mut().rev() {
            if !entry.installed {
                continue;
            }
            let restored = if entry.existed {
                std::fs::rename(&entry.backup, &entry.target)
            } else {
                std::fs::remove_file(&entry.target)
            };
            match restored {
                Ok(()) => {
                    entry.installed = false;
                    if let Some(dir) = entry.target.parent() {
                        fsync_dir(dir);
                    }
                }
                Err(e) => rollback_errors.push(format!("{}: {e}", entry.target.display())),
            }
        }
        let suffix = if rollback_errors.is_empty() {
            String::new()
        } else {
            format!("; rollback failed: {}", rollback_errors.join("; "))
        };
        // `finally` in `replace.ts`: always tidy staged files and backup temporaries.
        for entry in &entries {
            if entry.staged {
                let _ = std::fs::remove_file(&entry.tmp);
            }
            if entry.backed_up {
                let _ = std::fs::remove_file(&entry.backup_tmp);
            }
        }
        return Err(ReleaseError(format!(
            "could not replace pair: {error}{suffix}"
        )));
    }

    let companion_results = entries[..entries.len() - 1]
        .iter()
        .map(|entry| ReplaceResult {
            path: entry.target.clone(),
            backup: entry.backup.clone(),
        })
        .collect();
    let front_result = ReplaceResult {
        path: front,
        backup: suffixed(&entries[entries.len() - 1].target, ".bak"),
    };
    // The `finally` block of `replace.ts`: tidy staged files and backup temporaries.
    for entry in &entries {
        if entry.staged {
            let _ = std::fs::remove_file(&entry.tmp);
        }
        if entry.backed_up {
            let _ = std::fs::remove_file(&entry.backup_tmp);
        }
    }
    Ok((front_result, companion_results))
}
