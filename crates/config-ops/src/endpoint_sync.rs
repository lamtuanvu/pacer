//! Native port of `syncEndpointConfig` (`src/core/accounts.ts`) and
//! `renderLaunchSettings`/`writeEndpointConfig` (`src/plugins/endpoint-adapter.ts`).
//!
//! The edit has already landed when this runs. A missing endpoint plugin is an
//! activity warning, never an operation failure, and the shared config file is
//! serialized per home exactly as TypeScript's `queueEndpointConfigWrite` does.
#![allow(clippy::result_large_err)]

use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value, json};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{Arc, OnceLock},
};

#[cfg(test)]
mod tests;

/// The host side of `endpoint.launchEnv`, implemented in `pacer-server` over
/// B0b's native plugin owner. Parameters carry only projected metadata and
/// credential references, never secret material.
pub trait EndpointPlugin: Send + Sync {
    fn launch_env<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a>;
}

#[derive(Clone, Debug)]
struct EndpointAccount {
    name: String,
    base_url: String,
    key_ref: Option<String>,
    models: Vec<Value>,
}

fn project_accounts(accounts: &Map<String, Value>) -> Vec<EndpointAccount> {
    accounts
        .values()
        .filter_map(|account| {
            let connection = account.get("connection")?;
            if connection.is_null() {
                return None;
            }
            let name = account["name"].as_str().unwrap_or("").to_owned();
            let base_url = connection["base_url"].as_str().unwrap_or("").to_owned();
            let key_ref = if connection["key"].as_str() == Some("none") {
                None
            } else {
                Some(format!("endpoint:{name}"))
            };
            Some(EndpointAccount {
                name,
                base_url,
                key_ref,
                models: connection["models"].as_array().cloned().unwrap_or_default(),
            })
        })
        .collect()
}

fn endpoint_key_env(name: &str) -> String {
    format!("PACER_KEY_{}", name.to_uppercase().replace('-', "_"))
}

fn project(account: &EndpointAccount) -> Value {
    json!({
        "name": account.name,
        "baseUrl": account.base_url,
        "keyRef": account.key_ref,
        "models": account.models,
    })
}

/// Byte-for-byte port of `renderOpencodeConfig` from the bundled plugin.
fn render_config(accounts: &[EndpointAccount]) -> Value {
    let mut providers = Map::new();
    for account in accounts {
        let mut options = Map::new();
        options.insert("baseURL".into(), Value::String(account.base_url.clone()));
        if account.key_ref.is_some() {
            options.insert(
                "apiKey".into(),
                Value::String(format!("{{env:{}}}", endpoint_key_env(&account.name))),
            );
        }
        let mut models = Map::new();
        for model in &account.models {
            let id = model["id"].as_str().unwrap_or("").to_owned();
            let mut limit = Map::new();
            limit.insert("context".into(), model["context"].clone());
            limit.insert("output".into(), model["output"].clone());
            let mut entry = Map::new();
            entry.insert(
                "name".into(),
                model
                    .get("name")
                    .filter(|value| !value.is_null())
                    .cloned()
                    .unwrap_or_else(|| Value::String(id.clone())),
            );
            entry.insert("limit".into(), Value::Object(limit));
            entry.insert("tool_call".into(), model["tools"].clone());
            models.insert(id, Value::Object(entry));
        }
        let mut provider = Map::new();
        provider.insert(
            "npm".into(),
            Value::String("@ai-sdk/openai-compatible".into()),
        );
        provider.insert(
            "name".into(),
            Value::String(format!("{} (pacer)", account.name)),
        );
        provider.insert("options".into(), Value::Object(options));
        provider.insert("models".into(), Value::Object(models));
        providers.insert(format!("pacer-{}", account.name), Value::Object(provider));
    }
    let mut root = Map::new();
    root.insert(
        "$schema".into(),
        Value::String("https://opencode.ai/config.json".into()),
    );
    root.insert("provider".into(), Value::Object(providers));
    Value::Object(root)
}

fn config_path(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("opencode").join("opencode.json")
}

fn refused(message: &str) -> CoreError {
    CoreError::new(Code::PluginRefused, message)
}

