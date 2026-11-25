//! Exact fresh-command asset cleanup (port of
//! `src/update/desktop/native-command-cleanup.ts`).
//!
//! Transaction and recovery assets never enter this API. `fresh_helper_cleanup`
//! returns a closure that removes a freshly installed helper command directory
//! only when the child that was born from it is gone, the directory holds
//! exactly the original helper, and neither the directory nor the helper has
//! changed since launch. Any ambiguity leaves the assets in place — cleanup
//! must never broaden or change an update outcome.
//!
//! The `child` is the verified helper process the caller launched; `observe`
//! re-reads the live process table (a stub that returns `None` when the child
//! cannot be observed re-validates against the recorded identity).
#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

use std::fs;
use std::io::Read;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::record::NativeProcess;
use sha2::{Digest, Sha256};

/// `inspect`: bounded fingerprint of a single-link private regular file.
/// Returns `(dev, ino, sha256)`. The file must be single-link 0600-owned
/// with no symlink following and no size divergence between hash and stat.
fn inspect(path: &Path) -> Option<(u64, u64, String)> {
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
        .ok()?;
    let before = file.metadata().ok()?;
    let uid = nix::unistd::getuid().as_raw();
    if !before.is_file()
        || before.nlink() != 1
        || before.uid() != uid
        || before.mode() & 0o077 != 0
        || before.len() > 128 * 1024 * 1024
    {
        return None;
    }
    let mut buf = [0u8; 65536];
    let mut read = 0usize;
    let mut state = Sha256::new();
    let mut file = file.take(128 * 1024 * 1024 + 1);
    loop {
        let n = file.read(&mut buf).ok()?;
        if n == 0 {
            break;
        }
        read += n;
        if read > 128 * 1024 * 1024 {
            return None;
        }
        state.update(&buf[..n]);
    }
    let after = fs::symlink_metadata(path).ok()?;
    if after.dev() != before.dev()
        || after.ino() != before.ino()
        || after.len() != before.len()
        || after.mtime() != before.mtime()
        || after.ctime() != before.ctime()
    {
        return None;
    }
    let hash = format!("{:x}", state.finalize());
    Some((before.dev(), before.ino(), hash))
}

/// `sameProcess`: bind a live observation to the recorded helper identity.
fn same_process(a: &NativeProcess, b: &NativeProcess) -> bool {
    a.pid == b.pid && a.boot_id == b.boot_id && a.birth == b.birth
}

/// Return a closure that performs the exact fresh-helper command cleanup
/// described by `freshHelperCleanup`. The closure is idempotent and never
/// throws: ambiguity or change leaves the assets behind.
pub fn fresh_helper_cleanup(
    path: impl Into<PathBuf>,
    child: NativeProcess,
    observe: fn(pid: u32) -> Option<NativeProcess>,
) -> Box<dyn Fn()> {
    let path = path.into();
    let dir = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let name = match path.file_name().and_then(|n| n.to_str()) {
        Some(name) => name.to_owned(),
        None => return Box::new(move || {}),
    };
    let noop: fn() = || {};
    let directory = match fs::symlink_metadata(&dir) {
        Ok(meta) => meta,
        Err(_) => return Box::new(noop),
    };
    let asset = match inspect(&path) {
        Some(asset) => asset,
        None => return Box::new(noop),
    };
    let uid = nix::unistd::getuid().as_raw();
    if name != "pacer-update-helper"
        || fs::canonicalize(&dir).ok().as_deref() != Some(dir.as_path())
        || !directory.is_dir()
        || directory.file_type().is_symlink()
        || directory.uid() != uid
        || directory.mode() & 0o077 != 0
    {
        // Ambiguous command directory: do nothing now or later.
        return Box::new(noop);
    }
    let dir_dev = directory.dev();
    let dir_ino = directory.ino();
    let dir_uid = directory.uid();
    let (plist_dev, plist_ino, plist_hash) = (asset.0, asset.1, Arc::new(asset.2));
    let dir = Arc::new(dir);
    let helper = Arc::new(path.clone());
    Box::new(move || {
        // 1. If the child still exists exactly as bound, the helper is live.
        if observe(child.pid).is_some_and(|live| same_process(&child, &live)) {
            return;
        }
        // 2. The directory must still be the same private directory.
        let now = match fs::symlink_metadata(dir.as_ref()) {
            Ok(meta) => meta,
            Err(_) => return,
        };
        if !now.is_dir()
            || now.file_type().is_symlink()
            || now.uid() != dir_uid
            || now.dev() != dir_dev
            || now.ino() != dir_ino
            || now.mode() & 0o077 != 0
            || fs::canonicalize(dir.as_ref()).ok().as_deref() != Some(dir.as_ref().as_path())
        {
            return;
        }
        // 3. The directory must contain exactly the original helper.
        let mut entries = match fs::read_dir(dir.as_ref()) {
            Ok(entries) => entries,
            Err(_) => return,
        };
        let Some(Ok(first)) = entries.next() else {
            return;
        };
        if first.file_name().to_str() != Some(name.as_str()) || entries.next().is_some() {
            return;
        }
        // 4. The helper asset must be unchanged and still single-link.
        let Some((dev, ino, hash)) = inspect(helper.as_ref()) else {
            return;
        };
        if dev != plist_dev || ino != plist_ino || hash != plist_hash.as_str() {
            return;
        }
        let last = match fs::symlink_metadata(helper.as_ref()) {
            Ok(meta) => meta,
            Err(_) => return,
        };
        if last.dev() != plist_dev || last.ino() != plist_ino || last.file_type().is_symlink() {
            return;
        }
        // 5. Exact: unlink the helper then the now-empty directory.
        let _ = fs::remove_file(helper.as_ref());
        let _ = fs::remove_dir(dir.as_ref());
    })
}

#[cfg(test)]
#[path = "tests/cleanup.rs"]
mod tests;
