#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::{
    fs,
    io::{self, Write},
    path::Path,
};

/// Write next to the existing strategy, then rename so readers see complete YAML.
/// Strategy state is private even when the previous file or parent was permissive.
pub fn atomic_strategy_write(path: &Path, text: &str) -> io::Result<()> {
    if fs::metadata(path)?.is_dir() {
        return Err(io::Error::new(
            io::ErrorKind::IsADirectory,
            "strategy path is a directory",
        ));
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    #[cfg(unix)]
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    let (temp, mut file) = crate::temp_file::create(path)?;
    let result = (|| {
        file.write_all(text.as_bytes())?;
        file.flush()?;
        fs::rename(&temp, path)
    })();
    let _ = fs::remove_file(temp);
    result
}

#[cfg(test)]
mod tests;
