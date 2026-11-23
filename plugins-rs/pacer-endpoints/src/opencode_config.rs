//! `endpointKeyEnv` and `renderOpencodeConfig`, a port of
//! `plugins/pacer-endpoints/opencode-config.ts`. Credentials never enter this
//! module: the API key is rendered as a `{env:…}` placeholder when the key
//! reference is non-null, and the JSON never carries the reference itself.

use crate::object_key_order;
use serde::Deserialize;
use serde_json::{Map, Value, json};

/// One projected model (`EndpointModel` in opencode-config.ts:2).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointModel {
    pub id: String,
    #[serde(default)]
    pub name: Option<String>,
    pub context: u64,
    pub output: u64,
    pub tools: bool,
}

/// Host-projected managed account metadata (`EndpointAccount` in opencode-config.ts:9).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EndpointAccount {
    pub name: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub key_ref: Option<String>,
    pub models: Vec<EndpointModel>,
}

/// `endpointKeyEnv(name)` in opencode-config.ts:21.
pub fn endpoint_key_env(name: &str) -> String {
    let mut out = String::with_capacity(name.len() + 9);
    out.push_str("PACER_KEY_");
    for ch in name.chars() {
        if ch == '-' {
            out.push('_');
        } else {
            for c in ch.to_uppercase() {
                out.push(c);
            }
        }
    }
    out
}

/// `renderOpencodeConfig(accounts)` in opencode-config.ts:26. Builds the
/// `provider` and each `models` record in the same key order the JS
/// `Object.fromEntries` produces (array-index keys first ascending, then
/// insertion order), and keeps `$schema` first. No filesystem effects.
pub fn render_opencode_config(accounts: &[EndpointAccount]) -> Value {
    let mut provider: Map<String, Value> = Map::new();
    for account in accounts {
        provider.insert(
            format!("pacer-{}", account.name),
            render_provider(account),
        );
    }
    let mut out = Map::new();
    out.insert("$schema".into(), json!("https://opencode.ai/config.json"));
    out.insert("provider".into(), Value::Object(object_key_order(provider)));
    Value::Object(out)
}

fn render_provider(account: &EndpointAccount) -> Value {
    let mut models: Map<String, Value> = Map::new();
    for model in &account.models {
        let mut limit = Map::new();
        limit.insert("context".into(), json!(model.context));
        limit.insert("output".into(), json!(model.output));
        models.insert(
            model.id.clone(),
            json!({
                "name": model.name.clone().unwrap_or_else(|| model.id.clone()),
                "limit": Value::Object(limit),
                "tool_call": model.tools,
            }),
        );
    }
    let mut options = Map::new();
    options.insert("baseURL".into(), json!(account.base_url));
    if account.key_ref.is_some() {
        options.insert(
            "apiKey".into(),
            json!(format!("{{env:{}}}", endpoint_key_env(&account.name))),
        );
    }
    let mut provider = Map::new();
    provider.insert("npm".into(), json!("@ai-sdk/openai-compatible"));
    provider.insert("name".into(), json!(format!("{} (pacer)", account.name)));
    provider.insert("options".into(), Value::Object(options));
    provider.insert("models".into(), Value::Object(object_key_order(models)));
    Value::Object(provider)
}