//! Native `notifications.test`, `.ack`, `.request` and `.health` operations.
//!
//! Ports `src/core/notification-health.ts` and `src/install/notifications-check.ts`.
//! Rust owns the health record, the presenter choice, the published `notify`/`control`
//! events and the doctor `Check` reply; the client registry comes from [`crate::client_ops`].
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::{read_json, write_json_atomic},
    lock::{LockOptions, with_lock_async},
};
use pacer_store::publish;
use serde_json::{Map, Number, Value, json};
use std::{
    future::Future,
    path::PathBuf,
    time::Duration,
};

use crate::client_ops::live_entries;
#[cfg(test)]
use crate::client_ops::heartbeat;

#[cfg(test)]
mod tests;

pub const NOTIFICATION_OPS: &[&str] = &[
    "notifications.test",
    "notifications.ack",
    "notifications.request",
    "notifications.health",
];

/// `REQUEST_DEFAULT_WAIT_S` and `REQUEST_MAX_WAIT_S` in `notification-health.ts`.
pub const REQUEST_DEFAULT_WAIT_S: u64 = 20;
pub const REQUEST_MAX_WAIT_S: u64 = 25;

const LOCK_OPTIONS: LockOptions = LockOptions {
    timeout: Duration::from_secs(20),
    stale: Duration::from_secs(120),
};
const LEVELS: &[&str] = &["off", "important", "all"];

fn health_path(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("state").join("notification-health.json")
}

fn settings_path(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("settings.json")
}

/// `js_number`: whole finite values print as integers, like `JSON.stringify`.
fn js_number(n: f64) -> Option<Value> {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        return Some(Value::from(n as i64));
    }
    Number::from_f64(n).map(Value::Number)
}

fn now_value(ctx: &Ctx) -> Result<Value, CoreError> {
    js_number(ctx.now).ok_or_else(|| CoreError::new(Code::Internal, "clock is not finite"))
}

fn uuid() -> String {
    let mut bytes: [u8; 16] = rand::random();
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex = hex::encode(bytes);
    format!(
        "{}-{}-{}-{}-{}",
        &hex[..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..]
    )
}

// Published params, in Zod's issue order.

fn type_name(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn expected(name: &str, kind: &str, value: Option<&Value>) -> String {
    format!(
        "{name}: Invalid input: expected {kind}, received {}",
        type_name(value)
    )
}

fn too_small(name: &str, kind: &str, min: usize) -> String {
    format!("{name}: Too small: expected {kind} to have >={min} characters")
}

fn too_big(name: &str, kind: &str, max: usize) -> String {
    format!("{name}: Too big: expected {kind} to have <={max} characters")
}

fn params_object(params: &Value) -> Result<Map<String, Value>, CoreError> {
    match params {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map.clone()),
        other => Err(CoreError::new(
            Code::InvalidInput,
            format!(
                "params: Invalid input: expected object, received {}",
                type_name(Some(other))
            ),
        )),
    }
}

fn finish(issues: Vec<String>) -> Result<(), CoreError> {
    if issues.is_empty() {
        Ok(())
    } else {
        Err(CoreError::new(Code::InvalidInput, issues.join("; ")))
    }
}

fn text_field(name: &str, value: Option<&Value>, max: usize, issues: &mut Vec<String>) {
    match value.and_then(Value::as_str) {
        None => issues.push(expected(name, "string", value)),
        Some("") => issues.push(too_small(name, "string", 1)),
        Some(text) if text.chars().count() > max => issues.push(too_big(name, "string", max)),
        Some(_) => {}
    }
}

fn validate_test(p: &Map<String, Value>) -> Result<(), CoreError> {
    // `z.object({})` accepts (and strips) extra keys; it only requires an object.
    let _ = p;
    Ok(())
}

