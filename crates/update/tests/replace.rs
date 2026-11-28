//! Transcribed from `test/update-replace.test.ts` (the replacement cases). The
//! TypeScript `sign`, `smoke` and `rename` injections become the `Staging` trait;
//! `Fake` records the order of staged signing and smoke runs and can fail a rename.
use pacer_update::replace::{
    PairEntry, Staging, replace_binary, replace_pair, reports_version, run_version,
};
use std::{
    cell::RefCell,
    fs, io,
    os::unix::fs::{MetadataExt, PermissionsExt},
    path::{Path, PathBuf},
    rc::Rc,
};

fn script(version: &str) -> String {
    format!("#!/bin/sh\necho \"pacer {version}\"\n")
}

fn installed(dir: &Path, version: &str) -> PathBuf {
    fs::create_dir_all(dir).unwrap();
    let path = dir.join("pacer");
    fs::write(&path, script(version)).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    path
}

fn canon(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

struct Fake {
    output: String,
    smoke_fn: Option<Rc<dyn Fn(&Path) -> String>>,
    events: Rc<RefCell<Vec<String>>>,
    renames: Rc<RefCell<Vec<(PathBuf, PathBuf)>>>,
    fail_rename_to: Option<PathBuf>,
    fail_rename_message: String,
}

impl Fake {
    fn reporting(output: &str) -> Self {
        Self {
            output: output.into(),
            smoke_fn: None,
            events: Rc::new(RefCell::new(Vec::new())),
            renames: Rc::new(RefCell::new(Vec::new())),
            fail_rename_to: None,
            fail_rename_message: String::new(),
        }
    }

    fn reporting_with_events(output: &str, events: Rc<RefCell<Vec<String>>>) -> Self {
        let mut fake = Self::reporting(output);
        fake.events = events;
        fake
    }

    fn smoke_when(mut self, check: impl Fn(&Path) -> String + 'static) -> Self {
        self.smoke_fn = Some(Rc::new(check));
        self
    }

    fn failing_rename_to(self, path: &Path) -> Self {
        self.failing_rename_with(path, "rename failed")
    }

    fn failing_rename_with(mut self, path: &Path, message: &str) -> Self {
        self.fail_rename_to = Some(canon(path));
        self.fail_rename_message = message.into();
        self
    }
}

impl Staging for Fake {
    fn smoke(&self, path: &Path) -> String {
        self.events
            .borrow_mut()
            .push(format!("smoke:{}", path.display()));
        match &self.smoke_fn {
            Some(check) => check(path),
            None => self.output.clone(),
        }
    }

    fn sign(&self, path: &Path) {
        self.events
            .borrow_mut()
            .push(format!("sign:{}", path.display()));
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        self.renames
            .borrow_mut()
            .push((from.to_path_buf(), to.to_path_buf()));
        if self.fail_rename_to.as_deref() == Some(canon(to).as_path()) {
            return Err(io::Error::other(self.fail_rename_message.clone()));
        }
        fs::rename(from, to)
    }
}

#[test]
fn run_version_and_reports_version() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(dir.path(), "0.2.0");
    assert_eq!(run_version(&path).trim(), "pacer 0.2.0");
    assert_eq!(run_version(&dir.path().join("missing")), "");
    assert!(reports_version("pacer 0.2.0\n", "0.2.0"));
    assert!(!reports_version("pacer 0.2.0-rc.1", "0.2.0"));
    assert!(!reports_version("", "0.2.0"));
}

#[test]
fn run_version_rejects_nonzero_exit() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(dir.path(), "0.1.0");
    fs::write(&path, format!("{}exit 1\n", script("0.2.0"))).unwrap();
    fs::set_permissions(&path, fs::Permissions::from_mode(0o755)).unwrap();
    assert_eq!(run_version(&path), "");
}

#[test]
fn replace_binary_never_writes_the_running_inode() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(&dir.path().join("bin"), "0.1.0");
    let running = fs::metadata(&path).unwrap().ino();
    let fake = Fake::reporting("pacer 0.2.0");
    replace_binary(&path, script("0.2.0").as_bytes(), "0.2.0", &fake).unwrap();
    assert_ne!(fs::metadata(&path).unwrap().ino(), running);
    let backup = dir.path().join("bin/pacer.bak");
    assert_eq!(fs::metadata(&backup).unwrap().ino(), running);
    assert_eq!(fs::read_to_string(&backup).unwrap(), script("0.1.0"));
}

