//! Native `client.register`, `client.heartbeat`, `client.list` and `client.control.*`
//! (`src/clients/registry.ts`, `src/api/ops-client-control.ts`).
//!
//! Rust owns the published params (Zod issue order and text), the client registry file
//! `state/clients.json` byte for byte, and the control broker's workers and requests
//! ([`crate::client_control`]). Core keeps only the desktop capture broker's worker
//! credentials, which cross the sealed `client-control` bridge.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
};
use crate::client_control::SharedControl;
use pacer_js_json::quoted;
use serde_json::{Map, Number, Value, json};
use std::{
    fs,
    path::PathBuf,
    sync::{Mutex, PoisonError},
};

pub const CLIENT_OPS: &[&str] = &[
    "client.register",
    "client.heartbeat",
    "client.list",
    "client.control.enroll",
    "client.control.targets",
    "client.control.request",
    "client.control.result",
    "client.control.claim",
    "client.control.complete",
];

const KINDS: &[&str] = &["app", "desktop", "orca", "tui", "status", "tray", "cli"];
const PERMISSIONS: &[&str] = &[
    "not_determined",
    "denied",
    "authorized",
    "provisional",
    "ephemeral",
    "unsupported",
];
const ALERTS: &[&str] = &["none", "banner", "alert"];
const LEASE_S: u64 = 30;
const LAPSE_S: f64 = 45.0;
const KEEP_S: f64 = 86400.0;
const ID_MAX: usize = 128;
const ROUTE_MAX: usize = 2048;
const UUID_PATTERN: &str = "/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/";
const TOKEN_PATTERN: &str = "/^[0-9a-f]{64}$/";
const ROUTE_PATTERN: &str = r"/^\/(?!\/)[^\u0000-\u001f]*$/";
const DISCRIMINATOR: &str = "action.type: Invalid discriminator value. Expected 'theme.get' | 'theme.set' | 'navigate' | 'window' | 'tray' | 'launch-at-login' | 'quit'";

/// Serializes this process's read-modify-write of the registry file. TypeScript relied on
/// its single thread for the same guarantee.
static REGISTRY: Mutex<()> = Mutex::new(());

/// The one Core call left here: minting a desktop capture credential. See
/// `src/api/client-control-bridge.ts`.
pub trait ClientBridge: Send {
    fn call(&mut self, request: Value) -> OpFuture<'_>;
}

/// For callers without a Core channel; every bridged request reports it as unavailable.
pub struct NoBridge;

impl ClientBridge for NoBridge {
    fn call(&mut self, _: Value) -> OpFuture<'_> {
        Box::pin(async { Err(unavailable()) })
    }
}

fn unavailable() -> CoreError {
    CoreError::new(Code::Unavailable, "client control bridge unavailable")
}

pub fn is_client_op(op: &str) -> bool {
    CLIENT_OPS.contains(&op)
}

/// Only a capture credential still needs Core; control ops run in the door's broker.
pub fn needs_core(op: &str, params: &Value) -> bool {
    op == "client.register" && params.get("capture") == Some(&Value::Bool(true))
}

/// Registry entries for ops that only run through [`call`] with a bridge.
pub fn control_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async { Err(unavailable()) })
}

/// A broker for callers that reach the op through the registry rather than a door state.
fn process_control() -> &'static SharedControl {
    static CONTROL: std::sync::OnceLock<SharedControl> = std::sync::OnceLock::new();
    CONTROL.get_or_init(crate::client_control::shared)
}

pub fn client_register(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        call(
            ctx,
            "client.register",
            params,
            process_control(),
            &mut NoBridge,
        )
        .await
    })
}

pub fn client_heartbeat(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        call(
            ctx,
            "client.heartbeat",
            params,
            process_control(),
            &mut NoBridge,
        )
        .await
    })
}

pub fn client_list(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        call(ctx, "client.list", params, process_control(), &mut NoBridge).await
    })
}

/// Scoped identities get the same refusals as `authorizeWorkOperation` in `src/core/work.ts`,
/// before the params are read. All nine client ops are native; none of these grants owns them.
fn scoped_refusal(ctx: &Ctx) -> Result<(), CoreError> {
    if ctx
        .env
        .get("PACER_ASSISTANT_GRANT")
        .is_some_and(|token| !token.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "An assistant grant runs assistant.tool only.",
        ));
    }
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    if ctx
        .env
        .get("PACER_WORK_GRANT")
        .is_some_and(|token| !token.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Operation is not allowed by this work grant",
        ));
    }
    Ok(())
}

