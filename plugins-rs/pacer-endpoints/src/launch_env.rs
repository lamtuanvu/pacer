//! `launchEnv`, a port of `plugins/pacer-endpoints/launch-env.ts`. Writes the
//! rendered opencode config to `{pacerHome}/opencode/opencode.json` (mode
//! 0600) through the host filesystem, and returns the runtime environment plus
//! the secret references the host resolves at launch. Only placeholders go to
//! disk; the returned `secretEnv` carries `keyRef`s that never enter the file.

use crate::opencode_config::{EndpointAccount, endpoint_key_env, render_opencode_config};
use crate::path::join;
use pacer_plugin::{Host, PluginError};
use serde_json::{Map, Value, json};

/// `launchEnv(host, input)` in launch-env.ts:6.
pub async fn launch_env(host: &Host, input: &Value) -> Result<Value, PluginError> {
    let pacer_home = input.get("pacerHome").and_then(Value::as_str).unwrap_or("");
    let accounts: Vec<EndpointAccount> = input
        .get("accounts")
        .cloned()
        .map(deserialize_accounts)
        .unwrap_or_else(|| Ok(Vec::new()))?;

    let dir = join(pacer_home, "opencode");
    let config_path = join(&dir, "opencode.json");
    let fs = host.fs();
    fs.mkdir(&dir).await?;

    let rendered = render_opencode_config(&accounts);
    let content = format!(
        "{}\n",
        serde_json::to_string_pretty(&rendered)
            .map_err(|e| PluginError::new("internal", format!("render opencode config: {e}")))?,
    );
    fs.write(&config_path, &content, Some(0o600)).await?;

    let account: Option<EndpointAccount> = match input.get("account") {
        Some(Value::Null) | None => None,
        Some(value) => serde_json::from_value(value.clone()).ok(),
    };
    let mut secret_env: Map<String, Value> = Map::new();
    if let Some(acc) = &account {
        if let Some(key_ref) = &acc.key_ref {
            secret_env.insert(endpoint_key_env(&acc.name), json!(key_ref));
        }
    }

    let mut env: Map<String, Value> = Map::new();
    env.insert("OPENCODE_CONFIG".into(), json!(config_path));
    Ok(json!({ "env": env, "secretEnv": secret_env }))
}

fn deserialize_accounts(value: Value) -> Result<Vec<EndpointAccount>, PluginError> {
    serde_json::from_value(value).map_err(|e| {
        PluginError::new("invalid_input", format!("invalid accounts: {e}"))
    })
}