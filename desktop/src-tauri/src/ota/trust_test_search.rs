//! Test-only hosted fixture metadata; no trust/default-keychain changes.
use std::path::{Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex, MutexGuard,
};
static WRITER: Mutex<()> = Mutex::new(());
static UNCERTAIN: AtomicBool = AtomicBool::new(false);
pub(super) fn lock() -> MutexGuard<'static, ()> {
    let guard = WRITER.lock().expect("fixture writer mutex poisoned");
    assert!(
        !UNCERTAIN.load(Ordering::SeqCst),
        "prior fixture cleanup uncertain"
    );
    guard
}
fn permitted(
    optin: &str,
    actions: &str,
    environment: &str,
    macos: bool,
) -> Result<bool, &'static str> {
    if optin != "1" {
        return Ok(false);
    }
    if actions != "true" || environment != "github-hosted" || !macos {
        return Err("hosted fixture opt-in refused");
    }
    Ok(true)
}
pub(super) fn hosted() -> bool {
    permitted(
        &std::env::var("PACER_HOSTED_TEST_KEYCHAIN_SEARCH").unwrap_or_default(),
        &std::env::var("GITHUB_ACTIONS").unwrap_or_default(),
        &std::env::var("RUNNER_ENVIRONMENT").unwrap_or_default(),
        cfg!(target_os = "macos"),
    )
    .expect("hosted fixture opt-in refused")
}