pub async fn call(
    ctx: &Ctx,
    op: &str,
    params: Value,
    control: &SharedControl,
    capture: &mut dyn ClientBridge,
) -> Result<Value, CoreError> {
    scoped_refusal(ctx)?;
    let p = params_object(&params)?;
    finish(issues(op, &p)?)?;
    match op {
        "client.register" => {
            let capture_worker = p.get("capture") == Some(&Value::Bool(true));
            let registration = register(ctx, &p)?;
            if !capture_worker {
                return Ok(registration);
            }
            let request =
                json!({"op": "client.capture.register", "client_id": registration["client_id"]});
            let worker = reply(capture.call(request).await?)?;
            let mut registration = registration;
            registration["capture_worker"] = worker;
            Ok(registration)
        }
        "client.heartbeat" => heartbeat(ctx, &p),
        "client.list" => Ok(Value::Array(
            live_entries(ctx).into_iter().map(Value::Object).collect(),
        )),
        "client.control.enroll" => {
            let kind = p["kind"].as_str().unwrap_or_default();
            let window = p["window"].as_str().unwrap_or_default();
            control.lock().await.enroll(kind, window)
        }
        "client.control.targets" => Ok(control.lock().await.targets()),
        "client.control.request" => {
            let id = p["client_id"].as_str().unwrap_or_default();
            control
                .lock()
                .await
                .request(id, p["action"].clone())
        }
        "client.control.result" => {
            control.lock().await.result(p["request_id"].as_str().unwrap_or_default())
        }
        "client.control.claim" => {
            control.lock().await.claim(
                p["client_id"].as_str().unwrap_or_default(),
                p["worker_token"].as_str().unwrap_or_default(),
            )
        }
        "client.control.complete" => {
            let error = p
                .get("error")
                .and_then(Value::as_str)
                .map(str::to_owned);
            control.lock().await.complete(
                p["request_id"].as_str().unwrap_or_default(),
                p["worker_token"].as_str().unwrap_or_default(),
                p.get("result").cloned(),
                error,
            )
        }
        _ => Err(CoreError::new(
            Code::UnknownOp,
            format!("unknown operation \"{op}\""),
        )),
    }
}

fn reply(value: Value) -> Result<Value, CoreError> {
    value.get("reply").cloned().ok_or_else(unavailable)
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

fn expected(name: &str, kind: &str, value: Option<&Value>) -> String {
    format!(
        "{name}: Invalid input: expected {kind}, received {}",
        type_name(value)
    )
}

/// `z.enum(allowed)`; returns whether the value passed.
fn enum_field(
    name: &str,
    value: Option<&Value>,
    allowed: &[&str],
    issues: &mut Vec<String>,
) -> bool {
    if value
        .and_then(Value::as_str)
        .is_some_and(|text| allowed.contains(&text))
    {
        return true;
    }
    let options: Vec<String> = allowed.iter().map(|item| format!("\"{item}\"")).collect();
    issues.push(format!(
        "{name}: Invalid option: expected one of {}",
        options.join("|")
    ));
    false
}

fn optional_enum(
    name: &str,
    value: Option<&Value>,
    allowed: &[&str],
    issues: &mut Vec<String>,
) -> bool {
    value.is_none() || enum_field(name, value, allowed, issues)
}

fn optional_bool(name: &str, value: Option<&Value>, issues: &mut Vec<String>) -> bool {
    if value.is_none_or(Value::is_boolean) {
        return true;
    }
    issues.push(expected(name, "boolean", value));
    false
}

/// `id`: `z.string().min(1).max(128)`; Zod counts code points.
fn id_field(name: &str, value: Option<&Value>, issues: &mut Vec<String>) {
    match value.and_then(Value::as_str) {
        None => issues.push(expected(name, "string", value)),
        Some("") => issues.push(too_small(name)),
        Some(text) if text.chars().count() > ID_MAX => issues.push(too_big(name, ID_MAX)),
        Some(_) => {}
    }
}

fn too_small(name: &str) -> String {
    format!("{name}: Too small: expected string to have >=1 characters")
}

fn too_big(name: &str, max: usize) -> String {
    format!("{name}: Too big: expected string to have <={max} characters")
}

fn lower_hex(text: &str) -> bool {
    text.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'))
}

fn is_uuid(text: &str) -> bool {
    let parts: Vec<&str> = text.split('-').collect();
    parts.len() == 5
        && parts
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(part, len)| part.len() == len && lower_hex(part))
}