#[test]
fn replace_binary_swaps_atomically_and_keeps_bak() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(&dir.path().join("bin"), "0.1.0");
    fs::write(dir.path().join("bin/pacer.bak"), "an older backup").unwrap();
    let fake = Fake::reporting("pacer 0.2.0");
    let result = replace_binary(&path, script("0.2.0").as_bytes(), "0.2.0", &fake).unwrap();
    assert_eq!(result.path, canon(&path));
    assert_eq!(result.backup, canon(&path).with_extension("bak"));
    assert_eq!(fs::read_to_string(&path).unwrap(), script("0.2.0"));
    assert_eq!(fs::read_to_string(&result.backup).unwrap(), script("0.1.0"));
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o755
    );
    let mut entries: Vec<_> = fs::read_dir(dir.path().join("bin"))
        .unwrap()
        .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    entries.sort();
    assert_eq!(entries, ["pacer", "pacer.bak"]);
}

#[test]
fn replace_binary_follows_a_symlink() {
    let root = tempfile::tempdir().unwrap();
    let real = installed(&root.path().join("opt"), "0.1.0");
    fs::create_dir(root.path().join("bin")).unwrap();
    let link = root.path().join("bin/pacer");
    std::os::unix::fs::symlink(&real, &link).unwrap();
    let fake = Fake::reporting("pacer 0.2.0");
    let result = replace_binary(&link, script("0.2.0").as_bytes(), "0.2.0", &fake).unwrap();
    assert_eq!(result.path, canon(&real));
    assert!(
        fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_to_string(&real).unwrap(), script("0.2.0"));
    assert_eq!(
        fs::read_to_string(root.path().join("opt/pacer.bak")).unwrap(),
        script("0.1.0")
    );
}

#[test]
fn wrong_version_is_not_installed() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(&dir.path().join("bin"), "0.1.0");
    let fake = Fake::reporting("pacer 0.2.1");
    let error = replace_binary(&path, script("0.0.9").as_bytes(), "0.2.0", &fake).unwrap_err();
    assert!(
        error.0.contains("did not report version 0.2.0"),
        "{}",
        error.0
    );
    assert_eq!(fs::read_to_string(&path).unwrap(), script("0.1.0"));
    let entries: Vec<_> = fs::read_dir(dir.path().join("bin")).unwrap().collect();
    assert_eq!(entries.len(), 1);
}

#[test]
fn non_permission_failures_are_release_errors() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(&dir.path().join("bin"), "0.1.0");
    let fake = Fake::reporting("pacer 0.2.0").failing_rename_with(&path, "disk full");
    let error = replace_binary(&path, script("0.2.0").as_bytes(), "0.2.0", &fake).unwrap_err();
    assert!(
        error.0.contains(&format!(
            "could not replace {}: disk full",
            canon(&path).display()
        )),
        "{}",
        error.0
    );
}

#[test]
fn failed_replacement_keeps_the_previous_backup() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(&dir.path().join("bin"), "0.1.0");
    fs::write(dir.path().join("bin/pacer.bak"), "existing backup").unwrap();
    let fake = Fake::reporting("wrong version");
    assert!(replace_binary(&path, script("0.2.0").as_bytes(), "0.2.0", &fake).is_err());
    assert_eq!(
        fs::read_to_string(dir.path().join("bin/pacer.bak")).unwrap(),
        "existing backup"
    );
}

#[test]
fn signs_only_the_staged_inode_before_smoke() {
    let dir = tempfile::tempdir().unwrap();
    let path = installed(dir.path(), "0.1.0");
    let events = Rc::new(RefCell::new(Vec::new()));
    let seen = events.clone();
    let target = path.clone();
    let fake = Fake::reporting_with_events("pacer 0.2.0", events).smoke_when(move |staged| {
        assert_ne!(staged, target);
        assert_eq!(fs::read_to_string(&target).unwrap(), script("0.1.0"));
        assert!(
            seen.borrow()
                .iter()
                .any(|event| event == &format!("sign:{}", staged.display()))
        );
        "pacer 0.2.0".into()
    });
    replace_binary(&path, script("0.2.0").as_bytes(), "0.2.0", &fake).unwrap();
    assert_eq!(fs::read_to_string(&path).unwrap(), script("0.2.0"));
    let events = fake.events.borrow();
    assert_eq!(events.len(), 2);
    assert!(events[0].starts_with("sign:"));
    assert!(events[1].starts_with("smoke:"));
    let staged = events[0].trim_start_matches("sign:");
    assert_eq!(events[1], format!("smoke:{staged}"));
    assert!(
        Path::new(staged)
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains(".update-")
    );
}

