#![allow(clippy::unwrap_used)]
//! Fresh-helper command cleanup tests (transcribed from
//! `src/update/desktop/native-command-cleanup.ts`): the exact
//! remove-if-gone debug. Cleanup must only remove the freshly installed
//! single-helper command directory once the spawned child is gone, the
//! directory still holds exactly that helper, and neither changed.
use super::super::cleanup::fresh_helper_cleanup;
use crate::record::NativeProcess;

use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};

fn process(pid: u32) -> NativeProcess {
    NativeProcess {
        pid,
        boot_id: "boot-one".to_owned(),
        birth: "1:1".to_owned(),
    }
}

fn write_private(path: &Path, bytes: &[u8]) {
    std::fs::write(path, bytes).unwrap();
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).unwrap();
}

/// A private command directory containing only the original helper.
struct Fx {
    _dir: tempfile::TempDir,
    helper: PathBuf,
    dir: PathBuf,
}

fn fixture() -> Fx {
    let dir = tempfile::tempdir().unwrap();
    let home = std::fs::canonicalize(dir.path()).unwrap();
    let cwd = home.join("desktop-updates").join("native").join("fixture");
    for d in [
        &home,
        &home.join("desktop-updates"),
        &home.join("desktop-updates").join("native"),
        &cwd,
    ] {
        std::fs::create_dir_all(d).unwrap();
        std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let cmd = cwd.join("commands").join("cmd-1");
    std::fs::create_dir_all(&cmd).unwrap();
    std::fs::set_permissions(&cmd, std::fs::Permissions::from_mode(0o700)).unwrap();
    let helper = cmd.join("pacer-update-helper");
    write_private(&helper, b"helper-fixture");
    Fx {
        _dir: dir,
        helper,
        dir: cmd,
    }
}

fn gone(_pid: u32) -> Option<NativeProcess> {
    None
}

#[test]
fn removes_the_fresh_helper_once_the_child_is_gone() {
    let f = fixture();
    let cleanup = fresh_helper_cleanup(f.helper.clone(), process(3), gone);
    assert!(f.helper.exists());
    cleanup();
    assert!(
        !f.helper.exists(),
        "helper must be removed when the child is gone"
    );
    assert!(
        !f.dir.exists(),
        "the now-empty command directory must be removed"
    );
}

#[test]
fn leaves_the_helper_while_the_child_is_still_live() {
    let f = fixture();
    // The child is still observable exactly as bound: cleanup must not
    // touch the live helper's assets.
    fn live(pid: u32) -> Option<NativeProcess> {
        Some(process(pid))
    }
    let cleanup = fresh_helper_cleanup(f.helper.clone(), process(3), live);
    cleanup();
    assert!(f.helper.exists());
    assert!(f.dir.exists());
}

#[test]
fn leaves_assets_when_the_directory_holds_extra_file() {
    let f = fixture();
    let extra = f.dir.join("junk");
    write_private(&extra, b"junk");
    let cleanup = fresh_helper_cleanup(f.helper.clone(), process(3), gone);
    cleanup();
    assert!(f.helper.exists(), "extra content means not exactly fresh");
    assert!(f.dir.exists());
}

#[test]
fn leaves_assets_for_a_non_helper_name_or_changed_helper() {
    // A non-helper name is never a fresh-helper cleanup target.
    let f = fixture();
    let other = f.dir.join("not-helper");
    write_private(&other, b"other");
    let cleanup = fresh_helper_cleanup(other.clone(), process(3), gone);
    cleanup();
    assert!(f.dir.exists());

    // A helper changed after cleanup was armed (different bytes) is not
    // removed: cleanup binds the freshly installed bytes at creation time.
    let f2 = fixture();
    let cleanup2 = fresh_helper_cleanup(f2.helper.clone(), process(3), gone);
    write_private(&f2.helper, b"changed");
    cleanup2();
    assert!(f2.helper.exists());
}