fn validate_ack(p: &Map<String, Value>) -> Result<(), CoreError> {
    let mut issues = Vec::new();
    text_field("client_id", p.get("client_id"), 128, &mut issues);
    text_field("key", p.get("key"), 512, &mut issues);
    if !p.get("delivered").is_some_and(Value::is_boolean) {
        issues.push(expected("delivered", "boolean", p.get("delivered")));
    }
    if let Some(error) = p.get("error") {
        if !error.is_null() && error.as_str().is_none() {
            issues.push(expected("error", "string", Some(error)));
        } else if let Some(text) = error.as_str() {
            if text.chars().count() > 512 {
                issues.push(too_big("error", "string", 512));
            }
        }
    }
    finish(issues)
}

fn validate_request(p: &Map<String, Value>) -> Result<(), CoreError> {
    let mut issues = Vec::new();
    if let Some(wait) = p.get("wait_s") {
        match wait.as_f64() {
            None => issues.push(expected("wait_s", "number", Some(wait))),
            Some(n) => {
                if !n.is_finite() || n.fract() != 0.0 {
                    issues.push(format!("wait_s: Invalid input: expected int, received number"));
                } else if n < 0.0 {
                    issues.push("wait_s: Too small: expected number to be >=0".into());
                } else if n > REQUEST_MAX_WAIT_S as f64 {
                    issues.push(format!(
                        "wait_s: Too big: expected number to be <={REQUEST_MAX_WAIT_S}"
                    ));
                }
            }
        }
    }
    finish(issues)
}

fn validate_health(p: &Map<String, Value>) -> Result<(), CoreError> {
    let _ = p;
    Ok(())
}

/// The pending-test record (`NotificationHealthRecord`).
fn read_health(ctx: &Ctx) -> Map<String, Value> {
    read_json::<Value>(&health_path(ctx))
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default()
}

fn write_health(ctx: &Ctx, record: &Map<String, Value>) -> Result<(), CoreError> {
    write_json_atomic(&health_path(ctx), &Value::Object(record.clone()))
        .map_err(|e| CoreError::new(Code::Internal, e.to_string()))
}

/// `cleanError`: strip C0/C1 controls (including ESC) and cap at 512 UTF-16 units,
/// matching JavaScript's `String.slice(0, 512)`.
fn clean_error(message: &str) -> String {
    let mut out = String::new();
    let mut units = 0usize;
    for c in message.chars() {
        let n = c as u32;
        if (0x00..=0x1f).contains(&n) || (0x7f..=0x9f).contains(&n) {
            continue;
        }
        if units + c.len_utf16() > 512 {
            break;
        }
        units += c.len_utf16();
        out.push(c);
    }
    out
}

/// `deliveryPresenters` in `src/clients/registry.ts`, over the same live registry.
fn delivery_presenters(ctx: &Ctx) -> Vec<(String, &'static str, &'static str)> {
    let live = live_entries(ctx);
    let pick = |medium: &str, kinds: &[&str]| -> Option<(String, &'static str)> {
        live.iter()
            .rev()
            .find(|entry| {
                entry.get("notifier") == Some(&Value::Bool(true))
                    && entry
                        .get("kind")
                        .and_then(Value::as_str)
                        .is_some_and(|kind| kinds.contains(&kind))
            })
            .and_then(|entry| {
                entry
                    .get("client_id")
                    .and_then(Value::as_str)
                    .map(|id| (id.to_owned(), medium_kind(medium)))
            })
    };
    let os = pick("os", &["desktop"]);
    let terminal = pick("terminal", &["tui"]);
    let browser = pick("browser", &["app"]);
    let mut out = Vec::new();
    if let Some((id, kind)) = os {
        out.push((id, kind, "os"));
    }
    if let Some((id, kind)) = terminal {
        out.push((id, kind, "terminal"));
    }
    if let Some((id, kind)) = browser {
        if !out.iter().any(|(_, _, medium)| *medium == "os") {
            out.push((id, kind, "browser"));
        }
    }
    out
}

fn medium_kind(medium: &str) -> &'static str {
    match medium {
        "os" => "desktop",
        "terminal" => "tui",
        _ => "app",
    }
}

