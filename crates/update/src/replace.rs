//! Verified binary replacement, ported from `src/update/replace.ts`. A new binary
//! is staged next to the running one, signed and smoke-checked, then swapped in by
//! rename so the running process keeps its old inode. The pair variant stages and
//! validates both binaries before changing either, with rollback on failure.
use crate::{manifest::ReleaseError, sign};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{self, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    time::Duration,
};
use tokio::io::AsyncReadExt;

const EPERM: i32 = 1;
const EACCES: i32 = 13;
const EROFS: i32 = 30;

/// Where the replacement was installed and the previous binary kept.
#[derive(Debug)]
pub struct ReplaceResult {
    pub path: PathBuf,
    pub backup: PathBuf,
}

/// One companion binary to install alongside the front door.
pub struct PairEntry {
    pub target: PathBuf,
    pub bytes: Vec<u8>,
}

/// Injectable signing, smoke and rename, like TypeScript's `sign`, `smoke` and `rename`.
pub trait Staging {
    /// `<path> --version` stdout, or "" on failure, bounded to 15 seconds.
    fn smoke(&self, path: &Path) -> String;
    /// `signStaged`: never fails the update; a failure leaves an ad hoc signed file.
    fn sign(&self, path: &Path);
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;
}

/// The real filesystem/process implementation of [`Staging`].
pub struct System;
impl Staging for System {
    fn smoke(&self, path: &Path) -> String {
        run_version(path)
    }
    fn sign(&self, path: &Path) {
        let _ = sign::sign_staged(path);
    }
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        fs::rename(from, to)
    }
}

/// `runVersion`: stdout of `<path> --version` when it exits zero, else "".
pub fn run_version(path: &Path) -> String {
    let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
    else {
        return String::new();
    };
    runtime.block_on(async {
        let mut child = match tokio::process::Command::new(path)
            .arg("--version")
            .env_remove("BUN_OPTIONS")
            .env_remove("NODE_OPTIONS")
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::null())
            .kill_on_drop(true)
            .spawn()
        {
            Ok(child) => child,
            Err(_) => return String::new(),
        };
        let Some(mut stdout) = child.stdout.take() else {
            return String::new();
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

/// `reportsVersion`: the version is any whitespace-delimited word of the output.
pub fn reports_version(output: &str, version: &str) -> bool {
    output.trim().split_whitespace().any(|word| word == version)
}

fn suffix(path: &Path, text: &str) -> PathBuf {
    let mut value = path.as_os_str().to_os_string();
    value.push(text);
    PathBuf::from(value)
}

fn write_staged(file: &mut File, bytes: &[u8]) -> io::Result<()> {
    file.write_all(bytes)?;
    file.sync_all()
}

fn copy_new(from: &Path, to: &Path) -> io::Result<()> {
    let mut source = File::open(from)?;
    let mut target = OpenOptions::new().write(true).create_new(true).open(to)?;
    io::copy(&mut source, &mut target)?;
    target.sync_all()
}

fn fsync_dir(dir: &Path) {
    // Some filesystems refuse fsync on a directory; the rename is still atomic.
    if let Ok(file) = File::open(dir) {
        let _ = file.sync_all();
    }
}

fn permission_code(error: &io::Error) -> Option<&'static str> {
    match error.raw_os_error() {
        Some(EACCES) => Some("EACCES"),
        Some(EPERM) => Some("EPERM"),
        Some(EROFS) => Some("EROFS"),
        _ => None,
    }
}

fn single_error(real: &Path, dir: &Path, error: io::Error) -> ReleaseError {
    if let Some(code) = permission_code(&error) {
        ReleaseError(format!(
            "cannot write to {} ({code}). Reinstall pacer into a directory you own (install.sh defaults to ~/.local/bin)",
            dir.display()
        ))
    } else {
        ReleaseError(format!("could not replace {}: {error}", real.display()))
    }
}

fn pair_error(error: io::Error) -> ReleaseError {
    ReleaseError(error.to_string())
}

fn version_failure(label: &str, version: &str, output: &str) -> ReleaseError {
    let shown: String = output.trim().chars().take(200).collect();
    ReleaseError(format!(
        "{label} did not report version {version} when run (output: {}); nothing was changed",
        if shown.is_empty() { "none" } else { &shown }
    ))
}

/// `replaceBinary`: stage, verify and atomically swap a single executable.
pub fn replace_binary(
    target: &Path,
    bytes: &[u8],
    version: &str,
    staging: &dyn Staging,
) -> Result<ReplaceResult, ReleaseError> {
    let real = fs::canonicalize(target).map_err(|_| {
        ReleaseError(format!(
            "cannot find the running binary at {}",
            target.display()
        ))
    })?;
    let dir = real
        .parent()
        .ok_or_else(|| ReleaseError("executable has no parent".into()))?;
    let pid = std::process::id();
    let name = real.file_name().unwrap_or_default().to_string_lossy();
    let tmp = dir.join(format!(".{name}.update-{pid}"));
    let backup = suffix(&real, ".bak");
    let backup_tmp = suffix(&backup, &format!(".update-{pid}"));

    let result = (|| -> Result<ReplaceResult, ReleaseError> {
        let mut out = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o755)
            .open(&tmp)
            .map_err(|e| single_error(&real, dir, e))?;
        write_staged(&mut out, bytes).map_err(|e| single_error(&real, dir, e))?;
        drop(out);
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o755))
            .map_err(|e| single_error(&real, dir, e))?;
        staging.sign(&tmp);
        let output = staging.smoke(&tmp);
        if !reports_version(&output, version) {
            return Err(version_failure("the downloaded binary", version, &output));
        }
        if fs::hard_link(&real, &backup_tmp).is_err() {
            copy_new(&real, &backup_tmp).map_err(|e| single_error(&real, dir, e))?;
        }
        staging
            .rename(&backup_tmp, &backup)
            .map_err(|e| single_error(&real, dir, e))?;
        staging
            .rename(&tmp, &real)
            .map_err(|e| single_error(&real, dir, e))?;
        fsync_dir(dir);
        Ok(ReplaceResult {
            path: real.clone(),
            backup: backup.clone(),
        })
    })();

    if result.is_err() {
        let _ = fs::remove_file(&tmp);
        let _ = fs::remove_file(&backup_tmp);
    }
    result
}