fn is_token(text: &str) -> bool {
    text.len() == 64 && lower_hex(text)
}

fn pattern_field(
    name: &str,
    value: Option<&Value>,
    matches: fn(&str) -> bool,
    pattern: &str,
    issues: &mut Vec<String>,
) {
    match value.and_then(Value::as_str) {
        None => issues.push(expected(name, "string", value)),
        Some(text) if matches(text) => {}
        Some(_) => issues.push(format!(
            "{name}: Invalid string: must match pattern {pattern}"
        )),
    }
}

fn uuid_field(name: &str, value: Option<&Value>, issues: &mut Vec<String>) {
    pattern_field(name, value, is_uuid, UUID_PATTERN, issues);
}

fn token_field(name: &str, value: Option<&Value>, issues: &mut Vec<String>) {
    pattern_field(name, value, is_token, TOKEN_PATTERN, issues);
}

fn route_matches(route: &str) -> bool {
    let mut chars = route.chars();
    chars.next() == Some('/')
        && !route[1..].starts_with('/')
        && chars.all(|c| !('\u{0}'..='\u{1f}').contains(&c))
}

/// `z.string().min(1).max(2048).regex(...)`: length issues do not stop the pattern check.
fn route_field(value: Option<&Value>, issues: &mut Vec<String>) {
    const NAME: &str = "action.route";
    let Some(route) = value.and_then(Value::as_str) else {
        issues.push(expected(NAME, "string", value));
        return;
    };
    if route.is_empty() {
        issues.push(too_small(NAME));
    }
    if route.chars().count() > ROUTE_MAX {
        issues.push(too_big(NAME, ROUTE_MAX));
    }
    if !route_matches(route) {
        issues.push(format!(
            "{NAME}: Invalid string: must match pattern {ROUTE_PATTERN}"
        ));
    }
}

/// `clientAction`, the discriminated union in `src/clients/control.ts`.
fn action_field(value: Option<&Value>, issues: &mut Vec<String>) {
    let Some(action) = value.and_then(Value::as_object) else {
        issues.push(expected("action", "object", value));
        return;
    };
    match action.get("type").and_then(Value::as_str) {
        Some("theme.get" | "quit") => {}
        Some("theme.set") => {
            enum_field(
                "action.value",
                action.get("value"),
                &["system", "light", "dark"],
                issues,
            );
        }
        Some("navigate") => route_field(action.get("route"), issues),
        Some("window") => {
            enum_field(
                "action.action",
                action.get("action"),
                &["show", "minimize", "toggle-maximize", "close"],
                issues,
            );
        }
        Some("tray") => {
            enum_field(
                "action.action",
                action.get("action"),
                &["show", "hide"],
                issues,
            );
        }
        Some("launch-at-login") => {
            if !action.get("enabled").is_some_and(Value::is_boolean) {
                issues.push(expected("action.enabled", "boolean", action.get("enabled")));
            }
        }
        _ => issues.push(DISCRIMINATOR.to_owned()),
    }
}

fn register_issues(p: &Map<String, Value>) -> Vec<String> {
    let mut issues = Vec::new();
    // Zod runs the object's refinement unless an issue aborted it; only `min` does not abort.
    let mut clean = enum_field("kind", p.get("kind"), KINDS, &mut issues);
    match p.get("version").and_then(Value::as_str) {
        None => {
            issues.push(expected("version", "string", p.get("version")));
            clean = false;
        }
        Some("") => issues.push(too_small("version")),
        Some(_) => {}
    }
    clean &= optional_bool("notifier", p.get("notifier"), &mut issues);
    clean &= optional_bool("capture", p.get("capture"), &mut issues);
    clean &= optional_enum(
        "notification_permission",
        p.get("notification_permission"),
        PERMISSIONS,
        &mut issues,
    );
    clean &= optional_enum(
        "notification_alerts",
        p.get("notification_alerts"),
        ALERTS,
        &mut issues,
    );
    if clean
        && p.get("capture") == Some(&Value::Bool(true))
        && p.get("kind").and_then(Value::as_str) != Some("desktop")
    {
        issues.push("capture: Only desktop clients can enroll a capture worker".to_owned());
    }
    issues
}

