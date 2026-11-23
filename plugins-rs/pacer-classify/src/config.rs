//! Input and configuration validation, a port of `plugins/pacer-classify/config.ts`.
//!
//! Mirrors the zod schemas: references (`ref`), URLs (`url`), the per-adapter
//! configs, `adapterConfig`, the `question` discriminated union, and `askInput`.
//! Every failure reports zod's single `PluginError`:
//! `invalid_input` "invalid classifier input or configuration snapshot".

use super::http::Question;
use pacer_plugin::{PluginError, js};
use regex::Regex;
use serde_json::{Map, Value};
use url::Url;

/// The error every validation failure maps to (config.ts:7).
pub fn invalid() -> PluginError {
    PluginError::new("invalid_input", "invalid classifier input or configuration snapshot")
}

/// `ref`: `^(env|secrets|endpoint):[A-Za-z0-9_][A-Za-z0-9_.-]*$` (config.ts:3).
fn is_ref(value: &str) -> bool {
    static RE: std::sync::OnceLock<Regex> = std::sync::OnceLock::new();
    let re = RE.get_or_init(|| {
        Regex::new(r"^(env|secrets|endpoint):[A-Za-z0-9_][A-Za-z0-9_.-]*$").unwrap()
    });
    re.is_match(value)
}

/// `url`: a http(s) URL with no userinfo (config.ts:4).
fn is_url(value: &Value) -> bool {
    let Value::String(s) = value else {
        return false;
    };
    let Ok(parsed) = Url::parse(s) else {
        return false;
    };
    matches!(parsed.scheme(), "http" | "https")
        && parsed.username().is_empty()
        && parsed.password().is_none()
}

/// zod `z.number()`, plus an extra predicate on the finite value.
fn number_with(value: &Value, predicate: impl Fn(f64) -> bool) -> Option<f64> {
    let n = value.as_f64()?;
    if !n.is_finite() {
        return None;
    }
    predicate(n).then_some(n)
}

/// Whether `object`'s keys are exactly `keys` (zod `.strict()`).
fn keys_exactly(object: &Map<String, Value>, keys: &[&str]) -> bool {
    object.keys().all(|k| keys.contains(&k.as_str())) && keys.iter().all(|k| object.contains_key(*k))
}

/// `configs.rules`: `z.object({}).strict()` — the config must be exactly `{}`.
pub fn parse_rules_config(config: &Value) -> Result<(), PluginError> {
    let object = config.as_object().ok_or_else(invalid)?;
    if object.is_empty() {
        Ok(())
    } else {
        Err(invalid())
    }
}

/// The `ollama` adapter config (config.ts:5).
#[derive(Debug, Clone)]
pub struct OllamaConfig {
    pub base_url: String,
    pub model: String,
    pub max_tokens: i64,
    /// `keyRef` is nullable for ollama.
    pub key_ref: Option<String>,
}

/// `configs.ollama`: `{baseUrl: url, model: string.min(1), maxTokens:
/// number.positive().refine(Number.isInteger), keyRef: ref.nullable()}` strict.
pub fn parse_ollama_config(config: &Value) -> Result<OllamaConfig, PluginError> {
    let object = config.as_object().ok_or_else(invalid)?;
    if !keys_exactly(object, &["baseUrl", "model", "maxTokens", "keyRef"]) {
        return Err(invalid());
    }
    let base_url = match object.get("baseUrl") {
        Some(v) if is_url(v) => v.as_str().unwrap().to_owned(),
        _ => return Err(invalid()),
    };
    let model = match object.get("model") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return Err(invalid()),
    };
    let max_tokens = match number_with(
        object.get("maxTokens").unwrap_or(&Value::Null),
        |n| n > 0.0 && n.fract() == 0.0,
    ) {
        Some(n) => n as i64,
        None => return Err(invalid()),
    };
    let key_ref = match object.get("keyRef") {
        Some(Value::Null) => None,
        Some(Value::String(s)) if is_ref(s) => Some(s.clone()),
        _ => return Err(invalid()),
    };
    Ok(OllamaConfig {
        base_url,
        model,
        max_tokens,
        key_ref,
    })
}

/// The `jev` adapter config (config.ts:5).
#[derive(Debug, Clone)]
pub struct JevConfig {
    pub base_url: String,
    pub model: String,
    pub key_ref: String,
    pub usd_per_mtok_in: Option<f64>,
    pub usd_per_mtok_out: Option<f64>,
}

