//! The native activity profile (`src/pace/activity.ts`) and its lock
//! protocol. Reads the user's Claude and Codex log files, builds a 168-bin
//! weekly activity profile, and caches it at `pacerHome/activity.json`.
//! `load_activity` reads the cached profile; `build_activity` rescans the
//! logs with an in-process cursor store keyed by file path. Rebuilds are
//! gated by an `activity.lock` file whose byte layout is fixed so the
//! TypeScript and Rust implementations exclude each other. There is no
//! `pacer _activity` child here: the rebuild runs on a blocking thread.

use chrono::{Datelike, TimeZone, Timelike};
use chrono_tz::Tz;
use pacer_foundation::Ctx;
use pacer_foundation::api::CoreError;
use pacer_js_json::stringify as js_stringify;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::PoisonError;
use std::sync::atomic::{AtomicBool, Ordering};

use crate::cursors::{Cursor, CursorStore, reusable};

const LOOKBACK_S: f64 = 28.0 * 86400.0;
const ACTIVITY_LOCK_STALE_S: f64 = 600.0;
const TS_MARKER: &[u8] = b"\"timestamp\":\"";
const BIN_COUNT: usize = 7 * 24;
const CACHE_AGE_S: f64 = 86400.0;

/// The naive-abstraction zone like `events_sse::local_zone`: `TZ` from the
/// ctx, else the process, else UTC.
pub fn local_zone(ctx: &Ctx) -> Tz {
    if let Some(name) = ctx.env.get("TZ")
        && let Ok(zone) = (*name).parse()
    {
        return zone;
    }
    std::env::var("TZ")
        .ok()
        .and_then(|name| name.parse().ok())
        .unwrap_or(chrono_tz::UTC)
}

/// `hourBin` (activity.ts:22): local weekday * 24 + hour.
pub fn hour_bin(ts: f64, zone: Tz) -> usize {
    let Some(local) = zone.timestamp_opt(ts.floor() as i64, 0).single() else {
        return 0;
    };
    (local.weekday().num_days_from_sunday() * 24 + local.hour()) as usize
}

/// `isCalendar` (src/pace/clock.ts): no profile, fewer than 7 days, or no
/// active bin.
pub fn is_calendar(profile: Option<&Value>) -> bool {
    let Some(p) = profile else {
        return true;
    };
    let days = p.get("days").and_then(Value::as_f64).unwrap_or(0.0);
    let active = p
        .get("active")
        .and_then(Value::as_array)
        .map(|a| a.iter().any(|b| b.as_bool().unwrap_or(false)))
        .unwrap_or(false);
    days < 7.0 || !active
}

/// `validHours` (activity.ts:53-58).
fn valid_hours(value: &Value) -> bool {
    let Some(obj) = value.as_object() else {
        return false;
    };
    obj.iter().all(|(hour, range)| {
        let h = match hour.parse::<i64>() {
            Ok(h) => h,
            Err(_) => return false,
        };
        let Some(arr) = range.as_array() else {
            return false;
        };
        if arr.len() != 2 || !arr.iter().all(|v| v.as_f64().is_some()) {
            return false;
        }
        let Some(o0) = arr[0].as_f64() else {
            return false;
        };
        let Some(o1) = arr[1].as_f64() else {
            return false;
        };
        let in_hour = arr.iter().all(|v| {
            v.as_f64()
                .is_some_and(|vf| (vf / 3600.0).floor() == h as f64)
        });
        in_hour && o0 <= o1
    })
}

fn cursor_path(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("state").join("activity-cursors.json")
}
fn activity_path(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("activity.json")
}

struct LogFile {
    path: PathBuf,
    info: (f64, f64, u64),
}

