use crate::file::{append, atomic, js_number, json_bytes, private_dir};
use crate::outbox::slice_utf16;
use pacer_foundation::Ctx;
use rand::RngCore;
use regex::Regex;
use serde_json::{Value, json};
use std::{
    fs,
    io::{self, Read},
    path::PathBuf,
    thread,
    time::{Duration, Instant},
};

const KINDS: &[&str] = &[
    "policy",
    "plugin_state",
    "task_started",
    "task_settled",
    "verdict",
    "retry",
    "message",
    "mode",
    "budget_refreshed",
    "executor_state",
    "host_state",
    "account_state",
    "config",
    "update",
];
const RETENTION_S: f64 = 30.0 * 86400.0;

#[derive(Default)]
pub struct ActivityOptions<'a> {
    pub before: Option<&'a str>,
    pub limit: Option<usize>,
    pub repo: Option<&'a str>,
    pub kinds: Option<&'a [&'a str]>,
    pub task_id: Option<&'a str>,
    pub max_bytes: Option<usize>,
}

pub struct ActivityPage {
    pub entries: Vec<Value>,
    pub next: Option<String>,
}

fn log_path(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("state/activity.jsonl")
}

fn with_log_lock<T>(ctx: &Ctx, action: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
    let dir = ctx.pacer_home.join("state");
    private_dir(&dir)?;
    let lock = dir.join("activity.lock");
    let start = Instant::now();
    loop {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&lock) {
            Ok(_) => break,
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
                match fs::metadata(&lock) {
                    Ok(meta)
                        if meta
                            .modified()?
                            .elapsed()
                            .is_ok_and(|age| age > Duration::from_secs(120)) =>
                    {
                        match fs::remove_file(&lock) {
                            Ok(()) => {}
                            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                            Err(e) => return Err(e),
                        }
                        continue;
                    }
                    Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
                    Err(e) => return Err(e),
                    _ => {}
                }
                if start.elapsed() >= Duration::from_secs(10) {
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "timed out waiting for activity log lock",
                    ));
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(e) => return Err(e),
        }
    }
    let result = action();
    let _ = fs::remove_file(lock);
    result
}

fn replace(text: String, pattern: &str, replacement: &str) -> String {
    Regex::new(pattern).map_or(text.clone(), |re| {
        re.replace_all(&text, replacement).into_owned()
    })
}

fn safe_text(text: &str) -> String {
    let mut value = replace(
        text.to_owned(),
        r"(?i)authorization\s*[:=]\s*[^\r\n]*",
        "Authorization: [redacted]",
    );
    value = replace(
        value,
        r"(?i)(^|[^A-Za-z0-9_])Bearer\s+\S+",
        "${1}Bearer [redacted]",
    );
    value = replace(
        value,
        r"(?i)(^|[^A-Za-z0-9_])(?:sk|pk|api[_-]?key|token)[_-][A-Za-z0-9_-]+",
        "${1}[redacted]",
    );
    value = replace(
        value,
        r"(?i)((?:api[_-]?key|access[_-]?token|password)\s*[=:]\s*)[^\s,;]+",
        "${1}[redacted]",
    );
    value = slice_utf16(value.lines().next().unwrap_or(""), 500);
    value = replace(
        value,
        r"(?i)((?:^|[^A-Za-z0-9_])token\s*[=:]\s*)[^\s,;]+",
        "${1}[redacted]",
    );
    replace(
        value,
        r"(?i)[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}",
        "[redacted]",
    )
}

fn valid(entry: &Value) -> bool {
    entry.get("id").is_some_and(Value::is_string)
        && entry
            .get("at")
            .and_then(Value::as_f64)
            .is_some_and(f64::is_finite)
        && entry
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|v| KINDS.contains(&v))
        && entry
            .get("level")
            .and_then(Value::as_str)
            .is_some_and(|v| ["info", "warn", "error"].contains(&v))
        && entry.get("text").is_some_and(Value::is_string)
        && ["repo", "taskId", "executor", "host", "machineId"]
            .iter()
            .all(|key| entry.get(key).is_none_or(Value::is_string))
}