#[test]
fn pair_stages_and_signs_both_before_install_retaining_backups() {
    let dir = tempfile::tempdir().unwrap();
    let target = installed(dir.path(), "0.1.0");
    let core = dir.path().join("pacer-core");
    fs::write(&core, "old core").unwrap();
    let events = Rc::new(RefCell::new(Vec::new()));
    let seen = events.clone();
    let target_seen = target.clone();
    let core_seen = core.clone();
    let fake = Fake::reporting_with_events("pacer 0.2.0", events).smoke_when(move |staged| {
        assert!(
            seen.borrow()
                .iter()
                .any(|event| event == &format!("sign:{}", staged.display()))
        );
        assert_eq!(fs::read_to_string(&target_seen).unwrap(), script("0.1.0"));
        assert_eq!(fs::read_to_string(&core_seen).unwrap(), "old core");
        "pacer 0.2.0".into()
    });
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
    assert_eq!(fs::read_to_string(&front.backup).unwrap(), script("0.1.0"));
}

#[test]
fn pair_failure_leaves_originals_intact_including_a_new_companion() {
    // The Rust `Staging::sign` cannot fail by contract (it mirrors `signStaged`),
    // so the sign-failure branch has no Rust analogue; smoke and rename are covered.
    for failure in ["smoke", "rename"] {
        let dir = tempfile::tempdir().unwrap();
        let target = installed(dir.path(), "0.1.0");
        let core = dir.path().join("pacer-core");
        let fake = if failure == "smoke" {
            Fake::reporting("pacer 0.2.0").smoke_when(|path: &Path| {
                if path
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .contains("pacer-core")
                {
                    "wrong".into()
                } else {
                    "pacer 0.2.0".into()
                }
            })
        } else {
            Fake::reporting("pacer 0.2.0").failing_rename_to(&target)
        };
        let error = replace_pair(
            &target,
            b"new front",
            &[PairEntry {
                target: core.clone(),
                bytes: b"new core".to_vec(),
            }],
            "0.2.0",
            &fake,
        )
        .unwrap_err();
        assert!(
            error.0.starts_with("could not replace pair: "),
            "{}",
            error.0
        );
        assert_eq!(fs::read_to_string(&target).unwrap(), script("0.1.0"));
        assert!(
            !core.exists(),
            "a newly introduced companion must be rolled back"
        );
    }
}

#[test]
fn failed_front_door_rename_restores_an_existing_core() {
    let dir = tempfile::tempdir().unwrap();
    let front = dir.path().join("pacer");
    let core = dir.path().join("pacer-core");
    fs::write(&front, b"old-front").unwrap();
    fs::write(&core, b"old-core").unwrap();
    let staging = Fake::reporting("pacer 2.0.0").failing_rename_to(&front);
    let error = replace_pair(
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
    assert!(
        error.0.starts_with("could not replace pair: "),
        "{}",
        error.0
    );
    assert_eq!(fs::read(&core).unwrap(), b"old-core");
    assert_eq!(fs::read(&front).unwrap(), b"old-front");
    assert!(!dir.path().join("pacer.new").exists());
    assert!(!dir.path().join("pacer-core.new").exists());
}

#[test]
fn pair_refuses_a_dangling_companion_symlink() {
    let dir = tempfile::tempdir().unwrap();
    let target = installed(dir.path(), "0.1.0");
    let core = dir.path().join("pacer-core");
    let missing = dir.path().join("missing-core");
    std::os::unix::fs::symlink(&missing, &core).unwrap();
    let fake = Fake::reporting("pacer 0.2.0");
    let error = replace_pair(
        &target,
        b"new front",
        &[PairEntry {
            target: core.clone(),
            bytes: b"new core".to_vec(),
        }],
        "0.2.0",
        &fake,
    )
    .unwrap_err();
    assert!(error.0.contains("not a regular file"), "{}", error.0);
    assert!(
        fs::symlink_metadata(&core)
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read_link(&core).unwrap(), missing);
    assert_eq!(fs::read_to_string(&target).unwrap(), script("0.1.0"));
}
