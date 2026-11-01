#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs,
    io::{self, Write},
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

/// Write next to the existing strategy, then rename so readers see complete YAML.
/// Strategy state is private even when the previous file or parent was permissive.
pub fn atomic_strategy_write(path: &Path, text: &str) -> io::Result<()> {
    fs::metadata(path)?;
    let parent = path.parent().unwrap_or(Path::new("."));
    if fs::symlink_metadata(parent)?.file_type().is_symlink() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "unsafe strategy directory",
        ));
    }
    #[cfg(unix)]
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    let suffix = NEXT_TEMP.fetch_add(1, Ordering::Relaxed);
    let temp = path.with_file_name(format!(
        "{}.{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id(),
        suffix
    ));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = options.open(&temp)?;
        file.write_all(text.as_bytes())?;
        file.flush()?;
        fs::rename(&temp, path)
    })();
    let _ = fs::remove_file(temp);
    result
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]

    use super::atomic_strategy_write;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::process::Command;

    #[test]
    fn replaces_existing_strategy_and_keeps_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("strategy.yaml");
        fs::write(&path, "old\n").unwrap();
        #[cfg(unix)]
        {
            fs::set_permissions(&path, fs::Permissions::from_mode(0o600)).unwrap();
        }
        atomic_strategy_write(&path, "new\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "new\n");
        #[cfg(unix)]
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1);
    }

    #[cfg(unix)]
    #[test]
    fn both_umasks_tighten_existing_mode_and_directory() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("strategy.yaml");
        fs::write(&path, "old\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
        for mask in ["022", "077"] {
            fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o755)).unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o644)).unwrap();
            let output = Command::new("sh")
                .args([
                    "-c",
                    "umask \"$1\"; exec \"$2\" --exact write::tests::write_under_umask",
                    "sh",
                    mask,
                ])
                .arg(std::env::current_exe().unwrap())
                .env("PACER_CONFIG_UMASK_TEST_PATH", &path)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            assert_eq!(fs::read_to_string(&path).unwrap(), "new\n");
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
            assert_eq!(
                fs::metadata(dir.path()).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
    }

    #[cfg(unix)]
    #[test]
    fn write_under_umask() {
        let Ok(path) = std::env::var("PACER_CONFIG_UMASK_TEST_PATH") else {
            return;
        };
        atomic_strategy_write(std::path::Path::new(&path), "new\n").unwrap();
    }
}