/// `configs.jev`: `{baseUrl: url, model: string.min(1), keyRef: ref,
/// usdPerMtokIn: number.nonnegative().nullable(), usdPerMtokOut:
/// number.nonnegative().nullable()}` strict.
pub fn parse_jev_config(config: &Value) -> Result<JevConfig, PluginError> {
    let object = config.as_object().ok_or_else(invalid)?;
    if !keys_exactly(
        object,
        &["baseUrl", "model", "keyRef", "usdPerMtokIn", "usdPerMtokOut"],
    ) {
        return Err(invalid());
    }
    let base_url = match object.get("baseUrl") {
        Some(v) if is_url(v) => v.as_str().unwrap().to_owned(),
        _ => return Err(invalid()),
    };
    let model = match object.get("model") {
        Some(Value::String(s)) if !s.is_empty() => s.clone(),
        _ => return Err(invalid()),
    };
    let key_ref = match object.get("keyRef") {
        Some(Value::String(s)) if is_ref(s) => s.clone(),
        _ => return Err(invalid()),
    };
    let nonnegative_nullable = |key: &str| -> Option<Option<f64>> {
        match object.get(key).unwrap_or(&Value::Null) {
            Value::Null => Some(None),
            value => number_with(value, |n| n >= 0.0).map(Some),
        }
    };
    let usd_per_mtok_in = nonnegative_nullable("usdPerMtokIn").ok_or_else(invalid)?;
    let usd_per_mtok_out = nonnegative_nullable("usdPerMtokOut").ok_or_else(invalid)?;
    Ok(JevConfig {
        base_url,
        model,
        key_ref,
        usd_per_mtok_in,
        usd_per_mtok_out,
    })
}

/// `adapterConfig`: `z.object({adapters: z.object(configs).strict()}).strict()`.
#[derive(Debug, Clone)]
pub struct AdapterConfig {
    pub ollama: OllamaConfig,
    pub jev: JevConfig,
}

pub fn parse_adapter_config(config: &Value) -> Result<AdapterConfig, PluginError> {
    let object = config.as_object().ok_or_else(invalid)?;
    if !keys_exactly(object, &["adapters"]) {
        return Err(invalid());
    }
    let adapters = object.get("adapters").and_then(Value::as_object).ok_or_else(invalid)?;
    if !keys_exactly(adapters, &["rules", "ollama", "jev"]) {
        return Err(invalid());
    }
    parse_rules_config(adapters.get("rules").unwrap())?;
    let ollama = parse_ollama_config(adapters.get("ollama").unwrap())?;
    let jev = parse_jev_config(adapters.get("jev").unwrap())?;
    Ok(AdapterConfig { ollama, jev })
}

/// The `question` discriminated union on `type` (config.ts:8-11).
pub fn parse_question(value: &Value) -> Result<Question, PluginError> {
    let object = value.as_object().ok_or_else(invalid)?;
    let kind = object.get("type").and_then(Value::as_str).ok_or_else(invalid)?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?
        .to_owned();
    let instructions = object
        .get("instructions")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?
        .to_owned();
    match kind {
        "choice" => {
            if !keys_exactly(object, &["type", "id", "instructions", "criteria"]) {
                return Err(invalid());
            }
            let criteria = object
                .get("criteria")
                .and_then(Value::as_object)
                .ok_or_else(invalid)?;
            if criteria
                .values()
                .any(|v| !matches!(v, Value::String(_)))
            {
                return Err(invalid());
            }
            Ok(Question::Choice {
                id,
                instructions,
                criteria: criteria.clone(),
            })
        }
        "score" => {
            if !keys_exactly(object, &["type", "id", "instructions", "min", "max"]) {
                return Err(invalid());
            }
            let min = js::finite_number(object.get("min").unwrap()).ok_or_else(invalid)?;
            let max = js::finite_number(object.get("max").unwrap()).ok_or_else(invalid)?;
            Ok(Question::Score {
                id,
                instructions,
                min,
                max,
            })
        }
        "yesno" => {
            if !keys_exactly(object, &["type", "id", "instructions"]) {
                return Err(invalid());
            }
            Ok(Question::YesNo { id, instructions })
        }
        _ => Err(invalid()),
    }
}

/// The adapter a classify call targets.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Adapter {
    Rules,
    Ollama,
    Jev,
}

/// `askInput`: `{adapter, state: string.max(256*1024), question, timeoutMs:
/// number.positive(), config: unknown.refine(v => v !== undefined)}` (config.ts:12).
#[derive(Debug)]
pub struct AskInput {
    pub adapter: Adapter,
    pub state: String,
    pub question: Question,
    pub timeout_ms: f64,
    pub config: Value,
}

pub fn parse_ask_input(value: &Value) -> Result<AskInput, PluginError> {
    let object = value.as_object().ok_or_else(invalid)?;
    if !keys_exactly(object, &["adapter", "state", "question", "timeoutMs", "config"]) {
        return Err(invalid());
    }
    let adapter = match object.get("adapter").and_then(Value::as_str) {
        Some("rules") => Adapter::Rules,
        Some("ollama") => Adapter::Ollama,
        Some("jev") => Adapter::Jev,
        _ => return Err(invalid()),
    };
    let state = match object.get("state") {
        Some(Value::String(s)) if js::utf16_len(s) <= 256 * 1024 => s.clone(),
        _ => return Err(invalid()),
    };
    let question = parse_question(object.get("question").unwrap())?;
    let timeout_ms = number_with(object.get("timeoutMs").unwrap(), |n| n > 0.0)
        .ok_or_else(invalid)?;
    let config = object.get("config").unwrap().clone();
    Ok(AskInput {
        adapter,
        state,
        question,
        timeout_ms,
        config,
    })
}