fn entries(ctx: &Ctx, max_bytes: Option<usize>) -> io::Result<Vec<Value>> {
    let path = log_path(ctx);
    let text = match max_bytes {
        None => match fs::read(path) {
            Ok(bytes) => String::from_utf8_lossy(&bytes).into_owned(),
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
            Err(e) => return Err(e),
        },
        Some(max) => {
            let mut file = match fs::File::open(&path) {
                Ok(f) => f,
                Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
                Err(e) => return Err(e),
            };
            let size = file.metadata()?.len() as usize;
            let start = size.saturating_sub(max);
            use std::io::Seek;
            file.seek(std::io::SeekFrom::Start(start as u64))?;
            let mut bytes = Vec::new();
            file.read_to_end(&mut bytes)?;
            let text = String::from_utf8_lossy(&bytes).into_owned();
            if start > 0 {
                text.split_once('\n')
                    .map_or(String::new(), |(_, rest)| rest.to_owned())
            } else {
                text
            }
        }
    };
    Ok(text
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(valid)
        .collect())
}

/// Appends one JSONL record under the same activity lock used by Bun, then publishes its entity event.
pub fn append_activity(ctx: &Ctx, mut input: Value) -> io::Result<Value> {
    let object = input
        .as_object_mut()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "activity must be an object"))?;
    let raw = object
        .get("text")
        .and_then(Value::as_str)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "activity text is required"))?;
    object.insert("text".into(), Value::String(safe_text(raw)));
    let mut random = [0u8; 2];
    rand::rng().fill_bytes(&mut random);
    object.insert(
        "id".into(),
        Value::String(format!("{}-{:02x}{:02x}", ctx.now, random[0], random[1])),
    );
    object.insert("at".into(), js_number(ctx.now));
    if let Some(id) =
        pacer_foundation::fsutil::read_json::<Value>(&ctx.pacer_home.join("identity/machine.json"))
            .and_then(|v| v.get("publicId").and_then(Value::as_str).map(str::to_owned))
    {
        object.insert("machineId".into(), Value::String(id));
    }
    if !valid(&input) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "invalid activity",
        ));
    }
    let mut line = json_bytes(&input)?;
    line.push(b'\n');
    with_log_lock(ctx, || append(&log_path(ctx), &line))?;
    let event = json!({"type":"entity","data":{"kind":"activity","id":input["id"],"value":input}});
    let _ = crate::publish::publish(ctx, &[event]);
    Ok(input)
}

pub fn read_activity(ctx: &Ctx, options: &ActivityOptions<'_>) -> io::Result<ActivityPage> {
    let all: Vec<Value> = entries(ctx, options.max_bytes)?.into_iter().rev().collect();
    let start = match options.before {
        None => 0,
        Some(before) => match all.iter().position(|e| e["id"] == before) {
            Some(index) => index + 1,
            None => {
                return Ok(ActivityPage {
                    entries: vec![],
                    next: None,
                });
            }
        },
    };
    let filtered: Vec<Value> = all
        .into_iter()
        .skip(start)
        .filter(|e| {
            options.repo.is_none_or(|v| e["repo"] == v)
                && options
                    .kinds
                    .is_none_or(|k| e["kind"].as_str().is_some_and(|v| k.contains(&v)))
                && options.task_id.is_none_or(|v| e["taskId"] == v)
        })
        .collect();
    let limit = options.limit.unwrap_or(50).clamp(1, 500);
    let next = (filtered.len() > limit)
        .then(|| filtered[limit - 1]["id"].as_str().unwrap_or("").to_owned());
    Ok(ActivityPage {
        entries: filtered.into_iter().take(limit).collect(),
        next,
    })
}

pub fn rotate_activity(ctx: &Ctx) -> io::Result<()> {
    with_log_lock(ctx, || {
        let marker = ctx.pacer_home.join("state/activity-rotation.json");
        if pacer_foundation::fsutil::read_json::<Value>(&marker)
            .and_then(|v| v.as_f64())
            .is_some_and(|last| ctx.now - last < 86400.0)
        {
            return Ok(());
        }
        let kept: Vec<Value> = entries(ctx, None)?
            .into_iter()
            .filter(|e| {
                e["at"]
                    .as_f64()
                    .is_some_and(|at| at >= ctx.now - RETENTION_S)
            })
            .rev()
            .take(20_000)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let mut bytes = Vec::new();
        for entry in kept {
            bytes.extend(json_bytes(&entry)?);
            bytes.push(b'\n');
        }
        atomic(&log_path(ctx), &bytes)?;
        atomic(&marker, &json_bytes(&js_number(ctx.now))?)
    })
}