fn walk_files(dir: &Path, since: f64, out: &mut Vec<LogFile>) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(meta) = std::fs::metadata(&path) else {
            continue;
        };
        if meta.is_dir() {
            walk_files(&path, since, out);
        } else if meta.is_file() {
            let mtime = meta.mtime() as f64 * 1000.0;
            if mtime >= since {
                out.push(LogFile {
                    path,
                    info: (meta.len() as f64, mtime, meta.ino()),
                });
            }
        }
    }
}

/// `logFiles` (activity.ts:29-47): hand-written walks for
/// `~/.claude/projects/*/*.jsonl` and `~/.codex/sessions/**/rollout-*.jsonl`.
fn log_files(ctx: &Ctx, since: f64) -> Vec<LogFile> {
    let mut out = Vec::new();
    for base in [
        ctx.home.join(".claude").join("projects"),
        ctx.home.join(".codex").join("sessions"),
    ] {
        if base.exists() {
            walk_files(&base, since, &mut out);
        }
    }
    out
}

/// `parseTs` (src/util.ts): numeric-string or ISO to seconds; null unparseable.
fn parse_ts(raw: &str) -> Option<f64> {
    let s = raw.trim();
    if s.is_empty() {
        return None;
    }
    if let Ok(v) = s.parse::<f64>() {
        return Some(if v > 1e12 { v / 1000.0 } else { v });
    }
    chrono::DateTime::parse_from_rfc3339(s)
        .ok()
        .map(|dt| dt.timestamp() as f64)
}

fn find_sub(haystack: &[u8], needle: &[u8], start: usize) -> Option<usize> {
    if start >= haystack.len() || needle.is_empty() {
        return None;
    }
    haystack[start..]
        .windows(needle.len())
        .position(|w| w == needle)
        .map(|p| start + p)
}

/// `activityStamps` (activity.ts:64-104).
fn activity_stamps(
    path: &Path,
    previous: Option<&Cursor>,
    mut exact_window: Option<(f64, f64, &mut HashSet<i64>)>,
) -> std::io::Result<Cursor> {
    let file = std::fs::File::open(path)?;
    let meta = file.metadata()?;
    let stat = (meta.len() as f64, meta.mtime() as f64 * 1000.0, meta.ino());
    let cached = if reusable(previous, &stat) {
        previous
    } else {
        None
    };
    if let Some(c) = cached
        && c.size == stat.0
    {
        return Ok(c.clone());
    }
    let mut hours: serde_json::Map<String, Value> = cached
        .and_then(|c| c.aggregate.as_object().cloned())
        .unwrap_or_default();
    let mut offset_read = cached.map(|c| c.offset).unwrap_or(0.0);
    let cap = 256 * 1024;
    let mut buffer = vec![0u8; cap];
    let mut carry: Vec<u8> = Vec::new();
    while offset_read < stat.0 {
        let want = ((stat.0 - offset_read) as usize).min(cap);
        // Positional read at `offset_read`: `File::read` would read from the
        // handled's current position, but a resumed scan must continue from
        // the cached offset (the JS original uses a positional `file.read`).
        use std::os::unix::fs::FileExt;
        let n = file.read_at(&mut buffer[..want], offset_read as u64)?;
        if n == 0 {
            break;
        }
        let mut bytes = carry;
        bytes.extend_from_slice(&buffer[..n]);
        let mut next = 0usize;
        let keep;
        loop {
            let Some(start) = find_sub(&bytes, TS_MARKER, next) else {
                keep = bytes.len().saturating_sub(TS_MARKER.len() - 1);
                break;
            };
            let Some(rel) = bytes[start + TS_MARKER.len()..]
                .iter()
                .position(|&b| b == b'"')
            else {
                keep = start;
                break;
            };
            let end = start + TS_MARKER.len() + rel;
            let raw = &bytes[start + TS_MARKER.len()..end];
            if let Ok(txt) = std::str::from_utf8(raw)
                && let Some(ts) = parse_ts(txt)
            {
                let hour = (ts / 3600.0).floor();
                let prev = hours.get(&hour.to_string()).and_then(Value::as_array);
                let (lo, hi) = match prev {
                    Some(a) => (
                        a.first().and_then(Value::as_f64).unwrap_or(ts).min(ts),
                        a.get(1).and_then(Value::as_f64).unwrap_or(ts).max(ts),
                    ),
                    None => (ts, ts),
                };
                hours.insert(hour.to_string(), json!([lo, hi]));
                if let Some((s, now, set)) = exact_window.as_mut()
                    && ts >= *s
                    && ts <= *now
                {
                    set.insert(hour as i64);
                }
            }
            next = end + 1;
        }
        carry = bytes[keep..].to_vec();
        offset_read += n as f64;
    }
    Ok(Cursor {
        size: stat.0,
        mtime: stat.1,
        inode: stat.2,
        offset: offset_read - carry.len() as f64,
        aggregate: Value::Object(hours),
        retained_since: None,
    })
}

