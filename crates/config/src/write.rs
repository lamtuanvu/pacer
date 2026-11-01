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
/// The original mode is retained, as in the TypeScript strategy writer.
pub fn atomic_strategy_write(path: &Path, text: &str) -> io::Result<()> {
    let mode = fs::metadata(path)?.permissions();
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
        options.mode(mode.mode() & 0o777);
        let mut file = options.open(&temp)?;
        fs::set_permissions(&temp, mode)?;
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
}
