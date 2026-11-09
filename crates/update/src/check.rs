//! `update.check`: `checkForUpdate` in `src/update/check.ts`, then the `update` config publication.
use crate::{Code, CoreError, feed, js, object, received, refuse_enforcement};
use pacer_foundation::{Ctx, api::OpFuture, js_semantics::js_trim};
use pacer_store::publish_config_change;
use serde_json::{Map, Value, json};
use std::{fs, path::Path, sync::OnceLock};

const CACHE_S: f64 = 86_400.0;
const DEV_VERSION: &str = "0.0.0-dev";

/// `currentVersion()`: the build define, else the workspace package version.
fn current_version() -> &'static str {
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

/// A cached `latest` that is an array passes `isVersion` through `String(array)` coercion in
/// TypeScript and is then reported as is; only the reference reproduces that.
pub(crate) fn stays_forwarded(ctx: &Ctx) -> bool {
    checks_enabled(ctx) && cache_document(ctx).is_some_and(|doc| doc["latest"].is_array())
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
        let Some(check) = check else {
            return Ok(
                json!({"current": current, "latest": null, "available": false, "plugin": null, "disabled": true}),
            );
        };
        let available = check.latest.as_deref().is_some_and(|latest| {
            !latest.is_empty() && is_version(current) && compare_versions(latest, current) > 0
        });
        let mut result = json!({"current": current, "latest": check.latest, "available": available, "plugin": null});
        if js::truthy(&check.error) {
            result["error"] = check.error;
        }
        Ok(result)
    })
}

struct Check {
    checked_at: f64,
    latest: Option<String>,
    error: Value,
}

async fn check_for_update(ctx: &Ctx, force: bool) -> Option<Check> {
    if !checks_enabled(ctx) {
        return None;
    }
    let cached = read_cache(ctx);
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
        match tokio::task::spawn_blocking(move || feed::latest(base.as_deref())).await {
            Ok(Ok(version)) => (Some(version), None),
            Ok(Err(message)) => (latest, Some(message)),
            Err(e) => (latest, Some(e.to_string())),
        };
    let check = Check {
        checked_at: ctx.now,
        latest,
        error: error.map_or(Value::Null, Value::String),
    };
    write_cache(ctx, &check);
    Some(check)
}

/// `updateChecksEnabled`: the env opt-out, then a top-level `update_check: false` in the active strategy text.
fn checks_enabled(ctx: &Ctx) -> bool {
    if ctx.env.get("PACER_NO_UPDATE_CHECK").map(String::as_str) == Some("1") {
        return false;
    }
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
    fs::read(&path).map_or(true, |bytes| {
        !update_check_false(&String::from_utf8_lossy(&bytes))
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

/// `readUpdateCheck`: a finite `checkedAt` and a `latest` that is null or a version.
fn read_cache(ctx: &Ctx) -> Option<Check> {
    let doc = cache_document(ctx)?;
    let checked_at = doc.get("checkedAt")?.as_f64()?;
    let latest = match doc.get("latest") {
        Some(Value::Null) => None,
        Some(Value::String(v)) if is_version(v) => Some(v.clone()),
        _ => return None,
    };
    Some(Check {
        checked_at,
        latest,
        error: doc.get("error").cloned().unwrap_or(Value::Null),
    })
}

/// `JSON.stringify(result) + "\n"` through a temporary file and rename; failures are ignored.
fn write_cache(ctx: &Ctx, check: &Check) {
    let mut text = format!(
        "{{\"checkedAt\":{},\"latest\":{},\"current\":{}",
        js::number_text(check.checked_at),
        check.latest.as_deref().map_or(Value::Null, Value::from),
        Value::from(current_version()),
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