/// Process-global cursor stores keyed by cursor file path (`activityStores`).
fn stores() -> &'static std::sync::Mutex<std::collections::HashMap<PathBuf, Arc<CursorStore>>> {
    use std::sync::OnceLock;
    static STORES: OnceLock<
        std::sync::Mutex<std::collections::HashMap<PathBuf, Arc<CursorStore>>>,
    > = OnceLock::new();
    STORES.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// `build_activity` (activity.rs; activity.ts:106-162).
pub async fn build_activity(
    ctx: &Ctx,
    lookback_days: f64,
    threshold: f64,
) -> Result<Value, CoreError> {
    let since = ctx.now - lookback_days * 86400.0;
    let now = ctx.now;
    let zone = local_zone(ctx);
    let home = ctx.home.clone();
    let key = cursor_path(ctx);
    let store = {
        let mut guard = stores().lock().unwrap_or_else(PoisonError::into_inner);
        guard
            .entry(key.clone())
            .or_insert_with(|| CursorStore::new(key, valid_hours, 2))
            .clone()
    };
    let profile = store
        .run(false, move |cursors| {
            let files = log_files_for(&home, since);
            let live: HashSet<String> =
                files.iter().map(|f| f.path.display().to_string()).collect();
            let gone: Vec<String> = cursors
                .keys()
                .filter(|p| !live.contains(*p))
                .cloned()
                .collect();
            for p in gone {
                cursors.remove(&p);
            }
            let mut hours_set: HashSet<i64> = HashSet::new();
            for lf in &files {
                let path_str = lf.path.display().to_string();
                let previous = cursors.get(&path_str).cloned();
                let same_hour = (since / 3600.0).floor() == (now / 3600.0).floor();
                let usable = if !same_hour
                    && previous
                        .as_ref()
                        .map(|p| p.retained_since.is_none_or(|rs| since >= rs))
                        .unwrap_or(false)
                {
                    previous.clone()
                } else {
                    None
                };
                let reusable_now = reusable(usable.as_ref(), &lf.info);
                let unchanged = reusable_now && usable.as_ref().map(|u| u.size) == Some(lf.info.0);
                let cursor = if unchanged && let Some(usable) = usable.as_ref() {
                    usable.clone()
                } else {
                    match activity_stamps(
                        &lf.path,
                        usable.as_ref(),
                        if same_hour {
                            Some((since, now, &mut hours_set))
                        } else {
                            None
                        },
                    ) {
                        Ok(c) => c,
                        Err(_) => continue,
                    }
                };
                if !same_hour && let Some(obj) = cursor.aggregate.as_object() {
                    for (hour, range) in obj {
                        if let (Ok(h), Some(hi), Some(lo)) = (
                            hour.parse::<f64>(),
                            range.get(1).and_then(Value::as_f64),
                            range.get(0).and_then(Value::as_f64),
                        ) && hi >= since
                            && lo <= now
                        {
                            hours_set.insert(h as i64);
                        }
                    }
                }
                let retained_since = ((now - LOOKBACK_S) / 3600.0).floor() * 3600.0;
                let retained: Vec<(String, Value)> = cursor
                    .aggregate
                    .as_object()
                    .map(|o| {
                        o.iter()
                            .filter(|(hour, _)| {
                                hour.parse::<f64>()
                                    .map(|h| h * 3600.0 >= retained_since)
                                    .unwrap_or(false)
                            })
                            .map(|(k, v)| (k.clone(), v.clone()))
                            .collect()
                    })
                    .unwrap_or_default();
                let mut cursor = cursor;
                let kept = retained.len();
                if kept != cursor.aggregate.as_object().map(|o| o.len()).unwrap_or(0)
                    || cursor.retained_since.is_none()
                {
                    cursor.aggregate = Value::Object(retained.into_iter().collect());
                    cursor.retained_since = Some(retained_since);
                }
                cursors.insert(path_str, cursor);
            }
            let mut bins = vec![0i64; BIN_COUNT];
            let mut dates: HashSet<(i32, u32, u32)> = HashSet::new();
            for h in &hours_set {
                let ts = (*h as f64) * 3600.0;
                bins[hour_bin(ts, zone)] += 1;
                if let Some(local) = zone.timestamp_opt(ts as i64, 0).single() {
                    dates.insert((local.year(), local.month(), local.day()));
                }
            }
            let max = bins.iter().copied().max().unwrap_or(0);
            let active: Vec<bool> = bins
                .iter()
                .map(|b| max > 0 && (*b as f64) >= threshold * max as f64)
                .collect();
            json!({
                "builtAt": now,
                "days": dates.len(),
                "bins": bins,
                "active": active,
            })
        })
        .await;
    Ok(profile)
}

