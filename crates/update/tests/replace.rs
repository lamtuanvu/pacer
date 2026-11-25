//! Transcribed from `test/update-replace.test.ts:108-311` (replacement half).
#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_update::replace::{
    PairEntry, Staging, System, replace_binary, replace_pair, reports_version,
};
use std::{
    cell::RefCell,
    fs, io,
    os::unix::fs::{MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
};

const SCRIPT_010: &str = "#!/bin/sh\necho \"pacer 0.1.0\"\n";

fn script(v: &str) -> String {
    format!("#!/bin/sh\necho \"pacer {v}\"\n")
}

fn installed(dir: &Path, version: &str) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    let path = dir.join("pacer");
    fs::write(&path, script(version)).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

/// The injectable side effects of `replace.ts` (`smoke`, `sign`, `rename`).
#[derive(Default)]
struct Fake {
    output: String,
    events: RefCell<Vec<(&'static str, PathBuf)>>,
    renames: RefCell<Vec<(PathBuf, PathBuf)>>,
    fail_rename_to: Option<PathBuf>,
}

impl Fake {
    fn reporting(output: &str) -> Self {
        Self {
            output: output.into(),
            ..Default::default()
        }
    }

    fn failing_rename_to(mut self, to: &Path) -> Self {
        self.fail_rename_to = Some(to.to_path_buf());
        self
    }
}

impl Staging for Fake {
    fn smoke(&self, path: &Path) -> String {
        self.events.borrow_mut().push(("smoke", path.to_path_buf()));
        self.output.clone()
    }

    fn sign(&self, path: &Path) {
        self.events.borrow_mut().push(("sign", path.to_path_buf()));
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.renames
            .borrow_mut()
            .push((from.to_path_buf(), to.to_path_buf()));
        if self.fail_rename_to.as_deref() == Some(to) {
            return Err(io::Error::other("rename failed"));
        }
        fs::rename(from, to)
    }
}

#[test]
fn run_version_and_reports_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(dir.path(), "0.2.0");
    assert_eq!(System.smoke(&path).trim(), "pacer 0.2.0");
    assert_eq!(System.smoke(&dir.path().join("missing")), "");
    assert!(reports_version("pacer 0.2.0\n", "0.2.0"));
    assert!(!reports_version("pacer 0.2.0-rc.1", "0.2.0"));
    assert!(!reports_version("", "0.2.0"));
}

#[test]
fn run_version_rejects_nonzero_exit() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(dir.path(), "0.1.0");
    fs::write(&path, format!("{SCRIPT_010}exit 1\n")).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(System.smoke(&path), "");
}

#[test]
fn replace_binary_never_writes_the_running_inode() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    let path = installed(&bin, "0.1.0");
    let running = fs::metadata(&path).unwrap().ino();
    replace_binary(
        &path,
        script("0.2.0").as_bytes(),
        "0.2.0",
        &Fake::reporting("pacer 0.2.0"),
    )
    .unwrap();
    assert_ne!(fs::metadata(&path).unwrap().ino(), running);
    let backup = format!("{}.bak", path.display());
    assert_eq!(fs::metadata(&backup).unwrap().ino(), running);
    assert_eq!(fs::read_to_string(&backup).unwrap(), SCRIPT_010);
}

#[test]
fn replace_binary_swaps_atomically_and_keeps_bak() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    let path = installed(&bin, "0.1.0");
    fs::write(format!("{}.bak", path.display()), "an older backup").unwrap();
    let result = replace_binary(
        &path,
        script("0.2.0").as_bytes(),
        "0.2.0",
        &Fake::reporting("pacer 0.2.0"),
    )
    .unwrap();
    assert_eq!(result.path, fs::canonicalize(&path).unwrap());
    assert_eq!(
        result.backup,
        PathBuf::from(format!("{}.bak", result.path.display()))
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), script("0.2.0"));
    assert_eq!(fs::read_to_string(&result.backup).unwrap(), SCRIPT_010);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o755
    );
    let mut names: Vec<_> = fs::read_dir(&bin)
        .unwrap()
        .map(|e| e.unwrap().file_name().into_string().unwrap())
        .collect();
    names.sort();
    assert_eq!(names, ["pacer", "pacer.bak"]);
}

#[test]
fn replace_binary_follows_a_symlink() {
    let root = tempfile::tempdir().unwrap();
    let real = installed(&root.path().join("opt"), "0.1.0");
    let link = root.path().join("bin/pacer");
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    symlink(&real, &link).unwrap();
    let result = replace_binary(
        &link,
        script("0.2.0").as_bytes(),
        "0.2.0",
        &Fake::reporting("pacer 0.2.0"),
    )
    .unwrap();
    assert_eq!(result.path, fs::canonicalize(&real).unwrap());
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_to_string(&real).unwrap(), script("0.2.0"));
    assert_eq!(
        fs::read_to_string(format!("{}.bak", real.display())).unwrap(),
        SCRIPT_010
    );
}