trait Backend {
    fn read(&mut self) -> Result<Vec<PathBuf>, &'static str>;
    fn set(&mut self, paths: &[PathBuf]) -> Result<(), &'static str>;
}
struct Security;
impl Backend for Security {
    fn read(&mut self) -> Result<Vec<PathBuf>, &'static str> {
        let output = std::process::Command::new("/usr/bin/security")
            .args(["list-keychains", "-d", "user"])
            .output()
            .map_err(|_| "search read spawn")?;
        if !output.status.success() {
            return Err("search read status");
        }
        parse(&output.stdout)
    }
    fn set(&mut self, paths: &[PathBuf]) -> Result<(), &'static str> {
        let output = std::process::Command::new("/usr/bin/security")
            .args(["list-keychains", "-d", "user", "-s"])
            .args(paths)
            .output()
            .map_err(|_| "search set spawn")?;
        if output.status.success() {
            Ok(())
        } else {
            Err("search set status")
        }
    }
}
// Strict quoted security(1) output; never evaluate shell input or log paths.
fn parse(bytes: &[u8]) -> Result<Vec<PathBuf>, &'static str> {
    if bytes.len() > 65536 {
        return Err("search output bound");
    }
    let text = std::str::from_utf8(bytes).map_err(|_| "search output encoding")?;
    let mut chars = text.chars().peekable();
    let mut result = Vec::new();
    while chars.peek().is_some() {
        while chars.peek().is_some_and(|c| c.is_ascii_whitespace()) {
            chars.next();
        }
        if chars.peek().is_none() {
            break;
        }
        if chars.next() != Some('"') {
            return Err("search output quoting");
        }
        let mut value = String::new();
        loop {
            match chars.next() {
                Some('"') => break,
                Some('\\') => match chars.next() {
                    Some(c @ ('\\' | '"')) => value.push(c),
                    _ => return Err("search output escape"),
                },
                Some(c) if !c.is_control() => value.push(c),
                _ => return Err("search output path"),
            }
        }
        if chars.peek().is_some_and(|c| !c.is_ascii_whitespace()) || !value.starts_with('/') {
            return Err("search output boundary");
        }
        result.push(PathBuf::from(value));
        if result.len() > 128 {
            return Err("search entry bound");
        }
    }
    Ok(result)
}
pub(super) struct Entry {
    own: PathBuf,
    intent: PathBuf,
    armed: bool,
}
impl Entry {
    pub(super) fn new(own: PathBuf, directory: &Path) -> Self {
        Self {
            own,
            intent: directory.join("search-entry.intent"),
            armed: false,
        }
    }
    pub(super) fn install(&mut self) -> Result<(), &'static str> {
        self.install_with(&mut Security)
    }
    fn install_with(&mut self, backend: &mut impl Backend) -> Result<(), &'static str> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut intent = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&self.intent)
            .map_err(|_| "search intent create")?;
        intent
            .write_all(b"owned fixture user-search entry; restore before deleting keychain\n")
            .map_err(|_| "search intent write")?;
        intent.sync_all().map_err(|_| "search intent sync")?;
        let original = backend.read()?;
        if original.contains(&self.own) {
            return Err("own search entry already present");
        }
        self.armed = true; // Before any possible setter side effect.
        if backend.read()? != original {
            return Err("search changed before append");
        }
        let mut expected = original;
        expected.push(self.own.clone());
        backend.set(&expected)?;
        if backend.read()? != expected {
            return Err("search append verification");
        }
        Ok(())
    }
    pub(super) fn cleanup(&mut self, delete: impl FnOnce() -> bool) -> Result<(), &'static str> {
        self.cleanup_with(&mut Security, delete)
    }
    fn cleanup_with(
        &mut self,
        backend: &mut impl Backend,
        delete: impl FnOnce() -> bool,
    ) -> Result<(), &'static str> {
        self.restore_with(backend)?;
        if !delete() {
            return Err("keychain deletion unverified");
        }
        self.finish()
    }
    pub(super) fn finish(&self) -> Result<(), &'static str> {
        if self.armed {
            return Err("search still armed");
        }
        if self.intent.exists() {
            std::fs::remove_file(&self.intent).map_err(|_| "search intent remove")?;
        }
        Ok(())
    }
    fn restore_with(&mut self, backend: &mut impl Backend) -> Result<(), &'static str> {
        let current = backend.read()?;
        if !self.armed {
            return if current.contains(&self.own) {
                Err("unowned search entry present")
            } else {
                Ok(())
            };
        }
        let expected: Vec<_> = current
            .iter()
            .filter(|p| **p != self.own)
            .cloned()
            .collect();
        if current != expected {
            backend.set(&expected)?;
        }
        if backend.read()? != expected {
            return Err("search removal verification");
        }
        self.armed = false;
        Ok(())
    }
}
pub(super) fn finish_cleanup(hosted: bool, cleaned: bool, dir: &mut Option<tempfile::TempDir>) {
    if hosted && !cleaned {
        UNCERTAIN.store(true, Ordering::SeqCst);
        if let Some(dir) = dir.take() {
            let _retained = dir.keep();
        }
        if !std::thread::panicking() {
            panic!("hosted fixture cleanup failed; private state retained");
        }
        eprintln!("trust-test hosted fixture cleanup failed; private state retained");
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    struct Fake {
        paths: Vec<PathBuf>,
        sets: usize,
        fail_set: bool,
        fail_read: bool,
        inject_after_set: Option<PathBuf>,
    }
    impl Backend for Fake {
        fn read(&mut self) -> Result<Vec<PathBuf>, &'static str> {
            if self.fail_read {
                Err("mock read")
            } else {
                Ok(self.paths.clone())
            }
        }
        fn set(&mut self, paths: &[PathBuf]) -> Result<(), &'static str> {
            self.sets += 1;
            self.paths = paths.to_vec();
            if let Some(path) = &self.inject_after_set {
                self.paths.push(path.clone());
            }
            if self.fail_set {
                Err("mock uncertain set")
            } else {
                Ok(())
            }
        }
    }
    fn fake() -> Fake {
        Fake {
            paths: vec!["/other".into()],
            sets: 0,
            fail_set: false,
            fail_read: false,
            inject_after_set: None,
        }
    }
    fn entry(dir: &Path) -> Entry {
        Entry::new(dir.join("own.keychain-db"), dir)
    }
    #[test]
    fn strict_parser() {
        assert_eq!(
            parse(b"  \"/a b\"\n\"/c\\\"d\"\n").unwrap(),
            vec![PathBuf::from("/a b"), PathBuf::from("/c\"d")]
        );
        for bad in [
            b"/unquoted".as_slice(),
            b"\"relative\"",
            b"\"/a\"suffix",
            b"\"/a\\q\"",
            b"\"/a\n\"",
        ] {
            assert!(parse(bad).is_err());
        }
    }
    #[test]
    fn current_others_preserved_and_cleanup_idempotent() {
        let dir = tempfile::tempdir().unwrap();
        let mut entry = entry(dir.path());
        let mut b = fake();
        entry.install_with(&mut b).unwrap();
        b.paths.push("/new-other".into());
        entry.restore_with(&mut b).unwrap();
        entry.finish().unwrap();
        assert_eq!(
            b.paths,
            vec![PathBuf::from("/other"), PathBuf::from("/new-other")]
        );
        assert!(!entry.intent.exists());
        let sets = b.sets;
        entry.restore_with(&mut b).unwrap();
        assert_eq!(sets, b.sets);
    }
    #[test]
    fn uncertain_append_is_armed_and_restored() {
        let dir = tempfile::tempdir().unwrap();
        let mut entry = entry(dir.path());
        let mut b = fake();
        b.fail_set = true;
        assert!(entry.install_with(&mut b).is_err());
        assert!(entry.armed && entry.intent.exists());
        b.fail_set = false;
        entry.restore_with(&mut b).unwrap();
        assert_eq!(b.paths, vec![PathBuf::from("/other")]);
    }
    #[test]
    fn failed_cleanup_preserves_private_intent() {
        let dir = tempfile::tempdir().unwrap();
        let mut entry = entry(dir.path());
        let mut b = fake();
        entry.install_with(&mut b).unwrap();
        b.fail_read = true;
        assert!(entry.restore_with(&mut b).is_err());
        assert!(entry.intent.exists() && entry.armed);
        b.fail_read = false;
        b.fail_set = true;
        assert!(entry.restore_with(&mut b).is_err());
        assert!(entry.intent.exists() && entry.armed);
        b.fail_set = false;
        entry.restore_with(&mut b).unwrap();
    }
    #[test]
    fn preexisting_entry_refuses_without_set() {
        let dir = tempfile::tempdir().unwrap();
        let mut entry = entry(dir.path());
        let mut b = fake();
        b.paths.push(entry.own.clone());
        assert!(entry.install_with(&mut b).is_err());
        assert_eq!(b.sets, 0);
        assert!(entry.intent.exists());
        let deleted = std::cell::Cell::new(false);
        assert!(entry
            .cleanup_with(&mut b, || {
                deleted.set(true);
                true
            })
            .is_err());
        assert!(!deleted.get());
        assert_eq!(b.sets, 0);
    }
    #[test]
    fn cleanup_orders_restore_delete_and_intent_removal() {
        let dir = tempfile::tempdir().unwrap();
        let mut entry = entry(dir.path());
        let mut b = fake();
        entry.install_with(&mut b).unwrap();
        let intent = entry.intent.clone();
        assert!(entry
            .cleanup_with(&mut b, || {
                assert!(intent.exists());
                false
            })
            .is_err());
        assert!(entry.intent.exists());
        assert!(!b.paths.contains(&entry.own));
        entry.cleanup_with(&mut b, || true).unwrap();
        assert!(!entry.intent.exists());
    }
    #[test]
    fn mutex_spans_lifetime() {
        let _guard = lock();
        assert!(!std::thread::spawn(|| WRITER.try_lock().is_ok())
            .join()
            .unwrap());
    }
    fn isolated(name: &str) -> bool {
        let name = name.split_once("::").expect("crate-qualified test name").1;
        if std::env::var("PACER_SEARCH_LIFECYCLE_CHILD").as_deref() == Ok(name) {
            return false;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args(["--exact", name, "--nocapture"])
            .env("PACER_SEARCH_LIFECYCLE_CHILD", name)
            .output()
            .unwrap();
        assert!(output.status.success(), "isolated lifecycle test failed");
        assert!(String::from_utf8_lossy(&output.stdout)
            .contains("test result: ok. 1 passed; 0 failed;"));
        true
    }
    #[test]
    fn cleanup_failure_retains_actual_tempdir_and_refuses_next_fixture() {
        let name = concat!(
            module_path!(),
            "::cleanup_failure_retains_actual_tempdir_and_refuses_next_fixture"
        );
        if isolated(name) {
            return;
        }
        let mut dir = Some(tempfile::tempdir().unwrap());
        let path = dir.as_ref().unwrap().path().to_owned();
        std::fs::write(path.join("private.intent"), b"owned fixture").unwrap();
        assert!(
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| finish_cleanup(
                true, false, &mut dir
            )))
            .is_err()
        );
        assert!(dir.is_none());
        assert_eq!(
            std::fs::read(path.join("private.intent")).unwrap(),
            b"owned fixture"
        );
        assert!(std::panic::catch_unwind(lock).is_err());
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn cleanup_failure_during_unwind_retains_without_double_panic() {
        let name = concat!(
            module_path!(),
            "::cleanup_failure_during_unwind_retains_without_double_panic"
        );
        if isolated(name) {
            return;
        }
        struct Guard(Option<tempfile::TempDir>);
        impl Drop for Guard {
            fn drop(&mut self) {
                finish_cleanup(true, false, &mut self.0);
            }
        }
        let guard = Guard(Some(tempfile::tempdir().unwrap()));
        let path = guard.0.as_ref().unwrap().path().to_owned();
        assert!(std::panic::catch_unwind(move || {
            let _guard = guard;
            panic!("original failure");
        })
        .is_err());
        assert!(path.exists());
        assert!(UNCERTAIN.load(Ordering::SeqCst));
        std::fs::remove_dir_all(path).unwrap();
    }
    #[test]
    fn successful_cleanup_keeps_normal_directory_drop() {
        let mut dir = Some(tempfile::tempdir().unwrap());
        let path = dir.as_ref().unwrap().path().to_owned();
        finish_cleanup(true, true, &mut dir);
        assert!(dir.is_some());
        drop(dir);
        assert!(!path.exists());
    }
    #[test]
    fn hosted_optin_is_required_and_local_context_refused() {
        assert_eq!(permitted("", "", "", true), Ok(false));
        assert_eq!(permitted("0", "true", "github-hosted", true), Ok(false));
        assert_eq!(permitted("1", "true", "github-hosted", true), Ok(true));
        for (actions, environment, macos) in [
            ("", "github-hosted", true),
            ("true", "self-hosted", true),
            ("true", "github-hosted", false),
        ] {
            assert!(permitted("1", actions, environment, macos).is_err());
        }
    }
    #[test]
    fn failed_removal_verification_never_deletes() {
        let dir = tempfile::tempdir().unwrap();
        let mut entry = entry(dir.path());
        let mut b = fake();
        entry.install_with(&mut b).unwrap();
        b.inject_after_set = Some(entry.own.clone());
        let deleted = std::cell::Cell::new(false);
        assert!(entry
            .cleanup_with(&mut b, || {
                deleted.set(true);
                true
            })
            .is_err());
        assert!(!deleted.get());
        assert!(entry.armed && entry.intent.exists());
    }
}
