#![allow(clippy::unwrap_used)]
use super::*;
use std::io;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!("pacer-write-fault-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn writer(&self) -> NativeWrite {
        NativeWrite::prepare(
            &self.0,
            &[WriteResource {
                path: self.0.join("file").to_string_lossy().into_owned(),
                kind: "file".into(),
                operations: vec!["write".into()],
            }],
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn partial_stage_failure_removes_temporary_bytes_without_publishing() {
    let f = Fixture::new();
    let mut w = f.writer();
    assert!(
        w.write_bytes_io(
            f.0.join("file").to_str().unwrap(),
            b"complete",
            |file, bytes| {
                file.write_all(&bytes[..2])?;
                Err(io::Error::other("injected short append failure"))
            }
        )
        .is_err()
    );
    assert_eq!(fs::read_dir(&f.0).unwrap().count(), 0);
    assert!(w.retirement().is_ok());
}
#[test]
fn replacement_at_rename_boundary_cannot_redirect_the_write() {
    let f = Fixture::new();
    fs::create_dir(f.0.join("parent")).unwrap();
    let target = f.0.join("parent/file");
    let mut w = NativeWrite::prepare(
        &f.0,
        &[WriteResource {
            path: target.to_string_lossy().into_owned(),
            kind: "file".into(),
            operations: vec!["write".into()],
        }],
    )
    .unwrap();
    assert!(
        w.write_bytes_io(target.to_str().unwrap(), b"safe", |file, bytes| {
            file.write_all(bytes)?;
            fs::rename(f.0.join("parent"), f.0.join("held"))?;
            fs::create_dir(f.0.join("parent"))?;
            Ok(())
        })
        .is_err()
    );
    assert!(!target.exists());
    assert_eq!(fs::read_dir(f.0.join("held")).unwrap().count(), 0);
}
#[test]
fn uncertain_stage_cleanup_is_sticky_after_the_rpc_error_is_caught() {
    let f = Fixture::new();
    let mut w = f.writer();
    assert!(
        w.write_bytes_io(
            f.0.join("file").to_str().unwrap(),
            b"safe",
            |file, bytes| {
                file.write_all(bytes)?;
                let stage = fs::read_dir(&f.0)?.next().unwrap()?.path();
                fs::remove_file(&stage)?;
                fs::write(&stage, b"foreign")?;
                Err(io::Error::other("staged inode replaced"))
            }
        )
        .is_err()
    );
    assert!(w.retirement().is_err());
    assert!(w.retirement().is_err());
    assert!(
        w.write_bytes(f.0.join("file").to_str().unwrap(), b"later")
            .is_err()
    );
    let stage = fs::read_dir(&f.0).unwrap().next().unwrap().unwrap().path();
    assert_eq!(fs::read(stage).unwrap(), b"foreign");
}
#[test]
fn interrupted_and_short_writes_finish_the_exact_text() {
    struct Short {
        bytes: Vec<u8>,
        interrupted: bool,
    }
    impl Write for Short {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            if !self.interrupted {
                self.interrupted = true;
                return Err(io::ErrorKind::Interrupted.into());
            }
            let n = b.len().min(2);
            self.bytes.extend_from_slice(&b[..n]);
            Ok(n)
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut s = Short {
        bytes: vec![],
        interrupted: false,
    };
    s.write_all(b"whole text").unwrap();
    assert_eq!(s.bytes, b"whole text");
}
#[test]
fn revocation_at_the_staging_boundary_prevents_commit_and_finishes_cleanup() {
    let f = Fixture::new();
    let mut w = f.writer();
    let active = std::cell::Cell::new(true);
    let path = f.0.join("file");
    let result = w.write_bytes_checked_io(
        path.to_str().unwrap(),
        b"must not publish",
        |file, bytes| {
            file.write_all(bytes)?;
            active.set(false);
            Ok(())
        },
        || {
            if active.get() {
                Ok(())
            } else {
                Err(crate::AuthorityError::Expired.into())
            }
        },
    );
    assert!(result.is_err());
    assert!(!path.exists());
    assert_eq!(fs::read_dir(&f.0).unwrap().count(), 0);
    assert!(w.retirement().is_ok());
}
fn foreign_replace(path: &Path, bytes: &[u8]) {
    let stage = path.with_extension("foreign");
    fs::write(&stage, bytes).unwrap();
    fs::rename(stage, path).unwrap();
}
fn rebaseable(f: &Fixture, operations: &[&str]) -> NativeWrite {
    NativeWrite::prepare(
        &f.0,
        &[WriteResource {
            path: f.0.join("file").to_string_lossy().into_owned(),
            kind: "file".into(),
            operations: operations.iter().map(|o| (*o).into()).collect(),
        }],
    )
    .unwrap()
}
#[test]
fn transaction_read_accepts_prior_replacement_and_denies_later_one() {
    let f = Fixture::new();
    let path = f.0.join("file");
    let p = path.to_str().unwrap();
    let mut w = f.writer();
    assert_eq!(w.read_for_update(p).unwrap(), None);
    w.write_bytes(p, b"one").unwrap();
    foreign_replace(&path, b"foreign");
    assert!(w.write_bytes(p, b"stale").is_err());
    assert_eq!(w.read_for_update(p).unwrap().unwrap(), b"foreign");
    w.write_bytes(p, b"two").unwrap();
    w.write_bytes(p, b"three").unwrap();
    assert_eq!(fs::read(&path).unwrap(), b"three");
    foreign_replace(&path, b"later");
    assert!(w.write_bytes(p, b"lost").is_err());
    assert_eq!(fs::read(&path).unwrap(), b"later");
}
#[test]
fn immutable_read_never_rebaselines_and_survives_cleanup_failure() {
    let f = Fixture::new();
    let path = f.0.join("file");
    let p = path.to_str().unwrap();
    let mut w = f.writer();
    w.read_for_update(p).unwrap();
    w.write_bytes(p, b"mine").unwrap();
    foreign_replace(&path, b"foreign");
    assert_eq!(w.read_current_file(p).unwrap().unwrap(), b"foreign");
    assert!(w.write_bytes(p, b"stale").is_err());
    assert_eq!(fs::read(&path).unwrap(), b"foreign");
    w.read_for_update(p).unwrap();
    let _ = w.write_bytes_io(p, b"x", |file, bytes| {
        file.write_all(bytes)?;
        let stage = fs::read_dir(&f.0)?
            .map(|e| e.unwrap().path())
            .find(|p| p.to_string_lossy().contains(".pacer-write-"))
            .unwrap();
        fs::remove_file(&stage)?;
        fs::write(&stage, b"foreign stage")?;
        Err(io::Error::other("staged inode replaced"))
    });
    assert!(w.retirement().is_err());
    let before = w.resources[0].expected;
    assert!(w.read_for_update(p).is_err());
    assert!(w.resources[0].expected == before);
    assert_eq!(w.read_current_file(p).unwrap().unwrap(), b"foreign");
    assert!(w.write_bytes(p, b"later").is_err());
}
#[test]
fn rebased_publication_retains_the_identity_fd_and_noop_keeps_it() {
    let f = Fixture::new();
    let path = f.0.join("file");
    let p = path.to_str().unwrap();
    fs::write(&path, b"seed").unwrap();
    let mut plain = f.writer();
    plain.write_bytes(p, b"plain").unwrap();
    assert!(plain.resources[0].pin.is_none());
    let mut w = f.writer();
    w.read_for_update(p).unwrap();
    let pinned = |w: &NativeWrite| {
        let r = &w.resources[0];
        r.pin.as_ref().map(|f| identity(&f.metadata().unwrap())) == r.expected
            && r.expected.is_some()
    };
    assert!(pinned(&w));
    w.write_bytes(p, b"next").unwrap();
    assert!(pinned(&w));
    let id = w.resources[0].expected;
    w.write_bytes(p, b"next").unwrap();
    assert!(pinned(&w) && w.resources[0].expected == id);
    assert_eq!(
        fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
#[test]
fn observation_denies_links_special_files_and_replaced_roots_without_rebaseline() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let path = f.0.join("file");
    let p = path.to_str().unwrap();
    let mut w = f.writer();
    fs::write(f.0.join("other"), b"secret").unwrap();
    let denied_unchanged = |w: &mut NativeWrite| {
        let before = w.resources[0].expected;
        assert!(w.read_current_file(p).is_err());
        assert!(w.read_for_update(p).is_err());
        assert!(w.resources[0].expected == before && w.resources[0].pin.is_none());
    };
    symlink(f.0.join("other"), &path).unwrap();
    denied_unchanged(&mut w);
    fs::remove_file(&path).unwrap();
    fs::hard_link(f.0.join("other"), &path).unwrap();
    denied_unchanged(&mut w);
    fs::remove_file(&path).unwrap();
    fs::create_dir(&path).unwrap();
    denied_unchanged(&mut w);
    fs::remove_dir(&path).unwrap();
    nix::unistd::mkfifo(&path, Mode::S_IRUSR | Mode::S_IWUSR).unwrap();
    denied_unchanged(&mut w);
    fs::remove_file(&path).unwrap();
    fs::write(&path, b"ok").unwrap();
    let moved = f.0.with_extension("moved");
    fs::rename(&f.0, &moved).unwrap();
    fs::create_dir(&f.0).unwrap();
    fs::write(&path, b"replacement").unwrap();
    denied_unchanged(&mut w);
    assert!(w.check_root().is_err());
    assert!(w.write_bytes(p, b"x").is_err());
    assert_eq!(fs::read(&path).unwrap(), b"replacement");
    assert_eq!(fs::read(moved.join("file")).unwrap(), b"ok");
    fs::remove_dir_all(moved).unwrap();
}
#[test]
fn observation_requires_an_issued_exact_writable_file() {
    let f = Fixture::new();
    fs::write(f.0.join("file"), b"x").unwrap();
    let other = f.0.join("other");
    let mut w = rebaseable(&f, &["remove"]);
    let p = f.0.join("file");
    for path in [p.to_str().unwrap(), other.to_str().unwrap()] {
        assert!(w.read_current_file(path).is_err());
        assert!(w.read_for_update(path).is_err());
    }
    let mut d = NativeWrite::prepare(
        &f.0,
        &[WriteResource {
            path: f.0.join("dir").to_string_lossy().into_owned(),
            kind: "directory".into(),
            operations: vec!["write".into()],
        }],
    )
    .unwrap();
    let dir = f.0.join("dir");
    assert!(d.read_for_update(dir.to_str().unwrap()).is_err());
}
#[test]
fn observation_methods_stay_outside_capability_dispatch() {
    let f = Fixture::new();
    fs::write(f.0.join("file"), b"x").unwrap();
    let path = f.0.join("file");
    let mut w = rebaseable(
        &f,
        &["write", "read", "read_current_file", "read_for_update"],
    );
    for method in ["read", "read_current_file", "read_for_update", "check_root"] {
        assert!(
            w.answer(
                &format!("capability.fs.{method}"),
                &json!({"path":path.to_str().unwrap()})
            )
            .is_err(),
            "{method}"
        );
    }
    assert!(w.resources[0].pin.is_none());
}
#[test]
fn remove_clears_a_retained_pin_with_expected() {
    let f = Fixture::new();
    let path = f.0.join("file");
    let p = path.to_str().unwrap();
    fs::write(&path, b"x").unwrap();
    let mut w = rebaseable(&f, &["write", "remove"]);
    w.read_for_update(p).unwrap();
    assert!(w.resources[0].pin.is_some());
    w.answer("capability.fs.remove", &json!({"path":p}))
        .unwrap();
    assert!(w.resources[0].expected.is_none() && w.resources[0].pin.is_none());
    w.write_bytes(p, b"again").unwrap();
    assert!(w.resources[0].pin.is_some());
}
