//! `update.check`: `checkForUpdate` in `src/update/check.ts`, then the `update` config publication.
use crate::{
    Code, CoreError,
    channel::{checks_enabled, compare_versions, is_version, update_channel},
    feed::{self, Channel},
    js, object, received, refuse_enforcement,
};
use pacer_foundation::{Ctx, api::OpFuture};
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
    (checks_enabled(ctx) && cache_document(ctx).is_some_and(|doc| doc["latest"].is_array()))
        || maybe_managed_elsewhere(ctx)
}

/// Whether `updateManager` in `src/api/ops.ts` may report `managedBy`: a desktop owner record,
/// an npm or Homebrew install, or an app-bundled executable. Over-approximates, since a
/// forwarded check is always the reference answer.
fn maybe_managed_elsewhere(ctx: &Ctx) -> bool {
    let set = |key: &str| ctx.env.get(key).is_some_and(|value| !value.is_empty());
    if set("PACER_INSTALL_METHOD") || set("HOMEBREW_PREFIX") || set("HOMEBREW_CELLAR") {
        return true;
    }
    let owner = fs::read_to_string(ctx.pacer_home.join("owner.json")).ok();
    if owner
        .and_then(|text| serde_json::from_str::<Value>(&text).ok())
        .is_some_and(|doc| doc["owner"] == "desktop")
    {
        return true;
    }
    let bin = ctx
        .env
        .get("PACER_BIN")
        .filter(|path| !path.is_empty())
        .map(std::path::PathBuf::from);
    let exe = std::env::current_exe().ok();
    // Both the given and the resolved path, like `isBundledExecutable`, whose bundle match ignores case.
    [bin, exe].into_iter().flatten().any(|path| {
        let real = fs::canonicalize(&path).ok();
        [Some(path), real].into_iter().flatten().any(|candidate| {
            let text = candidate.to_string_lossy().to_lowercase();
            text.contains("/cellar/pacer/") || text.contains(".app/contents/")
        })
    })
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
            Ok(Ok((version, error))) => (Some(version), error),
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

/// `readUpdateCheck`: a finite `checkedAt`, a `latest` that is null or a version, and the
/// current channel (a record without one is stable).
fn read_cache(ctx: &Ctx, channel: Channel) -> Option<Check> {
    let doc = cache_document(ctx)?;
    let checked_at = doc.get("checkedAt")?.as_f64()?;
    let latest = match doc.get("latest") {
        Some(Value::Null) => None,
        Some(Value::String(v)) if is_version(v) => Some(v.clone()),
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
        check.latest.as_deref().map_or(Value::Null, Value::from),
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
