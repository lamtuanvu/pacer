//! Metered (opencode stats) budget reader, port of `plugins/pacer-usage/metered.ts`.
//! Subprocess-backed (via the host's `process.spawn` capability only).

use super::{ReaderContext, UsageReading, UsageSource, UsageWindow};
use crate::util::{is_obj, to_num};
use pacer_plugin::PluginError;
use serde_json::Value;

const KEY: &str = "opencode-stats-7d-cost";
const TTL_S: f64 = 300.0;
const MAX_STALE_S: f64 = 6.0 * 3600.0;
const TIMEOUT_MS: u64 = 15000;
const ARGV: &[&str] = &["opencode", "stats", "--models", "--cost", "--json", "--days", "7"];

/// `MeteredConfig` (usage.ts:76): the caller's metered budget.
#[derive(Clone, Debug, Default)]
pub struct MeteredConfig {
    pub model: Option<String>,
    pub weekly_tokens: Option<f64>,
    pub weekly_usd: Option<f64>,
}

impl MeteredConfig {
    pub fn from_params(params: &Value) -> Self {
        MeteredConfig {
            model: params
                .get("model")
                .and_then(Value::as_str)
                .map(str::to_owned),
            weekly_tokens: params
                .get("weeklyTokens")
                .and_then(Value::as_f64),
            weekly_usd: params.get("weeklyUsd").and_then(Value::as_f64),
        }
    }
}

async fn fetch_stats(io: &dyn pacer_plugin::usage::ReaderIo) -> Result<Value, PluginError> {
    let result = io.run(ARGV, TIMEOUT_MS).await?;
    if result.code != 0 {
        let msg = format!(
            "opencode stats exited {}: {}",
            result.code,
            result.stderr.trim().chars().take(200).collect::<String>()
        );
        return Err(PluginError::new("command", msg));
    }
    serde_json::from_str(&result.stdout).map_err(|e| PluginError::new("command", e.to_string()))
}

/// `readMetered` (metered.ts:10-32): dollar or token budgets from opencode stats.
pub async fn read_metered(
    ctx: &ReaderContext<'_>,
    cfg: &MeteredConfig,
    refresh: bool,
) -> UsageReading {
    let Some(model) = &cfg.model else {
        return UsageReading {
            windows: Vec::new(),
            captured_at: None,
            stale: false,
            error: Some("metered usage needs a model".to_owned()),
            ..Default::default()
        };
    };
    let io = ctx.io;
    let c = io
        .cached_fetch(
            KEY,
            TTL_S,
            MAX_STALE_S,
            Box::pin(fetch_stats(io)),
            refresh,
            ctx.now,
            ctx.read_only,
        )
        .await;
    let c = match c {
        Ok(c) => c,
        Err(_) => {
            return UsageReading {
                windows: Vec::new(),
                captured_at: None,
                stale: false,
                error: Some("plugin offline".to_owned()),
                ..Default::default()
            };
        }
    };
    if c.value.is_none() {
        return UsageReading {
            windows: Vec::new(),
            captured_at: None,
            stale: false,
            error: c.error,
            ..Default::default()
        };
    }
    let value = c.value.clone().unwrap_or(Value::Null);
    let invalid = || UsageReading {
        source: Some(UsageSource::Metered),
        windows: Vec::new(),
        captured_at: c.captured_at,
        stale: true,
        error: Some("Metered usage response is incomplete".to_owned()),
        ..Default::default()
    };
    let Some(models) = value.get("models").and_then(Value::as_array) else {
        return invalid();
    };
    let slash = model.find('/').unwrap_or(model.len());
    let provider_id = &model[..slash];
    let model_id = &model[slash.saturating_add(1)..];
    let mut tokens = 0f64;
    let mut cost = 0f64;
    let mut cost_known = true;
    for m in models {
        let Some(m_model) = m.get("model") else {
            return invalid();
        };
        if !is_obj(m_model) {
            return invalid();
        }
        let same_provider =
            m_model.get("providerID").and_then(Value::as_str) == Some(provider_id);
        let same_id = m_model.get("id").and_then(Value::as_str) == Some(model_id);
        if !same_provider || !same_id {
            continue;
        }
        let tokens_obj = m.get("tokens").unwrap_or(&Value::Null);
        if !is_obj(tokens_obj) {
            return invalid();
        }
        let mut any = false;
        let mut bad = false;
        for key in ["input", "output", "reasoning"] {
            let v = tokens_obj.get(key);
            if let Some(v) = v {
                if v == &Value::Null {
                    continue;
                }
                any = true;
                if to_num(v).is_none() || v.as_f64().unwrap_or(0.0) < 0.0 {
                    bad = true;
                }
            }
        }
        if bad || !any {
            return invalid();
        }
        for key in ["input", "output", "reasoning"] {
            tokens += to_num(tokens_obj.get(key).unwrap_or(&Value::Null)).unwrap_or(0.0);
        }
        let model_cost = to_num(m.get("cost").unwrap_or(&Value::Null));
        match model_cost {
            Some(c) if c >= 0.0 => cost += c,
            _ => cost_known = false,
        }
    }
    if !cost_known && (cfg.weekly_usd.is_some() || cfg.weekly_tokens.is_none()) {
        return invalid();
    }
    let week = || UsageWindow {
        name: String::new(),
        used_pct: None,
        resets_at: None,
        length_s: 7.0 * 86400.0,
        paced: false,
        stale: None,
    };
    let windows = if let Some(usd) = cfg.weekly_usd {
        let mut w = week();
        w.name = "7d $".to_owned();
        w.used_pct = Some((100.0 * cost) / usd);
        vec![w]
    } else if let Some(tok) = cfg.weekly_tokens {
        let mut w = week();
        w.name = "7d".to_owned();
        w.used_pct = Some((100.0 * tokens) / tok);
        vec![w]
    } else {
        Vec::new()
    };
    UsageReading {
        windows,
        captured_at: c.captured_at,
        stale: c.stale,
        error: c.error,
        source: Some(UsageSource::Metered),
        spend_usd: if cost_known { Some(cost) } else { None },
        ..Default::default()
    }
}