fn has_live_desktop(ctx: &Ctx) -> bool {
    live_entries(ctx)
        .iter()
        .any(|entry| entry.get("kind").and_then(Value::as_str) == Some("desktop"))
}

/// `testNotification` (`notification-health.ts:35-74`).
pub fn notification_test(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        validate_test(&params_object(&params)?)?;
        let presenters = delivery_presenters(ctx);
        let Some(os) = presenters.iter().find(|(_, _, medium)| *medium == "os") else {
            if has_live_desktop(ctx) {
                return Err(CoreError::new(
                    Code::Unavailable,
                    "macOS blocks pacer notifications",
                )
                .hint("Turn on Allow notifications for pacer in System Settings › Notifications."));
            }
            return Err(CoreError::new(Code::Unavailable, "The pacer app isn't open")
                .hint("Open the pacer app, then retry."));
        };
        let key = format!("test:{}", uuid());
        let sent_at = now_value(ctx)?;
        let client_id = os.0.clone();

        let pending = with_lock_async(ctx, "notifications", LOCK_OPTIONS, || async {
            let mut next = read_health(ctx);
            next.insert("key".into(), Value::String(key.clone()));
            next.insert("client_id".into(), Value::String(client_id.clone()));
            next.insert("sent_at".into(), sent_at.clone());
            next.remove("acked_at");
            next.remove("delivered");
            write_health(ctx, &next)
        })
        .await;
        match pending {
            Ok(Ok(())) => {}
            Ok(Err(e)) => return Err(e),
            Err(e) => {
                return Err(CoreError::new(Code::Internal, format!("notification lock: {e}")))
            }
        }

        let rollback = async {
            let _ = with_lock_async(ctx, "notifications", LOCK_OPTIONS, || async {
                let mut current = read_health(ctx);
                if current.get("key").and_then(Value::as_str) == Some(key.as_str()) {
                    current.remove("key");
                    current.remove("client_id");
                    current.remove("sent_at");
                    write_health(ctx, &current)?;
                }
                Ok::<(), CoreError>(())
            })
            .await;
        };
        let event = json!({
            "type": "entity",
            "data": {
                "kind": "notify",
                "id": key,
                "value": {
                    "key": key,
                    "title": "pacer test notification",
                    "body": "If you see this, banners work.",
                    "recipients": [client_id],
                    "client_id": client_id,
                },
            },
        });
        let report = publish(ctx, &[event]);
        if !report.transports.contains(&"outbox") {
            rollback.await;
            return Err(CoreError::new(
                Code::Unavailable,
                "notification publish failed",
            ));
        }
        Ok(json!({"key": key, "client_id": client_id, "sent_at": sent_at}))
    })
}

/// `ackNotification` (`notification-health.ts:76-95`).
pub fn notification_ack(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = params_object(&params)?;
        validate_ack(&p)?;
        let client_id = p["client_id"].as_str().unwrap_or_default().to_owned();
        let key = p["key"].as_str().unwrap_or_default().to_owned();
        let delivered = p.get("delivered").and_then(Value::as_bool).unwrap_or(false);
        let error = p
            .get("error")
            .and_then(Value::as_str)
            .map(clean_error)
            .unwrap_or_else(|| clean_error("delivery failed"));
        let live_desktop = live_entries(ctx).iter().any(|entry| {
            entry.get("client_id").and_then(Value::as_str) == Some(client_id.as_str())
                && entry.get("kind").and_then(Value::as_str) == Some("desktop")
        });
        if !live_desktop {
            return Err(CoreError::new(
                Code::NotAllowed,
                "notifications.ack requires a live desktop client",
            ));
        }
        let now = now_value(ctx)?;
        let updated = with_lock_async(ctx, "notifications", LOCK_OPTIONS, || async {
            let current = read_health(ctx);
            if current.get("key").and_then(Value::as_str) == Some(key.as_str())
                && current
                    .get("client_id")
                    .and_then(Value::as_str)
                    .is_some_and(|id| id != client_id)
            {
                return Err(CoreError::new(
                    Code::NotAllowed,
                    "notifications.ack client mismatch",
                ));
            }
            let mut next = current.clone();
            if delivered {
                next.insert("last_ok_at".into(), now.clone());
            } else {
                next.insert(
                    "last_error".into(),
                    json!({"at": now, "message": error}),
                );
            }
            if current.get("key").and_then(Value::as_str) == Some(key.as_str()) {
                next.insert("acked_at".into(), now.clone());
                next.insert("delivered".into(), Value::Bool(delivered));
            }
            write_health(ctx, &next)?;
            Ok(())
        })
        .await;
        match updated {
            Ok(Ok(())) => Ok(json!({"ok": true})),
            Ok(Err(e)) => Err(e),
            Err(e) => Err(CoreError::new(Code::Internal, format!("notification lock: {e}"))),
        }
    })
}