fn issues(op: &str, p: &Map<String, Value>) -> Result<Vec<String>, CoreError> {
    let mut out = Vec::new();
    match op {
        "client.register" => return Ok(register_issues(p)),
        "client.heartbeat" => {
            id_field("client_id", p.get("client_id"), &mut out);
            optional_bool("notifier", p.get("notifier"), &mut out);
            optional_enum(
                "notification_permission",
                p.get("notification_permission"),
                PERMISSIONS,
                &mut out,
            );
            optional_enum(
                "notification_alerts",
                p.get("notification_alerts"),
                ALERTS,
                &mut out,
            );
        }
        "client.list" | "client.control.targets" => {}
        "client.control.enroll" => {
            enum_field("kind", p.get("kind"), &["app", "desktop"], &mut out);
            enum_field("window", p.get("window"), &["main", "tray"], &mut out);
        }
        "client.control.request" => {
            uuid_field("client_id", p.get("client_id"), &mut out);
            action_field(p.get("action"), &mut out);
        }
        "client.control.result" => uuid_field("request_id", p.get("request_id"), &mut out),
        "client.control.claim" => {
            uuid_field("client_id", p.get("client_id"), &mut out);
            token_field("worker_token", p.get("worker_token"), &mut out);
        }
        "client.control.complete" => {
            uuid_field("request_id", p.get("request_id"), &mut out);
            token_field("worker_token", p.get("worker_token"), &mut out);
            optional_enum(
                "error",
                p.get("error"),
                &["unsupported", "client_failed", "navigation_cancelled"],
                &mut out,
            );
        }
        _ => {
            return Err(CoreError::new(
                Code::UnknownOp,
                format!("unknown operation \"{op}\""),
            ));
        }
    }
    Ok(out)
}

// The registry file.

fn registry_path(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("state").join("clients.json")
}

/// The number serde prints as `JSON.stringify` does: whole safe values are integers.
fn js_number(n: f64) -> Option<Value> {
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        return Some(Value::from(n as i64));
    }
    Number::from_f64(n).map(Value::Number)
}

fn number(entry: &Map<String, Value>, key: &str) -> f64 {
    entry.get(key).and_then(Value::as_f64).unwrap_or(f64::NAN)
}

fn is_entry_text(value: Option<&Value>) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| !text.is_empty())
}

fn is_enum(value: Option<&Value>, allowed: &[&str]) -> bool {
    value
        .and_then(Value::as_str)
        .is_some_and(|text| allowed.contains(&text))
}

/// `entrySchema`: known keys in schema order, or `None` for an invalid entry.
fn parse_entry(value: &Value) -> Option<Map<String, Value>> {
    let entry = value.as_object()?;
    let finite = |key: &str| {
        entry
            .get(key)
            .filter(|value| value.is_number())
            .and_then(Value::as_f64)
            .filter(|n| n.is_finite())
    };
    if !is_entry_text(entry.get("client_id"))
        || !is_enum(entry.get("kind"), KINDS)
        || !is_entry_text(entry.get("version"))
        || !entry.get("notifier").is_some_and(Value::is_boolean)
    {
        return None;
    }
    let (registered, heartbeat) = (finite("registeredAt")?, finite("heartbeatAt")?);
    let mut out = Map::new();
    for key in ["client_id", "kind", "version", "notifier"] {
        out.insert(key.into(), entry[key].clone());
    }
    out.insert("registeredAt".into(), js_number(registered)?);
    out.insert("heartbeatAt".into(), js_number(heartbeat)?);
    for (key, allowed) in [
        ("notification_permission", PERMISSIONS),
        ("notification_alerts", ALERTS),
    ] {
        if let Some(value) = entry.get(key) {
            if !is_enum(Some(value), allowed) {
                return None;
            }
            out.insert(key.into(), value.clone());
        }
    }
    if entry.contains_key("permission_changed_at") {
        out.insert(
            "permission_changed_at".into(),
            js_number(finite("permission_changed_at")?)?,
        );
    }
    Some(out)
}

