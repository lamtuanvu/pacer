use std::{
    fs,
    io::{self, Write},
    path::Path,
};

pub(crate) fn private_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(path)?;
    Ok(())
}

pub(crate) fn append(path: &Path, bytes: &[u8]) -> io::Result<()> {
    append_with_mode(path, bytes, false)
}

pub(crate) fn append_publication(path: &Path, bytes: &[u8]) -> io::Result<()> {
    append_with_mode(path, bytes, true)
}

fn append_with_mode(path: &Path, bytes: &[u8], publication: bool) -> io::Result<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    if publication {
        fs::create_dir_all(parent)?;
    } else {
        private_dir(parent)?;
    }
    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(if publication { 0o666 } else { 0o600 });
    }
    options.open(path)?.write_all(bytes)
}

pub(crate) fn atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    atomic_with_mode(path, bytes, false)
}

pub(crate) fn atomic_publication(path: &Path, bytes: &[u8]) -> io::Result<()> {
    atomic_with_mode(path, bytes, true)
}

fn atomic_with_mode(path: &Path, bytes: &[u8], publication: bool) -> io::Result<()> {
    let parent = path.parent().unwrap_or(Path::new("."));
    if publication {
        fs::create_dir_all(parent)?;
    } else {
        private_dir(parent)?;
    }
    let tmp = path.with_file_name(format!(
        "{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(if publication { 0o666 } else { 0o600 });
    }
    let result = (|| {
        options.open(&tmp)?.write_all(bytes)?;
        fs::rename(&tmp, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}

pub(crate) fn json_bytes(value: &serde_json::Value) -> io::Result<Vec<u8>> {
    serde_json::to_vec(value).map_err(io::Error::other)
}

pub(crate) fn js_number(value: f64) -> serde_json::Value {
    if value.is_finite()
        && value.fract() == 0.0
        && value >= i64::MIN as f64
        && value < i64::MAX as f64
    {
        serde_json::Value::from(value as i64)
    } else {
        serde_json::json!(value)
    }
}
