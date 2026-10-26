use crate::Ctx;
use std::{
    fs::{self, OpenOptions},
    io,
    path::PathBuf,
    time::{Duration, Instant},
};

pub struct LockOptions {
    pub timeout: Duration,
    pub stale: Duration,
}
impl Default for LockOptions {
    fn default() -> Self {
        Self {
            timeout: Duration::from_secs(20),
            stale: Duration::from_secs(120),
        }
    }
}

#[derive(thiserror::Error, Debug)]
pub enum LockError {
    #[error("invalid lock name")]
    InvalidName,
    #[error("timed out waiting for {0}")]
    Timeout(PathBuf),
    #[error(transparent)]
    Io(#[from] io::Error),
}

struct Guard(PathBuf);
impl Drop for Guard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

fn lock_path(ctx: &Ctx, name: &str) -> Result<PathBuf, LockError> {
    if name.contains('/') || name.contains('\\') || name.contains("..") {
        return Err(LockError::InvalidName);
    }
    let dir = ctx.pacer_home.join("orca");
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&dir)?;
        if fs::symlink_metadata(&dir)?.file_type().is_symlink() {
            return Err(io::Error::other("lock directory is a symlink").into());
        }
        fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(&dir)?;
    Ok(dir.join(format!("{name}.lock")))
}

fn try_acquire(file: &PathBuf, stale: Duration) -> Result<Option<Guard>, LockError> {
    loop {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(file) {
            Ok(_) => return Ok(Some(Guard(file.clone()))),
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                match fs::metadata(file) {
                    Ok(meta) => {
                        if meta.modified()?.elapsed().is_ok_and(|age| age > stale) {
                            match fs::remove_file(file) {
                                Ok(()) => {}
                                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                                Err(e) => return Err(e.into()),
                            }
                            continue;
                        }
                    }
                    Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e.into()),
                }
                return Ok(None);
            }
            Err(e) => return Err(e.into()),
        }
    }
}

pub fn with_lock<T>(
    ctx: &Ctx,
    name: &str,
    o: LockOptions,
    f: impl FnOnce() -> T,
) -> Result<T, LockError> {
    let file = lock_path(ctx, name)?;
    let start = Instant::now();
    loop {
        if let Some(_guard) = try_acquire(&file, o.stale)? {
            return Ok(f());
        }
        if start.elapsed() > o.timeout {
            return Err(LockError::Timeout(file));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[cfg(feature = "async")]
pub async fn with_lock_async<T, F: std::future::Future<Output = T>>(
    ctx: &Ctx,
    name: &str,
    o: LockOptions,
    f: impl FnOnce() -> F,
) -> Result<T, LockError> {
    let file = lock_path(ctx, name)?;
    let start = Instant::now();
    loop {
        if let Some(_guard) = try_acquire(&file, o.stale)? {
            return Ok(f().await);
        }
        if start.elapsed() > o.timeout {
            return Err(LockError::Timeout(file));
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    fn ctx(dir: &tempfile::TempDir) -> Ctx {
        Ctx::with(
            dir.path().into(),
            dir.path().into(),
            Default::default(),
            0.0,
        )
    }
    #[cfg(unix)]
    #[test]
    fn lock_directory_and_file_are_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(&dir);
        with_lock(&ctx, "link", LockOptions::default(), || {
            assert_eq!(
                fs::metadata(ctx.pacer_home.join("orca/link.lock"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        })
        .unwrap();
        assert_eq!(
            fs::metadata(ctx.pacer_home.join("orca"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
    }
    #[cfg(unix)]
    #[test]
    fn rejects_symlinked_lock_directory_without_chmodding_target() {
        use std::os::unix::fs::{PermissionsExt, symlink};
        let dir = tempfile::tempdir().unwrap();
        let ctx = ctx(&dir);
        let target = dir.path().join("outside");
        fs::create_dir_all(&target).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o755)).unwrap();
        fs::create_dir_all(&ctx.pacer_home).unwrap();
        symlink(&target, ctx.pacer_home.join("orca")).unwrap();
        assert!(with_lock(&ctx, "notifications", LockOptions::default(), || ()).is_err());
        assert_eq!(
            fs::metadata(&target).unwrap().permissions().mode() & 0o777,
            0o755
        );
        assert!(!target.join("notifications.lock").exists());
    }
    #[test]
    fn refuses_path_names() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["../x", "a/b", "a\\b", "a..b"] {
            assert!(matches!(
                with_lock(&ctx(&dir), name, LockOptions::default(), || ()),
                Err(LockError::InvalidName)
            ));
        }
    }
    #[test]
    fn takes_over_stale_locks() {
        let dir = tempfile::tempdir().unwrap();
        let c = ctx(&dir);
        std::fs::create_dir_all(c.pacer_home.join("orca")).unwrap();
        let f = c.pacer_home.join("orca/strategy.lock");
        std::fs::write(&f, "").unwrap();
        let old = std::time::SystemTime::now() - Duration::from_secs(121);
        std::fs::File::options()
            .write(true)
            .open(&f)
            .unwrap()
            .set_modified(old)
            .unwrap();
        assert_eq!(
            with_lock(&c, "strategy", LockOptions::default(), || 7).unwrap(),
            7
        );
        assert!(!f.exists());
    }
    #[test]
    fn times_out_on_a_held_lock() {
        let dir = tempfile::tempdir().unwrap();
        let c = ctx(&dir);
        std::fs::create_dir_all(c.pacer_home.join("orca")).unwrap();
        std::fs::write(c.pacer_home.join("orca/x.lock"), "").unwrap();
        let o = LockOptions {
            timeout: Duration::from_millis(120),
            ..Default::default()
        };
        assert!(matches!(
            with_lock(&c, "x", o, || ()),
            Err(LockError::Timeout(_))
        ));
    }
    #[test]
    fn releases_on_panic() {
        let dir = tempfile::tempdir().unwrap();
        let c = ctx(&dir);
        let _ = std::panic::catch_unwind(|| {
            with_lock(&c, "x", LockOptions::default(), || panic!("test"))
        });
        assert!(!c.pacer_home.join("orca/x.lock").exists());
    }
}

#[cfg(all(test, feature = "async"))]
#[allow(clippy::unwrap_used)]
mod async_tests {
    use super::*;
    #[tokio::test]
    async fn async_lock_shares_protocol_and_releases_on_cancellation() {
        let dir = tempfile::tempdir().unwrap();
        let ctx = Ctx::with(
            dir.path().into(),
            dir.path().into(),
            Default::default(),
            0.0,
        );
        let path = ctx.pacer_home.join("orca/async.lock");
        let future = with_lock_async(&ctx, "async", LockOptions::default(), || async {
            assert!(path.exists());
            assert!(matches!(
                with_lock(
                    &ctx,
                    "async",
                    LockOptions {
                        timeout: Duration::ZERO,
                        ..Default::default()
                    },
                    || ()
                ),
                Err(LockError::Timeout(_))
            ));
            std::future::pending::<()>().await;
        });
        assert!(
            tokio::time::timeout(Duration::from_millis(10), future)
                .await
                .is_err()
        );
        assert!(!path.exists());
        assert_eq!(
            with_lock_async(&ctx, "async", LockOptions::default(), || async { 7 })
                .await
                .unwrap(),
            7
        );
    }
}