#[test]
fn wrong_version_is_not_installed() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    let path = installed(&bin, "0.1.0");
    let err = replace_binary(
        &path,
        script("0.0.9").as_bytes(),
        "0.2.0",
        &Fake::reporting("pacer 0.0.9"),
    )
    .unwrap_err();
    assert!(err.0.contains("did not report version 0.2.0"), "{}", err.0);
    assert_eq!(fs::read_to_string(&path).unwrap(), SCRIPT_010);
    assert_eq!(fs::read_dir(&bin).unwrap().count(), 1);
}

#[test]
fn non_permission_failures_are_release_errors() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    let path = installed(&bin, "0.1.0");
    // A directory at the staged name makes `create_new` fail with EEXIST, not EACCES.
    let staged = bin.join(format!(".pacer.update-{}", std::process::id()));
    fs::create_dir(&staged).unwrap();
    let err = replace_binary(
        &path,
        script("0.2.0").as_bytes(),
        "0.2.0",
        &Fake::reporting("pacer 0.2.0"),
    )
    .unwrap_err();
    assert!(
        err.0.starts_with(&format!(
            "could not replace {}:",
            fs::canonicalize(&path).unwrap().display()
        )),
        "{}",
        err.0
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), SCRIPT_010);
    fs::remove_dir(&staged).unwrap();
}

#[test]
fn failed_replacement_keeps_the_previous_backup() {
    let dir = tempfile::tempdir().unwrap();
    let bin = dir.path().join("bin");
    let path = installed(&bin, "0.1.0");
    fs::write(format!("{}.bak", path.display()), "existing backup").unwrap();
    let err = replace_binary(
        &path,
        script("0.2.0").as_bytes(),
        "0.2.0",
        &Fake::reporting("wrong version"),
    )
    .unwrap_err();
    assert!(err.0.contains("did not report version"), "{}", err.0);
    assert_eq!(
        fs::read_to_string(format!("{}.bak", path.display())).unwrap(),
        "existing backup"
    );
}

#[test]
fn signs_only_the_staged_inode_before_smoke() {
    let dir = tempfile::tempdir().unwrap();
    let target = installed(dir.path(), "0.1.0");
    let original = fs::metadata(&target).unwrap().ino();
    let fake = Fake::reporting("pacer 0.2.0");
    replace_binary(&target, script("0.2.0").as_bytes(), "0.2.0", &fake).unwrap();
    let events = fake.events.borrow();
    let staged = fs::canonicalize(dir.path())
        .unwrap()
        .join(format!(".pacer.update-{}", std::process::id()));
    assert_eq!(*events, [("sign", staged.clone()), ("smoke", staged)]);
    assert_eq!(fs::read_to_string(&target).unwrap(), script("0.2.0"));
    assert_ne!(fs::metadata(&target).unwrap().ino(), original);

    // `Staging::sign` is infallible (`signStaged` never fails the update); a smoke
    // failure is the observable path that preserves the installed target.
    let fake = Fake::reporting("wrong version");
    assert!(replace_binary(&target, script("0.3.0").as_bytes(), "0.3.0", &fake).is_err());
    assert_eq!(fs::read_to_string(&target).unwrap(), script("0.2.0"));
    assert!(!fs::read_dir(dir.path()).unwrap().any(|e| {
        e.unwrap()
            .file_name()
            .to_string_lossy()
            .contains(".update-")
    }));
}

#[test]
fn pair_stages_and_signs_both_before_install_retaining_backups() {
    let dir = tempfile::tempdir().unwrap();
    let target = installed(dir.path(), "0.1.0");
    let core = dir.path().join("pacer-core");
    fs::write(&core, "old core").unwrap();
    let fake = Fake::reporting("pacer 0.2.0");
    let (front, companions) = replace_pair(
        &target,
        b"new front",
        &[PairEntry {
            target: core.clone(),
            bytes: b"new core".to_vec(),
        }],
        "0.2.0",
        &fake,
    )
    .unwrap();
    assert_eq!(fs::read_to_string(&target).unwrap(), "new front");
    assert_eq!(fs::read_to_string(&core).unwrap(), "new core");
    assert_eq!(
        fs::read_to_string(&companions[0].backup).unwrap(),
        "old core"
    );
    assert_eq!(fs::read_to_string(&front.backup).unwrap(), SCRIPT_010);

    let events = fake.events.borrow();
    let kinds: Vec<_> = events.iter().map(|(kind, _)| *kind).collect();
    assert_eq!(kinds, ["sign", "sign", "smoke", "smoke"]);
    let names: Vec<_> = events
        .iter()
        .map(|(_, path)| path.file_name().unwrap().to_string_lossy().to_string())
        .collect();
    assert_eq!(
        names,
        ["pacer-core.new", "pacer.new", "pacer-core.new", "pacer.new"]
    );
}

