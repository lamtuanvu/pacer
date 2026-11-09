//! Account folders, evidence identity, endpoint keys and state, and the
//! TypeScript object shapes of loaded accounts and runners.
use crate::js::{array_index, expand_home, locale_compare, stringify};
use pacer_foundation::Ctx;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
    time::Duration,
};

fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}

/// `/^[A-Za-z0-9][A-Za-z0-9._-]*$/`
fn safe_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// `orcaUserDataDir`.
fn orca_user_data(ctx: &Ctx) -> PathBuf {
    if let Some(dir) = ctx
        .env
        .get("PACER_ORCA_USER_DATA")
        .filter(|v| !v.is_empty())
    {
        return PathBuf::from(dir);
    }
    if cfg!(target_os = "macos") {
        return ctx.home.join("Library/Application Support/orca");
    }
    ctx.env
        .get("XDG_CONFIG_HOME")
        .map_or_else(|| ctx.home.join(".config"), PathBuf::from)
        .join("orca")
}

/// `orcaAccountHome`: only an existing Orca-managed home.
fn orca_account_home(ctx: &Ctx, kind: &str, id: &str) -> Option<PathBuf> {
    if !safe_id(id) {
        return None;
    }
    let root = ctx
        .env
        .get("ORCA_USER_DATA_PATH")
        .filter(|v| !v.is_empty())
        .map_or_else(|| orca_user_data(ctx), PathBuf::from);
    let group = if kind == "claude" {
        "claude-profiles"
    } else {
        "codex-accounts"
    };
    let path = root.join(group).join(id).join("home");
    path.is_dir().then_some(path)
}

/// `accountFolder`.
pub(crate) fn account_folder(ctx: &Ctx, account: &Value) -> Option<PathBuf> {
    let kind = text(&account["kind"]);
    if account["source"] == "orca" && matches!(kind, "claude" | "codex") {
        return orca_account_home(ctx, kind, text(&account["orcaAccount"]));
    }
    account["home"]
        .as_str()
        .filter(|home| !home.is_empty())
        .map(|home| expand_home(home, &ctx.home))
}

/// `accountEvidenceScope(account, hosts).identity`.
pub(crate) fn evidence_identity(account: &Value, hosts: &Value) -> String {
    let name = text(&account["name"]);
    let mut aliases: Vec<_> = hosts.as_object().into_iter().flatten().collect();
    aliases.sort_by(|a, b| locale_compare(a.0, b.0));
    let hosts: Vec<Value> = aliases
        .into_iter()
        .map(|(alias, host)| {
            let home = host["accounts"]
                .as_object()
                .and_then(|accounts| accounts.get(name))
                .map_or(Value::Null, |a| a["home"].clone());
            json!([alias, host["ssh"], home])
        })
        .collect();
    let mut signature = vec![
        account["name"].clone(),
        account["kind"].clone(),
        account["source"].clone(),
        account["home"].clone(),
        account["orcaAccount"].clone(),
        account["usageSource"].clone(),
        account["quotaSource"].clone(),
        account["connection"]["base_url"].clone(),
        account["connection"]["key"].clone(),
        Value::Array(hosts),
    ];
    if account["provider"].as_str().is_some_and(|p| !p.is_empty()) {
        signature.push(account["provider"].clone());
    }
    format!(
        "{:x}",
        Sha256::digest(stringify(&Value::Array(signature), 0).as_bytes())
    )
}

fn pick(source: &Value, keys: &[&str], always: bool) -> Map<String, Value> {
    keys.iter()
        .filter_map(|k| match source.get(*k) {
            Some(v) => Some(((*k).to_owned(), v.clone())),
            None if always => Some(((*k).to_owned(), Value::Null)),
            None => None,
        })
        .collect()
}

/// An endpoint model as `parseConnection` builds it: `{id, name?, context, output, tools}`.
pub(crate) fn ts_model(model: &Value) -> Value {
    let mut out = pick(model, &["id"], true);
    out.extend(pick(model, &["name"], false));
    out.extend(pick(model, &["context", "output", "tools"], true));
    Value::Object(out)
}

fn ts_connection(connection: &Value) -> Value {
    let mut out = pick(connection, &["api", "base_url", "key"], true);
    out.insert(
        "models".into(),
        Value::Array(
            connection["models"]
                .as_array()
                .into_iter()
                .flatten()
                .map(ts_model)
                .collect(),
        ),
    );
    Value::Object(out)
}

/// A loaded account in `AccountCfg` key order.
pub(crate) fn ts_account(account: &Value) -> Map<String, Value> {
    let mut out = pick(
        account,
        &[
            "name",
            "model",
            "kind",
            "source",
            "home",
            "orcaAccount",
            "usage",
            "usageSource",
            "quotaSource",
            "provider",
            "weeklyUsd",
            "weeklyTokens",
            "cooldownS",
            "allowPaid",
        ],
        true,
    );
    if let Some(connection) = account.get("connection").filter(|c| c.is_object()) {
        out.insert("connection".into(), ts_connection(connection));
    }
    out
}

