//! Bounded, synchronous lifecycle logging: each line is written before returning.
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::PathBuf,
    sync::{Mutex, OnceLock},
};

const MAX_BYTES: u64 = 5 * 1024 * 1024;
static LOG: OnceLock<Mutex<Option<LogWriter>>> = OnceLock::new();

struct LogWriter {
    path: PathBuf,
    limit: u64,
}
impl LogWriter {
    fn write(&self, line: &str) -> io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::DirBuilder::new()
                .recursive(true)
                .mode(0o700)
                .create(parent)?;
        }
        // Keep one previous file. Both files are bounded to 5 MiB.
        if fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0) + line.len() as u64 > self.limit {
            let backup = self.path.with_extension("log.1");
            match fs::remove_file(&backup) {
                Ok(()) => {}
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(e),
            }
            if self.path.exists() {
                fs::rename(&self.path, backup)?;
            }
        }
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .mode(0o600)
            .open(&self.path)?;
        file.write_all(line.as_bytes())?;
        file.flush()
    }
}
fn default_path() -> Option<PathBuf> {
    let home = PathBuf::from(std::env::var_os("HOME")?);
    #[cfg(target_os = "macos")]
    let dir = home.join("Library/Logs/pacer");
    #[cfg(not(target_os = "macos"))]
    let dir = std::env::var_os("XDG_STATE_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".local/state"))
        .join("pacer");
    Some(dir.join("desktop.log"))
}
pub fn write(args: std::fmt::Arguments<'_>) {
    // Callers pass controlled diagnostics, never CLI output, tokens or sign-in URLs.
    let message: String = args
        .to_string()
        .chars()
        .take(16_000)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let line = format!("{stamp} {message}\n");
    eprint!("{line}");
    let writer = LOG.get_or_init(|| {
        Mutex::new(default_path().map(|path| LogWriter {
            path,
            limit: MAX_BYTES,
        }))
    });
    if let Some(writer) = writer.lock().unwrap().as_ref() {
        if let Err(error) = writer.write(&line) {
            eprintln!("pacer desktop log write failed: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn log_writer_appends_and_rotates_at_limit_with_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!(
            "pacer-desktop-log-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let writer = LogWriter {
            path: dir.join("desktop.log"),
            limit: 12,
        };
        writer.write("first\n").unwrap();
        writer.write("again\n").unwrap(); // exactly the limit does not rotate
        assert_eq!(fs::read_to_string(&writer.path).unwrap(), "first\nagain\n");
        writer.write("next\n").unwrap();
        assert_eq!(
            fs::read_to_string(writer.path.with_extension("log.1")).unwrap(),
            "first\nagain\n"
        );
        writer.write("newest\n").unwrap();
        writer.write("last\n").unwrap(); // replaces the previous backup
        assert_eq!(
            fs::read_to_string(writer.path.with_extension("log.1")).unwrap(),
            "next\nnewest\n"
        );
        assert_eq!(fs::read_to_string(&writer.path).unwrap(), "last\n");
        assert_eq!(
            fs::metadata(&writer.path).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert_eq!(
            fs::metadata(&dir).unwrap().permissions().mode() & 0o777,
            0o700
        );
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn log_writer_reports_io_failure() {
        let writer = LogWriter {
            path: PathBuf::from("/dev/null/desktop.log"),
            limit: MAX_BYTES,
        };
        assert!(writer.write("failure\n").is_err());
    }
}