/// `replacePair`: stage/sign/smoke both binaries, then install both with rollback.
pub fn replace_pair(
    target: &Path,
    bytes: &[u8],
    companions: &[PairEntry],
    version: &str,
    staging: &dyn Staging,
) -> Result<(ReplaceResult, Vec<ReplaceResult>), ReleaseError> {
    let front = fs::canonicalize(target).map_err(|_| {
        ReleaseError(format!(
            "cannot find the running binary at {}",
            target.display()
        ))
    })?;
    let dir = front
        .parent()
        .ok_or_else(|| ReleaseError("executable has no parent".into()))?;
    let pid = std::process::id();

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
    let mut specs: Vec<(PathBuf, Vec<u8>)> = companions
        .iter()
        .map(|entry| (entry.target.clone(), entry.bytes.clone()))
        .collect();
    specs.push((front.clone(), bytes.to_vec()));
    let mut entries: Vec<Entry> = Vec::new();
    for (given, data) in specs {
        let parent = fs::canonicalize(given.parent().unwrap_or(dir)).map_err(pair_error)?;
        let resolved = parent.join(given.file_name().unwrap_or_default());
        let backup = suffix(&resolved, ".bak");
        entries.push(Entry {
            tmp: suffix(&resolved, ".new"),
            backup_tmp: suffix(&backup, &format!(".update-{pid}")),
            target: resolved,
            bytes: data,
            backup,
            existed: false,
            staged: false,
            backed_up: false,
            installed: false,
        });
    }

    // Validation happens before the transaction, like TypeScript's pre-flight loop.
    let mut paths = BTreeSet::new();
    for entry in &mut entries {
        if entry.target.parent() != Some(dir) || !paths.insert(entry.target.clone()) {
            return Err(ReleaseError(
                "pair targets must be distinct siblings of the running binary".into(),
            ));
        }
        match fs::symlink_metadata(&entry.target) {
            Ok(meta) if meta.is_file() => entry.existed = true,
            Ok(_) => {
                return Err(ReleaseError(format!(
                    "pair target is not a regular file: {}",
                    entry.target.display()
                )));
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(pair_error(e)),
        }
    }

    let outcome = (|| -> Result<(), ReleaseError> {
        for entry in &mut entries {
            let mut out = OpenOptions::new()
                .write(true)
                .create_new(true)
                .mode(0o755)
                .open(&entry.tmp)
                .map_err(pair_error)?;
            entry.staged = true;
            write_staged(&mut out, &entry.bytes).map_err(pair_error)?;
        }
        for entry in &entries {
            staging.sign(&entry.tmp);
        }
        for entry in &entries {
            let output = staging.smoke(&entry.tmp);
            if !reports_version(&output, version) {
                let name = entry
                    .target
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy();
                return Err(version_failure(
                    &format!("the downloaded binary {name}"),
                    version,
                    &output,
                ));
            }
        }
        for entry in &mut entries {
            if !entry.existed {
                continue;
            }
            if fs::hard_link(&entry.target, &entry.backup_tmp).is_err() {
                copy_new(&entry.target, &entry.backup_tmp).map_err(pair_error)?;
            }
            entry.backed_up = true;
            staging
                .rename(&entry.backup_tmp, &entry.backup)
                .map_err(pair_error)?;
        }
        for entry in &mut entries {
            staging
                .rename(&entry.tmp, &entry.target)
                .map_err(pair_error)?;
            entry.installed = true;
            fsync_dir(entry.target.parent().unwrap_or(dir));
        }
        Ok(())
    })();

    let failed = outcome.is_err();
    let result = match outcome {
        Ok(()) => {
            let companions = entries[..entries.len() - 1]
                .iter()
                .map(|entry| ReplaceResult {
                    path: entry.target.clone(),
                    backup: entry.backup.clone(),
                })
                .collect();
            Ok((
                ReplaceResult {
                    path: front.clone(),
                    backup: suffix(&front, ".bak"),
                },
                companions,
            ))
        }
        Err(error) => {
            let mut rollback_errors = Vec::new();
            for entry in entries.iter().rev() {
                if !entry.installed {
                    continue;
                }
                let rolled_back = if entry.existed {
                    fs::rename(&entry.backup, &entry.target)
                } else {
                    fs::remove_file(&entry.target)
                };
                match rolled_back {
                    Ok(()) => fsync_dir(entry.target.parent().unwrap_or(dir)),
                    Err(e) => rollback_errors.push(format!("{}: {e}", entry.target.display())),
                }
            }
            let mut message = format!("could not replace pair: {}", error.0);
            if !rollback_errors.is_empty() {
                message.push_str(&format!(
                    "; rollback failed: {}",
                    rollback_errors.join("; ")
                ));
            }
            Err(ReleaseError(message))
        }
    };

    if failed {
        // Mirror `replace.ts:163-168`: clean staged files, then backup temporaries.
        for entry in &entries {
            if entry.staged {
                let _ = fs::remove_file(&entry.tmp);
            }
        }
        for entry in &entries {
            if entry.backed_up {
                let _ = fs::remove_file(&entry.backup_tmp);
            }
        }
    }
    result
}