/// A loaded runner in `RunnerCfg` key order: declared options first.
pub(crate) fn ts_runner(runner: &Value) -> Value {
    let mut out = pick(runner, &["session", "enabled", "maxTasks", "test"], false);
    out.extend(pick(
        runner,
        &["id", "name", "host", "agent", "account", "model"],
        true,
    ));
    out.extend(pick(runner, &["models"], false));
    Value::Object(out)
}

pub(crate) const KEYCHAIN_FAILED: &str = "endpoint keychain operation failed";

/// `hasKey`: whether the endpoint key exists, without reading it.
pub(crate) async fn has_key(ctx: &Ctx, name: &str, source: &str) -> Result<bool, String> {
    if source == "none" {
        return Ok(true);
    }
    if let Some(var) = source.strip_prefix("env:") {
        return Ok(ctx.env.get(var).is_some_and(|v| !v.is_empty()));
    }
    if source == "file" {
        return Ok(ctx
            .pacer_home
            .join("secrets")
            .join(format!("{name}.key"))
            .exists());
    }
    let mut command = tokio::process::Command::new("security");
    command
        .args(["find-generic-password", "-s", "pacer", "-a"])
        .arg(format!("endpoint/{name}"))
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    let status = tokio::time::timeout(Duration::from_secs(10), command.status())
        .await
        .map_err(|_| KEYCHAIN_FAILED.to_owned())?
        .map_err(|_| KEYCHAIN_FAILED.to_owned())?;
    match status.code() {
        Some(0) => Ok(true),
        Some(44) => Ok(false),
        _ => Err(KEYCHAIN_FAILED.into()),
    }
}

pub(crate) const STATE_READ_FAILED: &str = "endpoint state read failed";

fn state_path(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("endpoints").join("state.json")
}

/// The validated `endpoints/state.json` document (`states`), or `None` when
/// TypeScript would report a read failure.
pub(crate) fn endpoint_states(ctx: &Ctx) -> Option<Map<String, Value>> {
    let bytes = match fs::read(state_path(ctx)) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Some(Map::new()),
        Err(_) => return None,
    };
    let Ok(Value::Object(states)) = serde_json::from_slice::<Value>(&bytes) else {
        return None;
    };
    let optional_text = |v: Option<&Value>| v.is_none_or(Value::is_string);
    states
        .values()
        .all(|entry| {
            entry.as_object().is_some_and(|e| {
                e.get("state").and_then(Value::as_str).is_some_and(|s| {
                    ["ready", "not_tested", "not_working", "key_missing"].contains(&s)
                }) && optional_text(e.get("detail"))
                    && optional_text(e.get("checked_at"))
            })
        })
        .then_some(states)
}

/// State documents Rust rewrites exactly as `JSON.stringify(…, null, 2)` does.
pub(crate) fn endpoint_states_native(ctx: &Ctx) -> bool {
    endpoint_states(ctx).is_some_and(|states| !states.keys().any(|k| array_index(k)))
}

pub(crate) fn read_endpoint_state(ctx: &Ctx, name: &str) -> Result<Value, String> {
    let states = endpoint_states(ctx).ok_or_else(|| STATE_READ_FAILED.to_owned())?;
    Ok(states
        .get(name)
        .cloned()
        .unwrap_or_else(|| json!({"state": "not_tested"})))
}

/// `writeEndpointState`.
pub(crate) fn write_endpoint_state(ctx: &Ctx, name: &str, state: Value) -> Result<(), String> {
    let mut states = endpoint_states(ctx).ok_or_else(|| STATE_READ_FAILED.to_owned())?;
    states.insert(name.to_owned(), state);
    let text = format!("{}\n", stringify(&Value::Object(states), 2));
    pacer_foundation::fsutil::write_private(&state_path(ctx), text.as_bytes())
        .map_err(|e| e.to_string())
}

/// `new URL(base_url).host`.
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

/// `endpointRow` for an account with a managed connection.
pub(crate) async fn endpoint_row(
    ctx: &Ctx,
    name: &str,
    connection: &Value,
) -> Result<Map<String, Value>, String> {
    let present = has_key(ctx, name, text(&connection["key"])).await?;
    let mut row = read_endpoint_state(ctx, name)?
        .as_object()
        .cloned()
        .unwrap_or_default();
    if !present {
        row.insert("state".into(), json!("key_missing"));
    }
    row.insert(
        "connection".into(),
        json!({
            "api": connection["api"],
            "base_url_host": url_host(text(&connection["base_url"])),
            "key": if present { "present" } else { "missing" },
            "models": ts_connection(connection)["models"],
        }),
    );
    Ok(row)
}

pub(crate) fn path_text(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}
