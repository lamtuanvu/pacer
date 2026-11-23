//! `pacer-usage`: quota and metered usage readers, a Rust port of
//! `plugins/pacer-usage` (C7).
//!
//! Serves `usage.read`. The readers (`util`, `claude`, `codex`, `codex_live`,
//! `byteplus`, `metered`) read exclusively through the host's `usage`-capable
//! ReaderIO; they never touch the ambient filesystem or process state.

pub mod byteplus;
pub mod claude;
pub mod codex;
pub mod codex_live;
pub mod metered;
pub mod util;

use pacer_plugin::{Ctx, HandlerResult, Manifest, Plugin, TS_SDK_FEATURES};
use pacer_plugin::usage::{ReaderIo, reader_io};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use metered::MeteredConfig;

/// The manifest JSON, byte-equal to the TypeScript runtime manifest
/// (test/plugin-parity/manifests.test.ts).
pub const MANIFEST: &str = include_str!("../manifest.json");

pub fn manifest() -> Manifest {
    match serde_json::from_str(MANIFEST) {
        Ok(value) => Manifest(value),
        Err(error) => panic!("plugins-rs/pacer-usage/manifest.json must be valid JSON: {error}"),
    }
}

/// The native bundled plugin: serves `usage.read` with the TS SDK's feature set.
pub fn plugin() -> Plugin {
    Plugin::new(manifest())
        .features(TS_SDK_FEATURES.to_vec())
        .handle("usage.read", usage_read)
}

/// The kind of usage the caller wants (`UsageKind` in usage.ts:1).
#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum UsageKind {
    Quota,
    Metered,
    Reactive,
    Unmetered,
}

/// Where a reading came from (`UsageSource` in usage.ts:3).
#[derive(Clone, Copy, Debug, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageSource {
    StatusLine,
    SessionLog,
    ProviderCli,
    Metered,
    Reactive,
    Unmetered,
}

/// Availability gating state for an account (`availability` in usage.ts:18).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Availability {
    pub state: AvailabilityState,
    pub reason: String,
    #[serde(rename = "validUntil", default)]
    pub valid_until: Option<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum AvailabilityState {
    Ready,
    Unavailable,
    Unknown,
}

/// Provider credits signal (`SpendingSignals` in usage.ts:44-48).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct SpendingSignals {
    #[serde(rename = "creditsAvailable", default)]
    pub credits_available: Option<bool>,
    #[serde(rename = "creditBalance", default)]
    pub credit_balance: Option<f64>,
    #[serde(rename = "paidConsumption")]
    pub paid_consumption: PaidConsumption,
}

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PaidConsumption {
    Observed,
    NotObserved,
    Unknown,
}

/// One usage window of one provider (`UsageWindow` in usage.ts:6-13).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct UsageWindow {
    pub name: String,
    #[serde(rename = "usedPct", default)]
    pub used_pct: Option<f64>,
    #[serde(rename = "resetsAt", default)]
    pub resets_at: Option<f64>,
    #[serde(rename = "lengthS")]
    pub length_s: f64,
    pub paced: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub stale: Option<bool>,
}

/// A complete usage reading (`UsageReading` in usage.ts:15-27).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct UsageReading {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alternatives: Option<Vec<UsageReading>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub availability: Option<Availability>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spending: Option<SpendingSignals>,
    #[serde(default)]
    pub windows: Vec<UsageWindow>,
    #[serde(rename = "capturedAt", default)]
    pub captured_at: Option<f64>,
    pub stale: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<UsageSource>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(rename = "spendUsd", default, skip_serializing_if = "Option::is_none")]
    pub spend_usd: Option<f64>,
}

/// Host-picked resources for the readers (`ReaderContext` in usage.ts:70-75).
#[derive(Clone, Debug, Default)]
pub struct ReaderResources {
    pub claude_files: Vec<String>,
    pub codex_sessions: Option<String>,
}

/// The reader context handed to each provider reader.
pub struct ReaderContext<'a> {
    pub io: &'a dyn ReaderIo,
    pub now: f64,
    pub read_only: bool,
    pub resources: Option<&'a ReaderResources>,
}

fn empty_reading(stale: bool) -> UsageReading {
    UsageReading {
        windows: Vec::new(),
        captured_at: None,
        stale,
        ..Default::default()
    }
}

fn no_quota(provider: &str) -> UsageReading {
    UsageReading {
        windows: Vec::new(),
        captured_at: None,
        stale: false,
        error: Some(format!("no quota source for {provider}")),
        ..Default::default()
    }
}

/// `usage.read` (index.ts:12-27): dispatch on the requested usage kind.
async fn usage_read(params: Value, ctx: Ctx) -> HandlerResult {
    let owned_resources = params.get("resources").map(read_resources);
    let host_io = reader_io(&ctx.host);
    let rctx = ReaderContext {
        io: &host_io,
        now: params.get("now").and_then(Value::as_f64).unwrap_or(f64::NAN),
        read_only: params.get("readOnly").and_then(Value::as_bool).unwrap_or(false),
        resources: owned_resources.as_ref(),
    };
    let input = params;
    let result = match input
        .get("usage")
        .and_then(Value::as_str)
        .and_then(|s| serde_json::from_str::<UsageKind>(&format!("\"{s}\"")).ok())
    {
        Some(UsageKind::Quota) => quota(&input, &rctx).await,
        Some(UsageKind::Metered) => {
            let cfg = MeteredConfig::from_params(&input);
            metered::read_metered(&rctx, &cfg, refresh(&input)).await
        }
        Some(UsageKind::Reactive) => UsageReading {
            windows: Vec::new(),
            captured_at: None,
            stale: false,
            source: Some(UsageSource::Reactive),
            ..Default::default()
        },
        Some(UsageKind::Unmetered) => UsageReading {
            windows: Vec::new(),
            captured_at: None,
            stale: false,
            source: Some(UsageSource::Unmetered),
            ..Default::default()
        },
        None => return Err(pacer_plugin::PluginError::new("invalid_input", "unknown usage kind")),
    };
    serde_json::to_value(result).map_err(|e| {
        pacer_plugin::PluginError::new("internal", e.to_string())
    })
}

fn refresh(input: &Value) -> bool {
    input.get("refresh").and_then(Value::as_bool).unwrap_or(false)
}

fn read_resources(v: &Value) -> ReaderResources {
    let claude_files = v
        .get("claudeFiles")
        .and_then(Value::as_array)
        .map(|a| a.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    let codex_sessions = v
        .get("codexSessions")
        .and_then(Value::as_str)
        .map(str::to_owned);
    ReaderResources {
        claude_files,
        codex_sessions,
    }
}

async fn quota(input: &Value, rctx: &ReaderContext<'_>) -> UsageReading {
    let provider = input.get("provider").and_then(Value::as_str).unwrap_or("");
    match provider {
        "claude-code" => claude::read_claude(rctx).await,
        "codex" => {
            if refresh(input) {
                codex_live::read_codex_live(rctx).await
            } else {
                codex::read_codex(rctx).await
            }
        }
        _ => {
            if input.get("quotaSource").and_then(Value::as_str) == Some("arkcli") {
                byteplus::read_byteplus(rctx, refresh(input)).await
            } else {
                no_quota(provider)
            }
        }
    }
}