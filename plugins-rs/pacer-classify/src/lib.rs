//! `pacer-classify`: classifier adapters (rules, ollama, jev), a Rust port of
//! `plugins/pacer-classify` (C6).
//!
//! Serves `classifier.adapters` and `classifier.ask`. The pure logic lives in
//! [`http`], [`config`], [`rules`], [`ollama`], and [`jev`]; the handlers
//! wire it to the host's `config`, `net.http`, `secrets`, and time.

pub mod config;
pub mod http;
pub mod jev;
pub mod ollama;
pub mod rules;

use std::sync::Arc;

use pacer_plugin::{Ctx, HandlerResult, Manifest, Plugin, TS_SDK_FEATURES};
use serde_json::{Value, json};

use config::Adapter;

/// The manifest JSON, byte-equal to the TypeScript runtime manifest.
pub const MANIFEST: &str = include_str!("../manifest.json");

pub fn manifest() -> Manifest {
    match serde_json::from_str(MANIFEST) {
        Ok(value) => Manifest(value),
        Err(error) => panic!("plugins-rs/pacer-classify/manifest.json must be valid JSON: {error}"),
    }
}

/// A millisecond clock; latency is measured as the difference between two
/// readings, so a shared monotonic origin is used.
static ORIGIN: std::sync::OnceLock<std::time::Instant> = std::sync::OnceLock::new();

fn now_ms() -> f64 {
    let origin = *ORIGIN.get_or_init(std::time::Instant::now);
    origin.elapsed().as_secs_f64() * 1000.0
}

/// `now: () -> number`, injectable for tests.
pub type Clock = dyn Fn() -> f64 + Send + Sync;

/// The bundled plugin with the real clock.
pub fn plugin() -> Plugin {
    plugin_with(Arc::new(now_ms))
}

/// The bundled plugin with a caller-supplied clock (for harness tests).
pub fn plugin_with(now: Arc<Clock>) -> Plugin {
    Plugin::new(manifest())
        .features(TS_SDK_FEATURES.to_vec())
        .handle("classifier.adapters", move |_params, ctx| async move {
            adapters(&ctx).await
        })
        .handle("classifier.ask", move |params, ctx| {
            let now = now.clone();
            async move { ask(&params, &ctx, now.as_ref()).await }
        })
}

/// `classifier.adapters` (index.ts:10): advertise the three adapters after
/// validating the host configuration snapshot.
async fn adapters(ctx: &Ctx) -> HandlerResult {
    let config = ctx.host.config().await?;
    let snapshot = Value::Object(config);
    let parsed = config::parse_adapter_config(&snapshot)?;
    Ok(json!({
        "adapters": [
            { "id": "rules", "external": false },
            { "id": "ollama", "external": !http::is_local_url(&parsed.ollama.base_url) },
            { "id": "jev", "external": true },
        ]
    }))
}

/// `classifier.ask` (index.ts:11-15): dispatch on the requested adapter using
/// the caller's configuration snapshot.
async fn ask(params: &Value, ctx: &Ctx, now: &(dyn Fn() -> f64 + Send + Sync)) -> HandlerResult {
    let input = config::parse_ask_input(params)?;
    let q = &input.question;
    let state = &input.state;
    let timeout = input.timeout_ms;
    match input.adapter {
        Adapter::Rules => {
            config::parse_rules_config(&input.config)?;
            rules::ask_rule(q.id(), state)
        }
        Adapter::Ollama => {
            let cfg = config::parse_ollama_config(&input.config)?;
            ollama::ask_ollama(&ctx.host, &cfg, state, q, timeout, now).await
        }
        Adapter::Jev => {
            let cfg = config::parse_jev_config(&input.config)?;
            jev::ask_jev(&ctx.host, &cfg, state, q, timeout, now).await
        }
    }
}