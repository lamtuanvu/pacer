//! Named strategy activation and removal. Publication belongs to the caller.

use crate::strategy::{StrategyError, list_strategies, load_strategy, show_strategy};
use serde_json::{Value, json};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    fs, io,
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);

fn check_name(name: &str, writable: bool) -> Result<(), StrategyError> {
    let valid = !name.is_empty()
        && name.len() <= 40
        && (name.as_bytes()[0].is_ascii_lowercase() || name.as_bytes()[0].is_ascii_digit())
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-');
    if !valid || (writable && name == "default") {
        return Err(StrategyError::Other(format!(
            "invalid strategy name \"{name}\"{}",
            if writable {
                "; default is protected"
            } else {
                ""
            }
        )));
    }
    Ok(())
}

fn path_for(home: &Path, name: &str) -> Result<PathBuf, StrategyError> {
    if !list_strategies(home)?.iter().any(|known| known == name) {
        return Err(StrategyError::Other(format!("unknown strategy \"{name}\"")));
    }
    Ok(if name == "default" {
        home.join("strategy.yaml")
    } else {
        home.join("strategies").join(format!("{name}.yaml"))
    })
}

fn write_active(home: &Path, name: &str) -> io::Result<()> {
    fs::create_dir_all(home)?;
    #[cfg(unix)]
    fs::set_permissions(home, fs::Permissions::from_mode(0o700))?;
    let active = home.join("active");
    for _ in 0..16 {
        let nanos = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(io::Error::other)?
            .as_nanos();
        let temp = home.join(format!(
            "active.{}.{nanos}.{}.tmp",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        options.mode(0o600);
        let mut file = match options.open(&temp) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        };
        use std::io::Write;
        let result = (|| {
            file.write_all(format!("{name}\n").as_bytes())?;
            file.sync_all()?;
            fs::rename(&temp, &active)
        })();
        if result.is_err() {
            let _ = fs::remove_file(&temp);
        }
        return result;
    }
    Err(io::Error::new(
        io::ErrorKind::AlreadyExists,
        "could not create a unique strategy temp file",
    ))
}

/// Apply the service-level `strategy.use` file effect. The P3-B caller must
/// publish the strategy-switch alert after this succeeds.
pub fn use_strategy(home: &Path, name: &str) -> Result<Value, StrategyError> {
    show_strategy(home, name)?;
    let path = if name == "default" {
        let active = home.join("active");
        match fs::remove_file(active) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        home.join("strategy.yaml")
    } else {
        let path = home.join("strategies").join(format!("{name}.yaml"));
        write_active(home, name)?;
        path
    };
    Ok(json!({"name":name,"path":path}))
}

/// Apply the service-level `strategy.remove` file effect. The API caller
/// guards default and active names with its `not_allowed` error first.
pub fn remove_strategy(home: &Path, name: &str) -> Result<Value, StrategyError> {
    check_name(name, true)?;
    if load_strategy(home)?["name"] == name {
        return Err(StrategyError::Other(
            "cannot delete the active strategy".into(),
        ));
    }
    let path = path_for(home, name)?;
    fs::remove_file(path)?;
    Ok(json!({"name":name,"deleted":true}))
}
