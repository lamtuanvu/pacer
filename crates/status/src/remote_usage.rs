//! Cached passive (remote) usage, ported from `src/remote/usage.ts`
//! (`cachedRemoteUsage`, B12-2).

use pacer_foundation::Ctx;
use pacer_foundation::fsutil::read_json;
use serde_json::{Map, Value, json};

/// `cachePath` (remote/usage.ts:10): the per-account remote-usage cache file.
pub fn remote_usage_cache_path(ctx: &Ctx, name: &str) -> std::path::PathBuf {
    ctx.pacer_home
        .join("cache")
        .join("remote-usage")
        .join(format!("{name}.json"))
}

/// `cachedRemoteUsage` (remote/usage.ts:16-25). Returns `Some` with the cached
/// reading or a stale copy, or `None` when there is no usable cache. `hosts` is
/// the host table; `None` is TypeScript's "hosts not provided" case (an empty
/// table with a `remoteHost` that is not present counts as a mismatch).
pub fn cached_remote_usage(ctx: &Ctx, account: &Value, hosts: Option<&Value>) -> Option<Value> {
    let cache: Map<String, Value> = match read_json(&remote_usage_cache_path(
        ctx,
        account.get("name").and_then(Value::as_str).unwrap_or(""),
    )) {
        Some(c) => c,
        None => return None,
    };
    let reading = cache.get("reading").cloned().unwrap_or(Value::Null);
    let version = cache.get("version").and_then(Value::as_f64);
    let identity = cache.get("identity").and_then(Value::as_str);
    let source_identity = cache.get("sourceIdentity").and_then(Value::as_str);
    let remote_host = reading.get("remoteHost").and_then(Value::as_str);
    let host = match (hosts, remote_host) {
        (Some(hosts), Some(name)) if !name.is_empty() => hosts.get(name),
        _ => None,
    };
    let same_source = match hosts {
        None => true,
        Some(_) => match host {
            Some(h) => source_identity
                .map(|s| s == origin(h, account))
                .unwrap_or(false),
            None => false,
        },
    };
    let captured_at = reading.get("capturedAt").and_then(Value::as_f64);
    let has_windows = reading.get("windows").is_some_and(Value::is_array);
    if reading.is_null()
        || !captured_at.is_some_and(|c| c.is_finite())
        || !has_windows
        || remote_host.is_none()
    {
        return None;
    }
    let expected = pacer_config::evidence::evidence_identity(account, &json!({}));
    if version == Some(3.0) && same_source && identity == Some(&expected) {
        return Some(reading);
    }
    // Stale copy: spread the reading, drop `alternatives`, null `capturedAt`,
    // mark stale (`JSON.stringify` omits the `alternatives` key set to
    // undefined by the spread).
    if let Some(reading_obj) = reading.as_object() {
        let mut stale = reading_obj.clone();
        stale.remove("alternatives");
        stale.insert("capturedAt".to_owned(), Value::Null);
        stale.insert("stale".to_owned(), json!(true));
        Some(Value::Object(stale))
    } else {
        None
    }
}

/// `origin` (remote/usage.ts): the canonical identity of a host for an
/// account, mirroring `JSON.stringify([host.alias, host.ssh, home])`.
fn origin(host: &Value, account: &Value) -> String {
    let name = account.get("name").and_then(Value::as_str).unwrap_or("");
    let home = host
        .get("accounts")
        .and_then(|a| a.get(name))
        .and_then(|h| h.get("home"))
        .cloned()
        .unwrap_or(Value::Null);
    let mut arr = Vec::new();
    arr.push(host.get("alias").cloned().unwrap_or(Value::Null));
    arr.push(host.get("ssh").cloned().unwrap_or(Value::Null));
    arr.push(home);
    pacer_js_json::stringify(&Value::Array(arr))
}