/// `quoted` encodes lone UTF-16 units and U+FDD0 behind its own noncharacter marker.
/// The marker is an internal ABI, never an API value: a file holding one reads as
/// unreadable, the same empty list a failed `JSON.parse` gives. Numbers are not
/// affected: their serde spelling is the reply spelling (S0/Q3).
fn has_quoted_text(value: &Value) -> bool {
    match value {
        Value::String(text) => text.contains('\u{fdd0}'),
        Value::Array(items) => items.iter().any(has_quoted_text),
        Value::Object(map) => map
            .iter()
            .any(|(key, value)| key.contains('\u{fdd0}') || has_quoted_text(value)),
        Value::Null | Value::Bool(_) | Value::Number(_) => false,
    }
}

/// `read`: one invalid entry empties the whole list, as `z.array().safeParse` does.
fn read_entries(ctx: &Ctx) -> Vec<Map<String, Value>> {
    fs::read(registry_path(ctx))
        .ok()
        .and_then(|bytes| quoted::parse_file(&bytes).ok())
        .filter(|value| !has_quoted_text(value))
        .and_then(|value| value.as_array()?.iter().map(parse_entry).collect())
        .unwrap_or_default()
}

/// `list(ctx)`: the registry entries whose 45 s lease has not lapsed. Shared with the
/// notification operations, which select presenters and ack targets from the same view.
pub fn live_entries(ctx: &Ctx) -> Vec<Map<String, Value>> {
    read_entries(ctx)
        .into_iter()
        .filter(|entry| ctx.now - number(entry, "heartbeatAt") <= LAPSE_S)
        .collect()
}

fn write_entries(ctx: &Ctx, entries: Vec<Map<String, Value>>) -> Result<(), CoreError> {
    let list = Value::Array(entries.into_iter().map(Value::Object).collect());
    write_private(&registry_path(ctx), quoted::stringify(&list).as_bytes())
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))
}

