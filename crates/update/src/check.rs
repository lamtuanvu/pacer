//! `update.check`: `checkForUpdate` in `src/update/check.ts`, then the `update` config publication.
use crate::{
    Code, CoreError,
    feed::{self, Channel},
    js, manager, object, received, refuse_enforcement,
};
use pacer_foundation::{Ctx, api::OpFuture, js_semantics::js_trim};
use pacer_store::publish_config_change;
use serde_json::{Map, Value, json};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
};

const CACHE_S: f64 = 86_400.0;
const DEV_VERSION: &str = "0.0.0-dev";

/// `currentVersion()`: the build define, else the workspace package version.
pub fn current_version() -> &'static str {
    static VERSION: OnceLock<String> = OnceLock::new();
    VERSION.get_or_init(|| {
        if let Some(version) = option_env!("PACER_BUILD_VERSION") {
            return version.into();
        }
        serde_json::from_str::<Value>(include_str!("../../../package.json"))
            .ok()
            .and_then(|pkg| pkg["version"].as_str().map(str::to_owned))
            .filter(|v| is_version(v))
            .unwrap_or_else(|| DEV_VERSION.into())
    })
}

/// `updateManager(ctx, defaultUpdateDeps(ctx))` from `src/api/ops.ts:177-179`: a desktop
/// owner refusal wins, then the install-method hint. `execPath` is `PACER_BIN || process.execPath`
/// and the dirname of the running executable is the bundle exemption, as in `owner.ts:82`.
fn managed(ctx: &Ctx) -> Option<manager::UpdateManager> {
    let exe = std::env::current_exe().ok();
    let exec_path = ctx
        .env
        .get("PACER_BIN")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| exe.clone())
        .unwrap_or_default();
    let exec_dir = exe
        .as_deref()
        .and_then(Path::parent)
        .unwrap_or_else(|| Path::new(""));
    let nightly = update_channel(ctx) == Channel::Nightly;
    manager::update_manager(ctx, &exec_path, exec_dir, nightly)
}

fn managed_fields(result: &mut Value, ctx: &Ctx) {
    if let Some(manager) = managed(ctx) {
        let by = match manager.by {
            manager::ManagedBy::Desktop => "desktop",
            manager::ManagedBy::Homebrew => "homebrew",
            manager::ManagedBy::Npm => "npm",
        };
        result["managedBy"] = json!(by);
        result["managedHint"] = json!(manager.message);
    }
}

pub fn update_check(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        refuse_enforcement(ctx)?;
        let map = object(&params)?;
        let force = match map.get("force") {
            None => false,
            Some(Value::Bool(force)) => *force,
            Some(other) => {
                return Err(CoreError::new(
                    Code::InvalidInput,
                    format!(
                        "force: Invalid input: expected boolean, received {}",
                        received(Some(other))
                    ),
                ));
            }
        };
        let check = check_for_update(ctx, force).await;
        publish_config_change(ctx, "update").map_err(|e| {
            CoreError::new(Code::Internal, format!("update publication failed: {e}"))
        })?;
        let current = current_version();
        let mut result = match check {
            None => {
                json!({"current": current, "latest": Value::Null, "available": false, "plugin": null, "disabled": true})
            }
            Some(check) => {
                // `updateAvailable`: `String(array)` is what `isVersion`/`compareVersions` see,
                // while the reply carries the cached value itself (`src/update/check.ts:30-32`).
                let available = check.latest.as_ref().is_some_and(|latest| {
                    let text = js::js_string_of_array(latest);
                    !text.is_empty() && is_version(current) && compare_versions(&text, current) > 0
                });
                let mut value = json!({"current": current, "latest": check.latest, "available": available, "plugin": null});
                if js::truthy(&check.error) {
                    value["error"] = check.error;
                }
                value
            }
        };
        managed_fields(&mut result, ctx);
        Ok(result)
    })
}

struct Check {
    checked_at: f64,
    latest: Option<Value>,
    error: Value,
}

async fn check_for_update(ctx: &Ctx, force: bool) -> Option<Check> {
    if !checks_enabled(ctx) {
        return None;
    }
    let channel = update_channel(ctx);
    let cached = read_cache(ctx, channel);
    if !force
        && cached
            .as_ref()
            .is_some_and(|c| ctx.now >= c.checked_at && ctx.now - c.checked_at < CACHE_S)
    {
        return cached;
    }
    let latest = cached.and_then(|c| c.latest);
    let base = ctx
        .env
        .get("PACER_RELEASE_BASE")
        .filter(|b| !b.is_empty())
        .cloned();
    let (latest, error) =
        match tokio::task::spawn_blocking(move || feed::latest_for(base.as_deref(), channel)).await
        {
            Ok(Ok((version, error))) => (Some(Value::String(version)), error),
            Ok(Err(message)) => (latest, Some(message)),
            Err(e) => (latest, Some(e.to_string())),
        };
    let check = Check {
        checked_at: ctx.now,
        latest,
        error: error.map_or(Value::Null, Value::String),
    };
    write_cache(ctx, &check, channel);
    Some(check)
}

