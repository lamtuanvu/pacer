use serde::{Serialize, de::DeserializeOwned};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

pub fn read_json<T: DeserializeOwned>(path: &Path) -> Option<T> {
    serde_json::from_slice(&fs::read(path).ok()?).ok()
}

fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(format!(".{}.tmp", std::process::id()));
    PathBuf::from(name)
}

fn parent(path: &Path) -> &Path {
    path.parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or(Path::new("."))
}

pub fn write_json_atomic<T: Serialize>(path: &Path, value: &T) -> io::Result<()> {
    fs::create_dir_all(parent(path))?;
    let bytes = serde_json::to_vec(value)?;
    let tmp = temporary_path(path);
    fs::write(&tmp, bytes)?;
    fs::rename(tmp, path)
}

pub fn write_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = parent(path);
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(parent)?;
        fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(parent)?;
    let tmp = temporary_path(path);
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&tmp)?;
    let result = file.write_all(bytes).and_then(|()| fs::rename(&tmp, path));
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;
    #[test]
    fn atomic_json_matches_json_stringify() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("a/b.json");
        write_json_atomic(&p, &serde_json::json!({"rev":1,"id":"t"})).unwrap();
        assert_eq!(
            std::fs::read_to_string(&p).unwrap(),
            r#"{"rev":1,"id":"t"}"#
        );
        assert_eq!(read_json::<serde_json::Value>(&p).unwrap()["rev"], 1);
    }
    #[test]
    fn missing_or_invalid_json_is_none() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("bad.json");
        assert!(read_json::<u64>(&p).is_none());
        std::fs::write(&p, "{").unwrap();
        assert!(read_json::<u64>(&p).is_none());
    }
    #[cfg(unix)]
    #[test]
    fn private_files_are_0600_in_0700_dirs() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("private/token");
        write_private(&p, b"secret").unwrap();
        assert_eq!(
            std::fs::metadata(&p).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            std::fs::metadata(p.parent().unwrap())
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o700
        );
        write_private(&p, b"replacement").unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"replacement");
    }
}