fn log_files_for(home: &Path, since: f64) -> Vec<LogFile> {
    let ctx = Ctx::with(
        home.to_path_buf(),
        home.join(".pacer"),
        std::collections::HashMap::new(),
        since,
    );
    log_files(&ctx, since)
}

fn uuid_v4() -> String {
    use std::io::Read;
    let mut rng = [0u8; 16];
    if let Ok(mut f) = std::fs::File::open("/dev/urandom") {
        let _ = f.read_exact(&mut rng);
    }
    rng[6] = (rng[6] & 0x0f) | 0x40;
    rng[8] = (rng[8] & 0x3f) | 0x80;
    let hex = rng.iter().map(|b| format!("{b:02x}")).collect::<String>();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// Match `tryActivityLock` (activity.ts:166-182): create `activity.lock`
/// with the exact bytes TS writes (`{"at","pid","token"}`, `wx`).
pub fn try_activity_lock(ctx: &Ctx) -> bool {
    let path = ctx.pacer_home.join("activity.lock");
    let _ = std::fs::create_dir_all(&ctx.pacer_home);
    if path.exists() {
        let at = pacer_foundation::fsutil::read_json::<Value>(&path)
            .and_then(|v| v.get("at").and_then(Value::as_f64))
            .filter(|a| a.is_finite())
            .unwrap_or_else(|| {
                std::fs::metadata(&path)
                    .map(|m| m.mtime() as f64)
                    .unwrap_or(0.0)
            });
        if ctx.now - at <= ACTIVITY_LOCK_STALE_S {
            return false;
        }
        let _ = std::fs::remove_file(&path);
    }
    let content = js_stringify(&json!({
        "at": ctx.now,
        "pid": std::process::id(),
        "token": uuid_v4(),
    }));
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    use std::os::unix::fs::OpenOptionsExt;
    options.mode(0o600);
    let write = options.open(&path).and_then(|mut f| {
        use std::io::Write;
        f.write_all(content.as_bytes())
    });
    if write.is_err() {
        return false;
    }
    pacer_foundation::fsutil::read_json::<Value>(&path)
        .and_then(|v| v.get("pid").and_then(Value::as_u64))
        == Some(std::process::id() as u64)
}

/// Match `releaseActivityLock` (activity.ts:184-193).
pub fn release_activity_lock(ctx: &Ctx) {
    let path = ctx.pacer_home.join("activity.lock");
    let lock = pacer_foundation::fsutil::read_json::<Value>(&path);
    let token = ctx.env.get("PACER_ACTIVITY_LOCK_TOKEN");
    let mine = match (
        token,
        lock.as_ref()
            .and_then(|v| v.get("token"))
            .and_then(Value::as_str),
    ) {
        (Some(t), Some(lt)) => t == lt,
        (Some(_), None) => false,
        (None, _) => {
            lock.as_ref()
                .and_then(|v| v.get("pid").and_then(Value::as_u64))
                == Some(std::process::id() as u64)
        }
    };
    if mine {
        let _ = std::fs::remove_file(&path);
    }
}

fn write_activity(ctx: &Ctx, profile: &Value) {
    let bytes = js_stringify(profile);
    let _ = pacer_foundation::fsutil::write_private(&activity_path(ctx), bytes.as_bytes());
}

/// `rebuildActivity` (activity.ts:195-203): rescan, write the cache, then
/// release the lock this process holds.
pub async fn rebuild_activity(ctx: &Ctx) -> Result<Value, CoreError> {
    let built = build_activity(ctx, 28.0, 0.2).await;
    if let Ok(p) = &built {
        write_activity(ctx, p);
    }
    release_activity_lock(ctx);
    built
}

/// In-process replacement for `backgroundRebuild` (activity.ts:207-229): runs
/// the rebuild on a blocking thread (no `pacer _activity` child), then
/// releases the lock held by the caller.
pub struct ActivityRebuilds {
    running: AtomicBool,
}

impl ActivityRebuilds {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            running: AtomicBool::new(false),
        })
    }

    /// A trigger that never spawns a rebuild - the same no-op trigger the TS
    /// golden tests pass to `loadActivity` so a stale-cache load returns the
    /// cached profile deterministically and leaves the lock in place.
    pub fn quiet() -> Arc<Self> {
        Arc::new(Self {
            running: AtomicBool::new(true),
        })
    }

    pub fn trigger(self: &Arc<Self>, ctx: Ctx) {
        if self.running.swap(true, Ordering::SeqCst) {
            return;
        }
        let this = self.clone();
        std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new();
            match rt {
                Ok(rt) => {
                    let _ = rt.block_on(rebuild_activity(&ctx));
                }
                Err(_) => release_activity_lock(&ctx),
            }
            this.running.store(false, Ordering::SeqCst);
        });
    }
}