/// `activeStrategyText`: the named active strategy, else `strategy.yaml`; `None` when unreadable.
fn strategy_text(ctx: &Ctx) -> Option<String> {
    let active = fs::read_to_string(ctx.pacer_home.join("active"))
        .map(|text| js_trim(&text).to_owned())
        .unwrap_or_default();
    let named = !active.is_empty()
        && active
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-');
    let path = if named {
        ctx.pacer_home
            .join("strategies")
            .join(format!("{active}.yaml"))
    } else {
        ctx.pacer_home.join("strategy.yaml")
    };
    fs::read(&path)
        .ok()
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
}

/// `updateChecksEnabled`: the env opt-out, then a top-level `update_check: false` in the active strategy text.
fn checks_enabled(ctx: &Ctx) -> bool {
    if ctx.env.get("PACER_NO_UPDATE_CHECK").map(String::as_str) == Some("1") {
        return false;
    }
    strategy_text(ctx).is_none_or(|text| !update_check_false(&text))
}

/// `updateChannel`: nightly only for a top-level `update_channel: nightly` (plain or quoted).
fn update_channel(ctx: &Ctx) -> Channel {
    if strategy_text(ctx).is_some_and(|text| update_channel_nightly(&text)) {
        Channel::Nightly
    } else {
        Channel::Stable
    }
}

/// `/^update_channel:[ \t]*(["']?)nightly\1[ \t]*(?:#.*)?$/m`.
pub(crate) fn update_channel_nightly(text: &str) -> bool {
    let blank = |c: char| c == ' ' || c == '\t';
    text.split(js::line_end).any(|line| {
        let Some(rest) = line.strip_prefix("update_channel:") else {
            return false;
        };
        let rest = rest.trim_start_matches(blank);
        ["nightly", "\"nightly\"", "'nightly'"].iter().any(|value| {
            rest.strip_prefix(value).is_some_and(|tail| {
                let tail = tail.trim_start_matches(blank);
                tail.is_empty() || tail.starts_with('#')
            })
        })
    })
}

/// `/^update_check:\s*false\s*(?:#.*)?$/m`.
pub(crate) fn update_check_false(text: &str) -> bool {
    let mut start = true;
    for (at, c) in text.char_indices() {
        if start && text[at..].starts_with("update_check:") {
            let rest = text[at + "update_check:".len()..].trim_start_matches(js::space);
            if let Some(after) = rest.strip_prefix("false") {
                let tail = after.trim_start_matches(js::space);
                let run = &after[..after.len() - tail.len()];
                if tail.is_empty() || tail.starts_with('#') || run.contains(js::line_end) {
                    return true;
                }
            }
        }
        start = js::line_end(c);
    }
    false
}

fn cache_path(ctx: &Ctx) -> std::path::PathBuf {
    ctx.pacer_home.join("update-check.json")
}

fn cache_document(ctx: &Ctx) -> Option<Map<String, Value>> {
    let text = fs::read(cache_path(ctx)).ok()?;
    match serde_json::from_slice::<Value>(&text).ok()? {
        Value::Object(map) => Some(map),
        _ => None,
    }
}

/// `readUpdateCheck`: a finite `checkedAt`, a `latest` that is null or a value whose
/// `String(value)` is a version (an array coerces through `Array.prototype.join`), and the
/// current channel (a record without one is stable).
fn read_cache(ctx: &Ctx, channel: Channel) -> Option<Check> {
    let doc = cache_document(ctx)?;
    let checked_at = doc.get("checkedAt")?.as_f64()?;
    let latest = match doc.get("latest") {
        None | Some(Value::Null) => None,
        Some(value) if is_version(&js::js_string_of_array(value)) => Some(value.clone()),
        _ => return None,
    };
    let same_channel = match doc.get("channel") {
        None | Some(Value::Null) => channel == Channel::Stable,
        Some(Value::String(c)) => c == channel.as_str(),
        Some(_) => false,
    };
    if !same_channel {
        return None;
    }
    Some(Check {
        checked_at,
        latest,
        error: doc.get("error").cloned().unwrap_or(Value::Null),
    })
}

