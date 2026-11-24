//! Endpoint key presence and state, ported from `src/endpoints/keys.ts`,
//! `src/endpoints/state.ts`, `src/endpoints/row.ts` and the cache-only
//! branch of `src/engine/status.ts` (B12-2).

use pacer_foundation::Ctx;
use serde_json::{Map, Value, json};

/// `endpointStates` (state.ts): the endpoint state table read, as an object.
pub fn endpoint_states(ctx: &Ctx) -> Option<Value> {
    pacer_foundation::fsutil::read_json::<Value>(&endpoint_state_path(ctx))
}

/// `readEndpointState` (state.ts): the state for an endpoint, or
/// `{"state":"not_tested"}` when there is none or the table is unreadable.
pub fn read_endpoint_state(ctx: &Ctx, name: &str) -> Value {
    match endpoint_states(ctx) {
        Some(states) => states
            .get(name)
            .cloned()
            .unwrap_or_else(|| json!({"state": "not_tested"})),
        None => json!({"state": "not_tested"}),
    }
}

/// `hasKey` (keys.ts): whether an endpoint key is present under `source`.
/// `none` is always present; `env:` checks the variable; `file` checks the
/// `pacerHome/secrets/{name}.key` file; `keychain` probes the macOS
/// keychain (`security` on PATH, running with `ctx.env` so tests can fake it).
pub async fn has_key(ctx: &Ctx, name: &str, source: &str) -> bool {
    if source == "none" {
        return true;
    }
    if let Some(var) = source.strip_prefix("env:") {
        return ctx.env.get(var).is_some_and(|v| !v.is_empty());
    }
    if source == "file" {
        return ctx
            .pacer_home
            .join("secrets")
            .join(format!("{name}.key"))
            .exists();
    }
    let mut command = tokio::process::Command::new("security");
    command
        .args(["find-generic-password", "-s", "pacer", "-a"])
        .arg(format!("endpoint/{name}"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .envs(ctx.env.iter());
    let status =
        match tokio::time::timeout(std::time::Duration::from_secs(10), command.status()).await {
            Ok(Ok(status)) => status,
            _ => return false,
        };
    status.code() == Some(0)
}

/// `url_host` (row.ts:15): `new URL(base_url).host`; empty on parse failure
/// or a scheme without a host.
/// `statePath` (endpoints/state.ts): the endpoint state table.
pub fn endpoint_state_path(ctx: &Ctx) -> std::path::PathBuf {
    ctx.pacer_home.join("endpoints").join("state.json")
}

fn url_host(base_url: &str) -> String {
    url::Url::parse(base_url).map_or_else(
        |_| String::new(),
        |url| match (url.host_str(), url.port()) {
            (Some(host), Some(port)) => format!("{host}:{port}"),
            (Some(host), None) => host.to_owned(),
            _ => String::new(),
        },
    )
}

/// The account cell's endpoint fields. `cache_only` reproduces the
/// `readEndpointState` branch in `engine/status.ts` (no key probe); otherwise
/// the account list's `endpointRow`.
pub async fn endpoint_cell(ctx: &Ctx, account: &Value, cache_only: bool) -> Value {
    let name = account.get("name").and_then(Value::as_str).unwrap_or("");
    let source = account.get("source").and_then(Value::as_str).unwrap_or("");
    if cache_only {
        let has_connection = account.get("connection").is_some_and(Value::is_object);
        if has_connection || source == "opencode" {
            return read_endpoint_state(ctx, name);
        }
        return json!({});
    }
    if source == "opencode" {
        let mut row = read_endpoint_state(ctx, name)
            .as_object()
            .cloned()
            .unwrap_or_default();
        row.insert(
            "opencode".to_owned(),
            json!({ "provider": account.get("provider").cloned().unwrap_or(Value::Null) }),
        );
        return Value::Object(row);
    }
    let Some(connection) = account.get("connection").cloned() else {
        if account.get("kind").and_then(Value::as_str) == Some("endpoint") {
            return json!({ "state": "external" });
        }
        return json!({});
    };
    let present = has_key(
        ctx,
        name,
        connection.get("key").and_then(Value::as_str).unwrap_or(""),
    )
    .await;
    let saved = read_endpoint_state(ctx, name);
    let mut row: Map<String, Value> = saved.as_object().cloned().unwrap_or_default();
    let state = if present {
        saved.get("state").cloned()
    } else {
        Some(json!("key_missing"))
    };
    row.insert("state".to_owned(), state.unwrap_or(Value::Null));
    row.insert(
        "connection".to_owned(),
        json!({
            "api": connection.get("api").cloned().unwrap_or(Value::Null),
            "base_url_host": url_host(connection.get("base_url").and_then(Value::as_str).unwrap_or("")),
            "key": if present { "present" } else { "missing" },
            "models": connection.get("models").cloned().unwrap_or(Value::Null),
        }),
    );
    Value::Object(row)
}
