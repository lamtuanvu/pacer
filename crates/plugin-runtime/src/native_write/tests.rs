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