/// `requestAuthorization` (`notification-health.ts:101-123`) with an injectable clock and
/// sleep so tests can observe a permission change without waiting in real time.
pub async fn request_authorization_with<NOW, F, FUT>(
    ctx: &Ctx,
    wait_s: Option<u64>,
    now: NOW,
    mut sleep: F,
) -> Result<Value, CoreError>
where
    NOW: Fn() -> f64,
    F: FnMut(Duration) -> FUT,
    FUT: Future<Output = ()>,
{
    let live = live_entries(ctx);
    let desktop = live
        .iter()
        .rev()
        .find(|entry| entry.get("kind").and_then(Value::as_str) == Some("desktop"))
        .ok_or_else(|| {
            CoreError::new(Code::Unavailable, "The pacer app isn't open")
                .hint("Open the pacer app, then retry.")
        })?;
    let client_id = desktop
        .get("client_id")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let wait = wait_s.unwrap_or(REQUEST_DEFAULT_WAIT_S).min(REQUEST_MAX_WAIT_S);
    let deadline = now() + (wait as f64) * 1000.0;
    let event = json!({
        "type": "entity",
        "data": {
            "kind": "control",
            "id": format!("notifications.request:{}", uuid()),
            "value": {
                "action": "notifications.request",
                "recipients": [client_id],
                "client_id": client_id,
            },
        },
    });
    publish(ctx, &[event]);
    let mut permission = desktop
        .get("notification_permission")
        .and_then(Value::as_str)
        .map(str::to_owned);
    while now() <= deadline {
        let entry = live_entries(ctx)
            .into_iter()
            .find(|entry| entry.get("client_id").and_then(Value::as_str) == Some(client_id.as_str()));
        if let Some(entry) = entry {
            permission = entry
                .get("notification_permission")
                .and_then(Value::as_str)
                .map(str::to_owned);
        }
        if permission
            .as_deref()
            .is_some_and(|value| value != "not_determined")
        {
            break;
        }
        sleep(Duration::from_millis(500)).await;
    }
    let last = live_entries(ctx)
        .into_iter()
        .find(|entry| entry.get("client_id").and_then(Value::as_str) == Some(client_id.as_str()));
    let permission = last
        .as_ref()
        .and_then(|entry| entry.get("notification_permission"))
        .cloned();
    let mut out = Map::new();
    out.insert("client_id".into(), Value::String(client_id));
    if let Some(permission) = permission {
        out.insert("permission".into(), permission);
    }
    Ok(Value::Object(out))
}

/// The reference clock is `Date.now()` (milliseconds), not `ctx.now` (Unix seconds).
fn real_now_ms() -> f64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

pub fn notification_request(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let p = params_object(&params)?;
        validate_request(&p)?;
        let wait_s = p
            .get("wait_s")
            .and_then(Value::as_u64)
            .or_else(|| p.get("wait_s").and_then(Value::as_f64).map(|n| n as u64));
        request_authorization_with(ctx, wait_s, real_now_ms, tokio::time::sleep).await
    })
}