fn client_uuid() -> String {
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

fn now_value(ctx: &Ctx) -> Result<Value, CoreError> {
    js_number(ctx.now).ok_or_else(|| CoreError::new(Code::Internal, "clock is not finite"))
}

fn register(ctx: &Ctx, p: &Map<String, Value>) -> Result<Value, CoreError> {
    let _guard = REGISTRY.lock().unwrap_or_else(PoisonError::into_inner);
    let mut entries = read_entries(ctx);
    entries.retain(|entry| ctx.now - number(entry, "heartbeatAt") <= KEEP_S);
    let client_id = client_uuid();
    let now = now_value(ctx)?;
    // `{...options, notifier, client_id, ...}`: an omitted notifier lands after the options.
    let mut entry = Map::new();
    for key in [
        "kind",
        "version",
        "notifier",
        "notification_permission",
        "notification_alerts",
    ] {
        if let Some(value) = p.get(key) {
            entry.insert(key.into(), quoted::from_utf8(value.clone()));
        }
    }
    if !entry.contains_key("notifier") {
        entry.insert("notifier".into(), Value::Bool(false));
    }
    entry.insert("client_id".into(), Value::String(client_id.clone()));
    entry.insert("registeredAt".into(), now.clone());
    entry.insert("heartbeatAt".into(), now);
    entries.push(entry);
    write_entries(ctx, entries)?;
    Ok(json!({"client_id": client_id, "lease_s": LEASE_S}))
}

/// A real permission state: present and not the unbundled build's `unsupported` placeholder.
fn real_permission(value: Option<&Value>) -> bool {
    value.is_some_and(|value| value != "unsupported")
}

pub fn heartbeat(ctx: &Ctx, p: &Map<String, Value>) -> Result<Value, CoreError> {
    let id = p["client_id"].as_str().unwrap_or_default();
    let _guard = REGISTRY.lock().unwrap_or_else(PoisonError::into_inner);
    let mut entries = read_entries(ctx);
    let Some(entry) = entries
        .iter_mut()
        .find(|entry| entry["client_id"].as_str() == Some(id))
    else {
        return Err(CoreError::new(
            Code::InvalidInput,
            format!("unknown client \"{id}\""),
        ));
    };
    entry.insert("heartbeatAt".into(), now_value(ctx)?);
    if let Some(notifier) = p.get("notifier") {
        entry.insert("notifier".into(), notifier.clone());
    }
    let (permission, alerts) = (
        p.get("notification_permission"),
        p.get("notification_alerts"),
    );
    let stored_permission = entry.get("notification_permission");
    let stored_alerts = entry.get("notification_alerts");
    let changed = (real_permission(permission)
        && real_permission(stored_permission)
        && stored_permission != permission)
        || (alerts.is_some() && stored_alerts.is_some() && stored_alerts != alerts);
    if let Some(value) = permission {
        entry.insert("notification_permission".into(), value.clone());
    }
    if let Some(value) = alerts {
        entry.insert("notification_alerts".into(), value.clone());
    }
    if changed {
        entry.insert("permission_changed_at".into(), now_value(ctx)?);
    }
    write_entries(ctx, entries)?;
    Ok(json!({"ok": true}))
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::*;

    fn ctx(now: f64) -> (tempfile::TempDir, Ctx) {
        let dir = tempfile::tempdir().unwrap();
        let home = dir.path().to_path_buf();
        let ctx = Ctx::with(home.clone(), home.join(".pacer"), Default::default(), now);
        (dir, ctx)
    }

    fn run(ctx: &Ctx, op: &str, params: Value) -> Result<Value, CoreError> {
        tokio::runtime::Builder::new_current_thread()
            .build()
            .unwrap()
            .block_on(call(ctx, op, params, process_control(), &mut NoBridge))
    }

    #[test]
    fn a_new_entry_keeps_the_typescript_key_order() {
        let (_dir, ctx) = ctx(1000.5);
        let params = json!({"version": "1", "kind": "tui", "notification_alerts": "none"});
        let id = run(&ctx, "client.register", params).unwrap()["client_id"].clone();
        let text = fs::read_to_string(registry_path(&ctx)).unwrap();
        assert_eq!(
            text,
            format!(
                r#"[{{"kind":"tui","version":"1","notification_alerts":"none","notifier":false,"client_id":{id},"registeredAt":1000.5,"heartbeatAt":1000.5}}]"#
            )
        );
    }

    #[test]
    fn one_invalid_entry_empties_the_list() {
        let (_dir, ctx) = ctx(10.0);
        fs::create_dir_all(ctx.pacer_home.join("state")).unwrap();
        fs::write(registry_path(&ctx), r#"[{"client_id":""}]"#).unwrap();
        assert_eq!(run(&ctx, "client.list", json!({})).unwrap(), json!([]));
    }

    #[test]
    fn only_a_change_between_two_real_states_stamps_the_marker() {
        let (_dir, ctx) = ctx(10.0);
        let id = run(
            &ctx,
            "client.register",
            json!({"kind": "desktop", "version": "1", "notification_permission": "unsupported"}),
        )
        .unwrap()["client_id"]
            .clone();
        let beat = |permission: &str| {
            run(
                &ctx,
                "client.heartbeat",
                json!({"client_id": id, "notification_permission": permission}),
            )
            .unwrap();
            run(&ctx, "client.list", json!({})).unwrap()[0].clone()
        };
        assert!(beat("authorized").get("permission_changed_at").is_none());
        assert_eq!(beat("denied")["permission_changed_at"], json!(10));
    }

    #[test]
    fn routes_follow_the_published_pattern() {
        assert!(route_matches("/settings"));
        assert!(route_matches("/"));
        for route in ["", "settings", "//host", "/a\nb", "/a\u{1f}"] {
            assert!(!route_matches(route), "{route:?}");
        }
    }

    #[test]
    fn scoped_identities_are_refused_natively() {
        let (_dir, mut ctx) = ctx(10.0);
        for (name, message) in [
            ("PACER_ASSISTANT_GRANT", "An assistant grant runs assistant.tool only."),
            ("PACER_ENFORCEMENT_TOKEN", "Enforcement identity only reports a native child denial"),
            ("PACER_WORK_GRANT", "Operation is not allowed by this work grant"),
        ] {
            ctx.env.insert(name.into(), "x".into());
            let error = run(&ctx, "client.list", json!({})).unwrap_err();
            assert_eq!(error.code, Code::NotAllowed);
            assert_eq!(error.message, message);
            ctx.env.remove(name);
        }
        run(&ctx, "client.list", json!({})).unwrap();
    }

    #[test]
    fn only_a_capture_registration_needs_core() {
        assert!(!needs_core("client.control.claim", &json!({})));
        assert!(!needs_core("client.register", &json!({"capture": false})));
        assert!(needs_core("client.register", &json!({"capture": true})));
    }
}
