//! Durable activity and outbox records shared with the TypeScript core.

use pacer_foundation::{
    Ctx,
    fsutil::write_private,
    lock::{LockOptions, with_lock},
};
use serde_json::{Value, json};
use std::{
    fs::{self, OpenOptions},
    io::{self, Write},
    path::Path,
    thread,
    time::{Duration, Instant},
};

const OUTBOX_MAX_BYTES: usize = 1024 * 1024;
const OUTBOX_KEEP: usize = 1000;

fn js_number(value: f64) -> Value {
    if value.fract() == 0.0 && value.abs() <= 9_007_199_254_740_991.0 {
        json!(value as i64)
    } else {
        json!(value)
    }
}

fn private_dir(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
        fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(path)?;
        if fs::symlink_metadata(path)?.file_type().is_symlink() {
            return Err(io::Error::other("private state directory is a symlink"));
        }
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    #[cfg(not(unix))]
    fs::create_dir_all(path)?;
    Ok(())
}

fn append_private(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        private_dir(parent)?;
    }
    let mut options = OpenOptions::new();
    options.append(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    let mut file = options.open(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        let metadata = file.metadata()?;
        if !metadata.is_file() || metadata.nlink() != 1 {
            return Err(io::Error::other(
                "private state file must be regular with one link",
            ));
        }
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(bytes)
}

struct FileGuard(std::path::PathBuf);
impl Drop for FileGuard {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

/// Use the activity.lock protocol from `src/activity/log.ts`, including stale
/// takeover, so a Rust append never races a TypeScript log rotation.
fn with_activity_lock<T>(ctx: &Ctx, f: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
    let dir = ctx.pacer_home.join("state");
    private_dir(&dir)?;
    let path = dir.join("activity.lock");
    let start = Instant::now();
    let _guard = loop {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(_) => break FileGuard(path),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
                match fs::metadata(&path) {
                    Ok(meta)
                        if meta
                            .modified()?
                            .elapsed()
                            .is_ok_and(|age| age > Duration::from_secs(120)) =>
                    {
                        match fs::remove_file(&path) {
                            Ok(()) => continue,
                            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                            Err(error) => return Err(error),
                        }
                    }
                    Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                    Err(error) => return Err(error),
                    _ => {}
                }
                if start.elapsed() > Duration::from_secs(10) {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "timed out waiting for activity log lock",
                    ));
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error),
        }
    };
    f()
}

fn empty_snapshot() -> Value {
    json!({"v":1,"seq":0,"at":0,"budget":null,"mode":null,"tasks":[],"alerts":[],"console":null,"consoles":[],"strategies":[]})
}

fn publish(ctx: &Ctx, event: Value) -> io::Result<()> {
    let result = with_lock(
        ctx,
        "link",
        LockOptions {
            timeout: Duration::from_secs(5),
            ..Default::default()
        },
        || {
            let dir = ctx.pacer_home.join("link");
            let latest = dir.join("latest.json");
            let mut snapshot = fs::read(&latest)
                .ok()
                .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
                .filter(|v| {
                    v.get("v") == Some(&json!(1))
                        && v.get("seq").is_some_and(Value::is_number)
                        && v.get("at").is_some_and(Value::is_number)
                })
                .unwrap_or_else(empty_snapshot);
            let seq = snapshot["seq"].as_u64().unwrap_or(0) + 1;
            snapshot["seq"] = json!(seq);
            snapshot["at"] = js_number(ctx.now);
            if event["type"] == "alert" {
                let alert = event["data"].clone();
                let mut alerts = vec![alert.clone()];
                if let Some(existing) = snapshot["alerts"].as_array() {
                    alerts.extend(
                        existing
                            .iter()
                            .filter(|row| row["key"] != alert["key"])
                            .cloned(),
                    );
                }
                alerts.sort_by(|left, right| {
                    right["at"]
                        .as_f64()
                        .unwrap_or(0.0)
                        .total_cmp(&left["at"].as_f64().unwrap_or(0.0))
                });
                alerts.truncate(10);
                snapshot["alerts"] = Value::Array(alerts);
            }
            let row = json!({"seq":seq,"at":js_number(ctx.now),"envelope":event});
            let mut bytes = serde_json::to_vec(&row)?;
            bytes.push(b'\n');
            let outbox = dir.join("outbox.jsonl");
            append_private(&outbox, &bytes)?;
            let existing = fs::read(&outbox)?;
            if existing.len() > OUTBOX_MAX_BYTES
                || existing.iter().filter(|b| **b == b'\n').count() > OUTBOX_KEEP
            {
                let lines: Vec<&[u8]> = existing
                    .split(|b| *b == b'\n')
                    .filter(|line| !line.is_empty())
                    .collect();
                let mut kept = lines[lines.len().saturating_sub(OUTBOX_KEEP)..].join(&b'\n');
                kept.push(b'\n');
                write_private(&outbox, &kept)?;
            }
            write_private(&latest, &serde_json::to_vec(&snapshot)?)
        },
    );
    result.map_err(io::Error::other)?
}

/// Record the existing config mutation's activity entry and refresh event.
/// Publishing is best effort in the TypeScript core; an activity append error
/// still fails the operation after the settings write.
pub fn record_config_change(ctx: &Ctx) -> io::Result<()> {
    record_config_change_area(ctx, "config")
}

/// A strategy mutation with no separate alert, such as removing a named file.
pub fn record_strategy_change(ctx: &Ctx) -> io::Result<()> {
    record_config_change_area(ctx, "strategy")
}

/// A routing edit publishes the same activity and config pair as the core.
pub fn record_routing_change(ctx: &Ctx) -> io::Result<()> {
    record_config_change_area(ctx, "routing")
}

/// A runner edit publishes the same activity and config pair as the core.
pub fn record_runner_change(ctx: &Ctx) -> io::Result<()> {
    record_config_change_area(ctx, "runners")
}

fn record_config_change_area(ctx: &Ctx, area: &str) -> io::Result<()> {
    let mut random = [0u8; 2];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    let id = format!("{}-{:02x}{:02x}", ctx.now, random[0], random[1]);
    let entry = json!({"kind":"config","level":"info","text":format!("Configuration changed · {area}"),"id":id,"at":js_number(ctx.now)});
    let mut bytes = serde_json::to_vec(&entry)?;
    bytes.push(b'\n');
    with_activity_lock(ctx, || {
        append_private(&ctx.pacer_home.join("state/activity.jsonl"), &bytes)
    })?;
    let _ = publish(
        ctx,
        json!({"type":"entity","data":{"kind":"activity","id":id,"value":entry}}),
    );
    let _ = publish(
        ctx,
        json!({"type":"config","data":{"area":area,"at":js_number(ctx.now)}}),
    );
    Ok(())
}

/// Match strategy.use's alert, activity append and refresh sequence. Outbox
/// delivery is best effort; a failed activity append still fails the operation.
pub fn record_strategy_switch(ctx: &Ctx, name: &str) -> io::Result<()> {
    let _ = publish(
        ctx,
        json!({"type":"alert","data":{
            "key":"strategy-switch","level":"info",
            "title":format!("Switched to strategy {name}"),"body":"Nothing to do.",
            "notification":{"kind":"strategy","strategy":name},"at":js_number(ctx.now)
        }}),
    );
    record_config_change_area(ctx, "strategy")
}

#[cfg(test)]
mod tests;