#[test]
fn pair_failure_leaves_originals_intact_including_a_new_companion() {
    // Smoke failure: neither executable is touched and no new companion appears.
    {
        let dir = tempfile::tempdir().unwrap();
        let target = installed(dir.path(), "0.1.0");
        let core = dir.path().join("pacer-core");
        let err = replace_pair(
            &target,
            b"new front",
            &[PairEntry {
                target: core.clone(),
                bytes: b"new core".to_vec(),
            }],
            "0.2.0",
            &Fake::reporting("wrong"),
        )
        .unwrap_err();
        assert!(err.0.starts_with("could not replace pair: "), "{}", err.0);
        assert_eq!(fs::read_to_string(&target).unwrap(), SCRIPT_010);
        assert!(!core.exists());
    }
    // Signing is infallible by interface; a staging collision exercises the same
    // "stop before touching either original" path for the second mode.
    {
        let dir = tempfile::tempdir().unwrap();
        let target = installed(dir.path(), "0.1.0");
        let core = dir.path().join("pacer-core");
        fs::write(
            dir.path().join("pacer-core.new"),
            "belongs to another update",
        )
        .unwrap();
        assert!(
            replace_pair(
                &target,
                b"new front",
                &[PairEntry {
                    target: core.clone(),
                    bytes: b"new core".to_vec(),
                }],
                "0.2.0",
                &Fake::reporting("pacer 0.2.0"),
            )
            .is_err()
        );
        assert_eq!(
            fs::read_to_string(dir.path().join("pacer-core.new")).unwrap(),
            "belongs to another update"
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), SCRIPT_010);
    }
    // Rename failure after backing up: both originals survive.
    {
        let dir = tempfile::tempdir().unwrap();
        let target = installed(dir.path(), "0.1.0");
        let core = dir.path().join("pacer-core");
        // `replace_pair` resolves every target through canonicalize (a /var symlink
        // on macOS), so the injected failure must use the same canonical path.
        let fake =
            Fake::reporting("pacer 0.2.0").failing_rename_to(&fs::canonicalize(&target).unwrap());
        assert!(
            replace_pair(
                &target,
                b"new front",
                &[PairEntry {
                    target: core.clone(),
                    bytes: b"new core".to_vec(),
                }],
                "0.2.0",
                &fake,
            )
            .is_err()
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), SCRIPT_010);
        assert!(!core.exists());
    }
}

#[test]
fn failed_front_door_rename_restores_an_existing_core() {
    let dir = tempfile::tempdir().unwrap();
    let front = dir.path().join("pacer");
    let core = dir.path().join("pacer-core");
    fs::write(&front, "old-front").unwrap();
    fs::write(&core, "old-core").unwrap();
    let staging =
        Fake::reporting("pacer 2.0.0").failing_rename_to(&fs::canonicalize(&front).unwrap());
    let err = replace_pair(
        &front,
        b"new-front",
        &[PairEntry {
            target: core.clone(),
            bytes: b"new-core".to_vec(),
        }],
        "2.0.0",
        &staging,
    )
    .unwrap_err();
    assert!(err.0.starts_with("could not replace pair: "), "{}", err.0);
    assert_eq!(fs::read(&core).unwrap(), b"old-core");
    assert_eq!(fs::read(&front).unwrap(), b"old-front");
    assert!(
        !dir.path().join("pacer.new").exists() && !dir.path().join("pacer-core.new").exists(),
        "{}",
        err.0
    );
}

#[test]
fn pair_refuses_a_dangling_companion_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let target = installed(dir.path(), "0.1.0");
    let core = dir.path().join("pacer-core");
    let missing = dir.path().join("missing-core");
    symlink(&missing, &core).unwrap();
    let err = replace_pair(
        &target,
        b"new front",
        &[PairEntry {
            target: core.clone(),
            bytes: b"new core".to_vec(),
        }],
        "0.2.0",
        &Fake::reporting("pacer 0.2.0"),
    )
    .unwrap_err();
    assert!(err.0.contains("not a regular file"), "{}", err.0);
    assert!(
        fs::symlink_metadata(&core)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_link(&core).unwrap(), missing);
    assert_eq!(fs::read_to_string(&target).unwrap(), SCRIPT_010);
}