/// Port of `getLevel` (`src/core/notify.ts:17-35`): read the notification level,
/// including the legacy plugin setting, and persist the effective value.
fn notification_level(ctx: &Ctx) -> String {
    let settings = read_json::<Value>(&settings_path(ctx))
        .and_then(|value| value.as_object().cloned())
        .unwrap_or_default();
    if let Some(level) = settings.get("notifications").and_then(Value::as_str) {
        if LEVELS.contains(&level) {
            return level.to_owned();
        }
    }
    let legacy = read_json::<Value>(&plugin_settings_path(ctx))
        .and_then(|value| value.get("notifications").and_then(Value::as_str).map(str::to_owned))
        .filter(|level| LEVELS.contains(&level.as_str()))
        .unwrap_or_else(|| "important".to_owned());
    let mut next = settings;
    next.insert("notifications".into(), Value::String(legacy.clone()));
    let _ = write_json_atomic(&settings_path(ctx), &Value::Object(next));
    legacy
}

/// `pluginDataDir` (`src/link/paths.ts`) for the legacy notification setting.
fn plugin_settings_path(ctx: &Ctx) -> PathBuf {
    let user_data = if let Some(dir) = ctx.env.get("PACER_ORCA_USER_DATA") {
        PathBuf::from(dir)
    } else {
        match std::env::consts::OS {
            "macos" => ctx.home.join("Library/Application Support/orca"),
            "windows" => ctx
                .env
                .get("APPDATA")
                .map(PathBuf::from)
                .unwrap_or_else(|| ctx.home.join("AppData/Roaming"))
                .join("orca"),
            _ => ctx
                .env
                .get("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| ctx.home.join(".config"))
                .join("orca"),
        }
    };
    user_data
        .join("plugins-data")
        .join("lamtuanvu.pacer")
        .join("settings.json")
}

fn remedy_allow() -> Value {
    json!({"kind": "auto", "label": "Allow notifications", "op": "notifications.request"})
}

fn remedy_settings(caption: &str) -> Value {
    json!({
        "kind": "user",
        "label": "Open Notification settings",
        "url": "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
        "caption": caption,
    })
}

fn remedy_test() -> Value {
    json!({"kind": "auto", "label": "Send test notification", "op": "notifications.test"})
}

fn check(name: &str, level: &str, detail: &str) -> Value {
    json!({"name": name, "level": level, "detail": detail})
}

/// `notificationsCheck` (`src/install/notifications-check.ts:8-61`), key order and all.
pub fn notifications_check(ctx: &Ctx) -> Value {
    let level = notification_level(ctx);
    let live = live_entries(ctx);
    let presenters = delivery_presenters(ctx);
    let os_presenter = presenters.iter().find(|(_, _, medium)| *medium == "os");
    let desktop = os_presenter
        .and_then(|presenter| {
            live.iter()
                .find(|entry| entry.get("client_id").and_then(Value::as_str) == Some(presenter.0.as_str()))
        })
        .or_else(|| {
            live.iter()
                .rev()
                .find(|entry| entry.get("kind").and_then(Value::as_str) == Some("desktop"))
        });
    let health = read_health(ctx);
    if level == "off" {
        return check("Notifications", "info", "Notifications are off");
    }
    let Some(desktop) = desktop else {
        let mut out = check(
            "Notifications",
            "info",
            "The pacer app isn't open; banners come from the system fallback",
        );
        out["evidence"] = Value::String("unverified".into());
        return out;
    };
    let permission = desktop.get("notification_permission").and_then(Value::as_str);
    let alerts = desktop.get("notification_alerts").and_then(Value::as_str);
    let number = |entry: &Map<String, Value>, key: &str| -> f64 {
        entry.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
    };
    match permission {
        Some("unsupported") => check("Notifications", "info", "This development build can't post banners"),
        None => {
            let registered = number(desktop, "registeredAt");
            let detail = if ctx.now - registered < 10.0 {
                "Checking notification permission…"
            } else {
                "Update the pacer app to check notifications"
            };
            check("Notifications", "info", detail)
        }
        Some("not_determined") => {
            let mut out = check("Notifications", "warn", "Notification permission not asked yet");
            out["remedy"] = remedy_allow();
            out
        }
        Some("denied") => {
            let mut out = check("Notifications", "warn", "Notifications are blocked in System Settings");
            out["remedy"] = remedy_settings("Turn on Allow notifications for pacer");
            out
        }
        Some(_) if permission == Some("provisional") || alerts == Some("none") => {
            let mut out = check("Notifications", "warn", "Notifications arrive quietly, without banners");
            out["remedy"] = remedy_settings("Choose Banners for pacer");
            out
        }
        Some(_) => {
            let last_ok = health.get("last_ok_at").and_then(Value::as_f64);
            let last_error = health.get("last_error").and_then(Value::as_object);
            let error_at = last_error.and_then(|e| e.get("at")).and_then(Value::as_f64);
            let error_message = last_error
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or_default();
            let sent_at = health.get("sent_at").and_then(Value::as_f64);
            let acked_at = health.get("acked_at").and_then(Value::as_f64);
            let last_error_newer = error_at.is_some_and(|at| last_ok.is_none_or(|ok| at > ok));
            let unacked = health.get("key").is_some()
                && sent_at.is_some()
                && acked_at.is_none_or(|ack| sent_at.is_some_and(|sent| ack < sent))
                && sent_at.is_some_and(|sent| ctx.now - sent > 15.0);
            if last_error_newer || unacked {
                let detail = if last_error_newer {
                    format!("The banner was rejected: {error_message}")
                } else {
                    "The desktop didn't confirm the test notification".to_owned()
                };
                let mut out = check("Notifications", "warn", &detail);
                out["remedy"] = remedy_test();
                return out;
            }
            let changed_at = desktop.get("permission_changed_at").and_then(Value::as_f64);
            let delivered = health.get("delivered").and_then(Value::as_bool) == Some(true);
            let tested = permission == Some("authorized")
                && delivered
                && sent_at.is_some()
                && acked_at.is_some_and(|ack| sent_at.is_some_and(|sent| ack >= sent))
                && changed_at.is_none_or(|changed| acked_at.is_some_and(|ack| ack >= changed));
            if tested {
                let mut out = check("Notifications", "ok", "Banners allowed · test delivered");
                out["evidence"] = Value::String("tested".into());
                out["tested_at"] = js_number(acked_at.unwrap_or(0.0)).unwrap_or(Value::Null);
                return out;
            }
            let mut out = check("Notifications", "ok", "Banners allowed · not tested yet");
            out["evidence"] = Value::String("configured".into());
            out
        }
    }
}

pub fn notification_health(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        validate_health(&params_object(&params)?)?;
        Ok(notifications_check(ctx))
    })
}

/// Exercise the registry heartbeat from the notification tests.
#[cfg(test)]
pub(crate) fn heartbeat_permission(ctx: &Ctx, client_id: &str, permission: &str) {
    let mut params = Map::new();
    params.insert("client_id".into(), Value::String(client_id.to_owned()));
    params.insert(
        "notification_permission".into(),
        Value::String(permission.to_owned()),
    );
    let _ = heartbeat(ctx, &params);
}

/// Native operation table provided to `pacer-server`.
pub const fn ops() -> &'static [pacer_foundation::api::NativeOp] {
    &[
        pacer_foundation::api::NativeOp {
            name: "notifications.test",
            call: notification_test,
        },
        pacer_foundation::api::NativeOp {
            name: "notifications.ack",
            call: notification_ack,
        },
        pacer_foundation::api::NativeOp {
            name: "notifications.request",
            call: notification_request,
        },
        pacer_foundation::api::NativeOp {
            name: "notifications.health",
            call: notification_health,
        },
    ]
}