/// `renderLaunchSettings`: ask the endpoint plugin for launch settings, check
/// that it owns only the managed destination and expected key references, then
/// write the config (0600, parent 0700) so the effect is independent of which
/// front door performed the edit.
async fn write_endpoint_config(
    ctx: &Ctx,
    accounts: &[EndpointAccount],
    selected: Option<&str>,
    plugins: &dyn EndpointPlugin,
) -> Result<(), CoreError> {
    let path = config_path(ctx);
    let selected_account = match selected {
        None => Value::Null,
        Some(name) => accounts
            .iter()
            .find(|account| account.name == name)
            .map(project)
            .ok_or_else(|| {
                CoreError::new(Code::InvalidInput, "configured endpoint connection required")
            })?,
    };
    let projected: Vec<Value> = accounts.iter().map(project).collect();
    let params = json!({
        "account": selected_account,
        "accounts": projected,
        "pacerHome": ctx.pacer_home.to_string_lossy(),
    });
    let reply = plugins.launch_env(ctx, params).await?;
    let env = reply
        .get("env")
        .and_then(Value::as_object)
        .ok_or_else(|| refused("endpoint plugin returned invalid launch settings"))?;
    let secret_env = reply
        .get("secretEnv")
        .and_then(Value::as_object)
        .ok_or_else(|| refused("endpoint plugin returned invalid launch settings"))?;
    let expected_path = path.to_string_lossy();
    if env.len() != 1
        || env.get("OPENCODE_CONFIG").and_then(Value::as_str) != Some(expected_path.as_ref())
    {
        return Err(refused("endpoint plugin returned unowned launch settings"));
    }
    let mut expected: HashMap<String, String> = HashMap::new();
    if let Some(name) = selected {
        if accounts
            .iter()
            .any(|account| account.name == name && account.key_ref.is_some())
        {
            expected.insert(endpoint_key_env(name), format!("endpoint:{name}"));
        }
    }
    if secret_env.len() != expected.len()
        || expected.iter().any(|(key, reference)| {
            secret_env.get(key).and_then(Value::as_str) != Some(reference.as_str())
        })
    {
        return Err(refused("endpoint plugin returned unowned launch settings"));
    }
    let mut bytes = serde_json::to_string_pretty(&render_config(accounts))
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    bytes.push('\n');
    pacer_foundation::fsutil::write_private(&path, bytes.as_bytes())
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    Ok(())
}

async fn home_lock(pacer_home: &Path) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: OnceLock<tokio::sync::Mutex<HashMap<PathBuf, Arc<tokio::sync::Mutex<()>>>>> =
        OnceLock::new();
    let registry = LOCKS.get_or_init(|| tokio::sync::Mutex::new(HashMap::new()));
    let mut registry = registry.lock().await;
    registry
        .entry(pacer_home.to_path_buf())
        .or_insert_with(|| Arc::new(tokio::sync::Mutex::new(())))
        .clone()
}

/// `syncEndpointConfig`: reload the saved accounts, ask the plugin to render the
/// managed config and tolerate only `plugin_unavailable`. An unavailable
/// endpoint plugin must not report an already-saved edit as failed.
pub async fn sync_endpoint_config(ctx: &Ctx, plugins: &dyn EndpointPlugin) -> Result<(), CoreError> {
    let strategy = pacer_config::strategy::load_strategy(&ctx.pacer_home)
        .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()))?;
    let accounts = strategy["accounts"].as_object().cloned().unwrap_or_default();
    let endpoint_accounts = project_accounts(&accounts);
    // TS warns whenever any account has a `connection` object, including a
    // keyless one; every projected endpoint account is such an account.
    let has_connection = !endpoint_accounts.is_empty();
    let lock = home_lock(&ctx.pacer_home).await;
    let _guard = lock.lock().await;
    match write_endpoint_config(ctx, &endpoint_accounts, None, plugins).await {
        Ok(()) => Ok(()),
        Err(error) if error.code == Code::PluginUnavailable => {
            if has_connection {
                let text = format!(
                    "Settings saved, but the OpenCode endpoint configuration was not updated: {}",
                    error.message
                );
                let _ = pacer_store::activity::append_activity(
                    ctx,
                    json!({"kind":"config","level":"warn","text":text}),
                );
            }
            Ok(())
        }
        Err(error) => Err(error),
    }
}