/// `JSON.stringify(result) + "\n"` through a temporary file and rename; failures are ignored.
fn write_cache(ctx: &Ctx, check: &Check, channel: Channel) {
    let mut text = format!(
        "{{\"checkedAt\":{},\"latest\":{},\"current\":{},\"channel\":\"{}\"",
        js::number_text(check.checked_at),
        check.latest.clone().unwrap_or(Value::Null),
        Value::from(current_version()),
        channel.as_str(),
    );
    if let Value::String(error) = &check.error {
        text.push_str(&format!(",\"error\":{}", Value::from(error.as_str())));
    }
    text.push_str("}\n");
    let path = cache_path(ctx);
    let temp = path.with_file_name(format!(
        "update-check.json.{}.{:x}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.subsec_nanos())
    ));
    let written = fs::create_dir_all(&ctx.pacer_home)
        .and_then(|()| fs::write(&temp, text))
        .and_then(|()| fs::rename(&temp, &path));
    if written.is_err() {
        let _ = fs::remove_file(Path::new(&temp));
    }
}

fn semver(v: &str) -> Option<(&str, &str, &str, Option<&str>)> {
    let (core, build) = v.split_once('+').map_or((v, None), |(c, b)| (c, Some(b)));
    if build.is_some_and(|b| !b.split('.').all(identifier)) {
        return None;
    }
    let (numbers, pre) = match core.split_once('-') {
        Some((numbers, pre)) if pre.split('.').all(identifier) => (numbers, Some(pre)),
        Some(_) => return None,
        None => (core, None),
    };
    let mut parts = numbers.split('.');
    let (major, minor, patch) = (parts.next()?, parts.next()?, parts.next()?);
    let numeric = |n: &str| {
        !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && (n == "0" || !n.starts_with('0'))
    };
    (parts.next().is_none() && numeric(major) && numeric(minor) && numeric(patch))
        .then_some((major, minor, patch, pre))
}

fn identifier(part: &str) -> bool {
    !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// `isNightlyVersion`: `X.Y.Z-nightly.<12 digits, no leading zero>` (`src/update/channel.ts`).
pub(crate) fn is_nightly_version(v: &str) -> bool {
    let Some((core, stamp)) = v.split_once("-nightly.") else {
        return false;
    };
    let numeric = |n: &str| {
        !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit()) && (n == "0" || !n.starts_with('0'))
    };
    let mut parts = core.split('.');
    let core_ok = (0..3).all(|_| parts.next().is_some_and(numeric)) && parts.next().is_none();
    core_ok
        && stamp.len() == 12
        && stamp.bytes().all(|b| b.is_ascii_digit())
        && !stamp.starts_with('0')
}

/// `isVersion`: the SEMVER pattern of `src/update/version.ts`.
pub(crate) fn is_version(v: &str) -> bool {
    semver(v).is_some()
}

/// `compareVersions` by semver precedence; build metadata does not affect ordering.
pub(crate) fn compare_versions(a: &str, b: &str) -> i32 {
    let (Some(pa), Some(pb)) = (semver(a), semver(b)) else {
        return 0;
    };
    let number = |n: &str| n.parse::<f64>().unwrap_or(f64::INFINITY);
    for (x, y) in [(pa.0, pb.0), (pa.1, pb.1), (pa.2, pb.2)] {
        let d = number(x) - number(y);
        if d != 0.0 {
            return if d > 0.0 { 1 } else { -1 };
        }
    }
    match (pa.3, pb.3) {
        (ra, rb) if ra == rb => 0,
        (None, _) => 1,
        (_, None) => -1,
        (Some(ra), Some(rb)) => {
            let (xa, xb): (Vec<_>, Vec<_>) = (ra.split('.').collect(), rb.split('.').collect());
            for i in 0..xa.len().max(xb.len()) {
                let (Some(x), Some(y)) = (xa.get(i), xb.get(i)) else {
                    return if xa.get(i).is_none() { -1 } else { 1 };
                };
                if x == y {
                    continue;
                }
                let digits = |s: &str| s.bytes().all(|b| b.is_ascii_digit());
                return match (digits(x), digits(y)) {
                    (true, true) => {
                        let d = number(x) - number(y);
                        if d > 0.0 {
                            1
                        } else if d < 0.0 {
                            -1
                        } else {
                            0
                        }
                    }
                    (true, false) => -1,
                    (false, true) => 1,
                    // JavaScript `<` compares UTF-16 code units; identifiers are ASCII.
                    (false, false) => {
                        if x < y {
                            -1
                        } else {
                            1
                        }
                    }
                };
            }
            0
        }
    }
}