/// `loadActivity` (activity.ts:231-254). Ok(None) is the TS `null` fallback.
pub async fn load_activity(
    ctx: &Ctx,
    read_only: bool,
    rebuilds: &Arc<ActivityRebuilds>,
) -> Result<Option<Value>, CoreError> {
    let cached = pacer_foundation::fsutil::read_json::<Value>(&activity_path(ctx));
    let cached = match cached {
        Some(value) if is_valid_profile(&value) => value,
        _ => {
            let fresh = build_activity(ctx, 28.0, 0.2).await?;
            if !read_only {
                write_activity(ctx, &fresh);
            }
            return Ok(Some(fresh));
        }
    };
    let built_at = cached.get("builtAt").and_then(Value::as_f64).unwrap_or(0.0);
    if ctx.now - built_at < CACHE_AGE_S {
        return Ok(Some(cached));
    }
    if !read_only && try_activity_lock(ctx) {
        rebuilds.trigger(ctx.clone());
    }
    Ok(Some(cached))
}

fn is_valid_profile(value: &Value) -> bool {
    match (
        value.get("bins").and_then(Value::as_array),
        value.get("active").and_then(Value::as_array),
    ) {
        (Some(bins), Some(active)) => bins.len() == BIN_COUNT && !active.is_empty(),
        _ => false,
    }
}
