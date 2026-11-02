//! Exclusive temporary files for atomic configuration writes.
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT: AtomicU64 = AtomicU64::new(0);

pub(crate) fn create(path: &Path) -> io::Result<(PathBuf, fs::File)> {
    create_with(path, || {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        Ok(format!(
            "{}.{}.{}",
            std::process::id(),
            nanos,
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    })
}

fn create_with(
    path: &Path,
    mut suffix: impl FnMut() -> io::Result<String>,
) -> io::Result<(PathBuf, fs::File)> {
    let name = path
        .file_name()
        .ok_or_else(|| io::Error::other("file has no name"))?
        .to_string_lossy();
    for _ in 0..16 {
        let temp = path.with_file_name(format!("{name}.{}.tmp", suffix()?));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        match options.open(&temp) {
            Ok(file) => return Ok((temp, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not create a unique config temp file",
    ))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn collisions_are_preserved_and_retried_for_both_writers() {
        let dir = tempfile::tempdir().unwrap();
        for name in ["settings.json", "example.yaml"] {
            let path = dir.path().join(name);
            let existing = dir.path().join(format!("{name}.collision.tmp"));
            fs::write(&existing, b"keep").unwrap();
            let mut candidates = ["collision", "unique"].into_iter();
            let (created, file) =
                create_with(&path, || Ok(candidates.next().unwrap().into())).unwrap();
            drop(file);
            assert_eq!(fs::read(&existing).unwrap(), b"keep");
            assert_ne!(created, existing);
            fs::remove_file(created).unwrap();
        }
    }
}
