//! Native `readAccountUsage` / `refreshAccountUsage` (`src/usage/index.ts`,
//! `src/usage/refresh.ts`). Reads go through the S2 extension door; every
//! process-local piece of the TypeScript broker — the memo, shared pending
//! reads, last-good merge, the 10 s race, the persisted store, auth marks and
//! the single-flight refresh coordinator — is mirrored here.

#![allow(clippy::result_large_err)] // CoreError is the shared public operation ABI.

use futures::{FutureExt, future::{BoxFuture, Shared}};
use pacer_config::strategy::load_strategy;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_plugin_ops::extension::ExtensionCalls;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    future::Future,
    pin::Pin,
    sync::{Arc, Mutex},
    time::Duration,
};

use crate::{
    evidence::account_scope,
    freshness::{USAGE_MEMO_S, mark_freshness},
    marks::record_auth_reading,
    remote_usage::cached_remote_usage,
    trace::StatusTimer,
    usage_spec::UsageCall,
    usage_store::{read_usage_entry, write_usage_entry},
};

pub type UsageFuture<'a> = Pin<Box<dyn Future<Output = Result<Value, CoreError>> + Send + 'a>>;

#[derive(Clone, Copy, Debug, Default)]
pub struct ReadMode {
    pub refresh: bool,
    pub cache_only: bool,
    pub read_only: bool,
}

/// Usage readings and refresh, the names the B4/B6/B8 plan consumes (K5).
pub trait UsageReads: Send + Sync {
    /// `readAccountUsage` (`src/usage/index.ts:84-115`): one budget per account.
    fn read_account_usage<'a>(
        &'a self,
        ctx: &'a Ctx,
        account: &'a Value,
        runners: &'a [Value],
        hosts: &'a Value,
        mode: ReadMode,
    ) -> UsageFuture<'a>;

    /// `refreshAccountUsage` (`src/usage/refresh.ts:19-41`).
    fn refresh_account_usage<'a>(&'a self, ctx: &'a Ctx, name: &'a str, automatic: bool) -> UsageFuture<'a>;
}

/// A plugin call channel per request (S2 `DoorCalls`; B0c Rust-sealed calls).
pub trait PluginDoor: Send + Sync {
    fn calls(&self) -> Box<dyn ExtensionCalls + '_>;
}

type SharedReading = Shared<BoxFuture<'static, Value>>;

#[derive(Clone)]
struct Source {
    at: f64,
    value: Option<Value>,
    pending: Option<SharedReading>,
    refreshing: bool,
}

struct Inner {
    door: Arc<dyn PluginDoor>,
    sources: Mutex<HashMap<String, Source>>,
    refresh_pending: Mutex<HashMap<String, SharedReading>>,
    automatic_at: Mutex<HashMap<String, f64>>,
}

/// The process-wide implementation: the TypeScript `sources` memo, `pending`
/// and `automaticAt` maps. Held behind an `Arc` so a shared pending read outlives
/// the caller that started it.
pub struct NativeUsage {
    inner: Arc<Inner>,
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

fn code_name(code: &Code) -> &'static str {
    match code {
        Code::UnknownOp => "unknown_op",
        Code::UnknownTask => "unknown_task",
        Code::InvalidInput => "invalid_input",
        Code::UnknownExecutor => "unknown_executor",
        Code::Conflict => "conflict",
        Code::NotAllowed => "not_allowed",
        Code::NotFound => "not_found",
        Code::TooLarge => "too_large",
        Code::Internal => "internal",
        Code::Unavailable => "unavailable",
        Code::RateLimited => "rate_limited",
        Code::PluginTimeout => "plugin_timeout",
        Code::PluginUnavailable => "plugin_unavailable",
        Code::PluginRefused => "plugin_refused",
        Code::CapabilityDenied => "capability_denied",
        Code::UnknownPlugin => "unknown_plugin",
    }
}

fn without_error_code(mut reading: Value) -> Value {
    if let Some(object) = reading.as_object_mut() {
        object.remove("errorCode");
    }
    reading
}

fn has_windows(reading: &Value) -> bool {
    reading.get("windows").and_then(Value::as_array).is_some_and(|w| !w.is_empty())
}

fn merge_last_good(last_good: &Value, error: &Value, code: Option<&str>, availability: Option<&Value>) -> Value {
    let mut out = without_error_code(last_good.clone());
    out["stale"] = Value::Bool(true);
    out["error"] = error.clone();
    if let Some(code) = code {
        out["errorCode"] = Value::from(code);
    }
    if let Some(availability) = availability {
        out["availability"] = availability.clone();
    }
    out
}

impl NativeUsage {
    pub fn new(door: Arc<dyn PluginDoor>) -> Arc<Self> {
        Arc::new(Self {
            inner: Arc::new(Inner {
                door,
                sources: Mutex::new(HashMap::new()),
                refresh_pending: Mutex::new(HashMap::new()),
                automatic_at: Mutex::new(HashMap::new()),
            }),
        })
    }

    fn source_key(ctx: &Ctx, cfg: &Value, account: Option<&Value>, hosts: &Value) -> (String, String) {
        let source = if text(cfg, "usage") == "quota" {
            if text(cfg, "quotaSource") == "arkcli" {
                "arkcli".to_string()
            } else {
                text(cfg, "id").to_string()
            }
        } else {
            pacer_js_json::stringify(cfg)
        };
        let key = format!(
            "{}:{}:{}:{}",
            ctx.pacer_home.to_string_lossy(),
            source,
            pacer_js_json::stringify(&account.cloned().unwrap_or(Value::Null)),
            pacer_js_json::stringify(hosts)
        );
        (source, key)
    }

    fn stored_for(&self, ctx: &Ctx, account: Option<&Value>, hosts: &Value, source: &str) -> Option<Value> {
        let account = account?;
        let scope = account_scope(account, hosts);
        read_usage_entry(ctx, scope.get("identity")?.as_str()?, source)
    }

    /// One plugin call, with the host-derived spec in the private body.
    async fn base(
        &self,
        ctx: &Ctx,
        cfg: &Value,
        account: Option<&Value>,
        refresh: bool,
        read_only: bool,
    ) -> Result<Value, CoreError> {
        let mut calls = self.inner.door.calls();
        let entries = calls.entries(ctx).await?;
        let spec = crate::usage_spec::usage_call_spec(ctx, cfg, account, refresh, read_only, &entries);
        let UsageCall::Plugin { plugin, params, resources, account_home } = spec else {
            let UsageCall::Immediate(reading) = spec else { unreachable!() };
            return Ok(reading);
        };
        let body = json!({
            "account": account.map(|a| a.get("name").cloned().unwrap_or(Value::Null)).unwrap_or(Value::Null),
            "cfg": cfg,
            "refresh": refresh,
            "spec": {"params": params, "resources": resources, "accountHome": account_home},
        });
        let reply = calls.call(ctx, &plugin, "usage.read", body).await?;
        if let Some(reading) = reply.get("reading") {
            return Ok(reading.clone());
        }
        // A `{thrown, errorCode}` reply is the TS catch branch: the plugin's
        // failure is an error string in a reading, never a host error.
        let thrown = reply.get("thrown").and_then(Value::as_str).unwrap_or("plugin error");
        let mut reading = json!({"windows": [], "capturedAt": null, "stale": false, "error": thrown});
        if let Some(code) = reply.get("errorCode").and_then(Value::as_str) {
            reading["errorCode"] = Value::from(code);
        }
        Ok(reading)
    }

    #[allow(clippy::too_many_arguments)]
    async fn read_once(
        &self,
        ctx: Ctx,
        cfg: Value,
        account: Option<Value>,
        hosts: Value,
        source: String,
        key: String,
        mode: ReadMode,
        hit: Option<Source>,
        last_good: Option<Value>,
    ) -> Value {
        let mut timer = StatusTimer::new(&ctx);
        let scope = account.as_ref().map(|a| account_scope(a, &hosts));
        let record = |this: &Self, reading: &Value| {
            if let (Some(account), Some(scope)) = (&account, &scope) {
                let _ = record_auth_reading(&ctx, text(account, "name"), reading, Some(scope), mode.read_only);
            }
            let _ = this;
        };
        let raced = tokio::time::timeout(
            Duration::from_secs(10),
            self.base(&ctx, &cfg, account.as_ref(), mode.refresh, mode.read_only),
        )
        .await;
        let value = match raced {
            Ok(Ok(reading)) => {
                let reading = without_error_code(reading);
                record(self, &reading);
                let replaces = matches!(
                    reading.get("availability").and_then(|a| a.get("reason")).and_then(Value::as_str),
                    Some("authentication_failed" | "subscription_missing")
                );
                let prior = hit.as_ref().and_then(|h| h.value.as_ref());
                if replaces {
                    reading
                } else if reading.get("error").is_some() && last_good.as_ref().is_some_and(has_windows) {
                    merge_last_good(
                        last_good.as_ref().unwrap(),
                        reading.get("error").unwrap(),
                        None,
                        reading.get("availability"),
                    )
                } else if prior
                    .and_then(|p| p.get("capturedAt"))
                    .and_then(Value::as_f64)
                    .is_some_and(|at| reading.get("capturedAt").and_then(Value::as_f64).is_none_or(|new| new < at))
                {
                    prior.cloned().unwrap()
                } else {
                    reading
                }
            }
            Ok(Err(error)) => {
                let code = code_name(&error.code);
                let reading = json!({
                    "windows": [], "capturedAt": null, "stale": false,
                    "error": format!("CoreError: {}", error.message),
                    "errorCode": code,
                });
                record(self, &reading);
                if last_good.as_ref().is_some_and(has_windows) {
                    merge_last_good(last_good.as_ref().unwrap(), &reading["error"], Some(code), None)
                } else {
                    reading
                }
            }
            Err(_) => {
                let reading = json!({
                    "windows": [], "capturedAt": null, "stale": false,
                    "error": format!("Error: usage source {source} timed out"),
                });
                record(self, &reading);
                if last_good.as_ref().is_some_and(has_windows) {
                    merge_last_good(last_good.as_ref().unwrap(), &reading["error"], None, None)
                } else {
                    reading
                }
            }
        };
        timer.phase(&format!("usage.{}", if text(&cfg, "quotaSource") == "arkcli" { "arkcli" } else { text(&cfg, "id") }));
        {
            let mut sources = self.inner.sources.lock().unwrap();
            if let Some(entry) = sources.get_mut(&key) {
                entry.value = Some(value.clone());
                entry.pending = None;
            }
        }
        if let (Some(account), Some(scope)) = (&account, &scope) {
            if let Some(identity) = scope.get("identity").and_then(Value::as_str) {
                // A store failure never fails a reading that succeeded.
                let _ = write_usage_entry(&ctx, identity, &source, &value, mode.read_only);
            }
            let _ = account;
        }
        value
    }

    async fn cached_base_owned(
        &self,
        ctx: Ctx,
        cfg: Value,
        account: Option<Value>,
        hosts: Value,
        mode: ReadMode,
    ) -> Value {
        let (source, key) = Self::source_key(&ctx, &cfg, account.as_ref(), &hosts);
        let hit = self.inner.sources.lock().unwrap().get(&key).cloned();
        if mode.cache_only {
            let reading = hit
                .as_ref()
                .and_then(|h| h.value.clone())
                .or_else(|| self.stored_for(&ctx, account.as_ref(), &hosts, &source));
            return match reading {
                Some(reading) => mark_freshness(&reading, ctx.now),
                None => json!({"windows": [], "capturedAt": null, "stale": true}),
            };
        }
        if let Some(pending) = hit.as_ref().and_then(|h| h.pending.clone()) {
            if !mode.refresh || hit.as_ref().is_some_and(|h| h.refreshing) {
                return pending.await;
            }
            let _ = pending.await;
            let next = ReadMode { refresh: true, ..mode };
            return Box::pin(self.cached_base_owned(ctx, cfg, account, hosts, next)).await;
        }
        if !mode.refresh {
            if let Some(value) = hit.as_ref().and_then(|h| h.value.as_ref()) {
                let elapsed = ctx.now - hit.as_ref().unwrap().at;
                if elapsed >= 0.0 && elapsed < USAGE_MEMO_S {
                    return value.clone();
                }
            }
        }
        let last_good = hit
            .as_ref()
            .and_then(|h| h.value.as_ref())
            .filter(|v| has_windows(v))
            .cloned()
            .or_else(|| self.stored_for(&ctx, account.as_ref(), &hosts, &source));
        let shared = {
            let mut sources = self.inner.sources.lock().unwrap();
            let entry = sources.entry(key.clone()).or_insert(Source {
                at: ctx.now,
                value: None,
                pending: None,
                refreshing: false,
            });
            entry.at = ctx.now;
            entry.refreshing = mode.refresh;
            let this = NativeUsage { inner: self.inner.clone() };
            let future: BoxFuture<'static, Value> = Box::pin(async move {
                this.read_once(ctx, cfg, account, hosts, source, key, mode, hit, last_good).await
            });
            let shared = future.shared();
            entry.pending = Some(shared.clone());
            shared
        };
        shared.await
    }
}

impl UsageReads for NativeUsage {
    fn read_account_usage<'a>(
        &'a self,
        ctx: &'a Ctx,
        account: &'a Value,
        runners: &'a [Value],
        hosts: &'a Value,
        mode: ReadMode,
    ) -> UsageFuture<'a> {
        let inner = self.inner.clone();
        let ctx = ctx.clone();
        let account = account.clone();
        let runners = runners.to_vec();
        let hosts = hosts.clone();
        Box::pin(async move {
            let this = NativeUsage { inner };
            let source = crate::usage_spec::provider_cfg(&account, &runners);
            let reading = this
                .cached_base_owned(ctx.clone(), source.clone(), Some(account.clone()), hosts.clone(), mode)
                .await;
            if text(&source, "usage") != "metered" {
                let remote = if text(&account, "kind") == "codex" && text(&source, "usage") == "quota" {
                    cached_remote_usage(&ctx, &account, Some(&hosts))
                } else {
                    None
                };
                let Some(remote) = remote else { return Ok(reading) };
                let newer = remote.get("capturedAt").and_then(Value::as_f64).is_some_and(|at| {
                    reading.get("capturedAt").and_then(Value::as_f64).is_none_or(|local| at > local)
                });
                return Ok(if newer {
                    merge_alternatives(&remote, &reading)
                } else {
                    merge_alternatives(&reading, &remote)
                });
            }
            let mut models: Vec<Value> = Vec::new();
            for runner in &runners {
                let model = runner.get("model").cloned().unwrap_or(Value::Null);
                if !models.contains(&model) {
                    models.push(model);
                }
            }
            if models.is_empty() {
                return Ok(reading);
            }
            let cfg_for = |model: &Value| {
                let mut cfg = source.clone();
                cfg["model"] = model.clone();
                cfg
            };
            let mut readings = Vec::new();
            for model in &models {
                readings.push(
                    this.cached_base_owned(
                        ctx.clone(),
                        cfg_for(model),
                        Some(account.clone()),
                        hosts.clone(),
                        mode,
                    )
                    .await,
                );
            }
            Ok(aggregate_metered(&readings))
        })
    }

    fn refresh_account_usage<'a>(&'a self, ctx: &'a Ctx, name: &'a str, automatic: bool) -> UsageFuture<'a> {
        let inner = self.inner.clone();
        let ctx = ctx.clone();
        let name = name.to_string();
        Box::pin(async move {
            let this = NativeUsage { inner };
            this.refresh_owned(&ctx, &name, automatic).await
        })
    }
}

/// `{ ...first, alternatives: [...(first.alternatives ?? []), other] }` with
/// the remote reading first when it is newer (index.ts:99-100).
fn merge_alternatives(first: &Value, other: &Value) -> Value {
    let mut out = first.clone();
    let object = out.as_object_mut().unwrap();
    let mut alternatives = object
        .get("alternatives")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    alternatives.push(other.clone());
    object.insert("alternatives".to_string(), Value::Array(alternatives));
    out
}

/// The metered per-model merge from `src/usage/index.ts:102-114`.
fn aggregate_metered(readings: &[Value]) -> Value {
    let first = readings.first().cloned().unwrap_or(Value::Null);
    let mut out = first.clone();
    let every: fn(&Value, &str) -> bool = |r, key| r.get(key).is_some_and(|v| !v.is_null());
    let errors: Vec<&str> = readings
        .iter()
        .filter_map(|r| r.get("error").and_then(Value::as_str).filter(|s| !s.is_empty()))
        .collect();
    if readings.iter().all(|r| every(r, "spendUsd")) {
        let sum: f64 = readings.iter().filter_map(|r| r["spendUsd"].as_f64()).sum();
        out["spendUsd"] = Value::from(sum);
    } else {
        out.as_object_mut().unwrap().remove("spendUsd");
    }
    if let Some(windows) = first.get("windows").and_then(Value::as_array).cloned() {
        let merged: Vec<Value> = windows
            .iter()
            .map(|w| {
                let name = w.get("name").and_then(Value::as_str).unwrap_or("");
                let incomplete = readings.iter().any(|r| {
                    r.get("error").is_some_and(truthy)
                        || r["windows"].as_array().and_then(|ws| ws.iter().find(|v| v["name"] == name))
                            .and_then(|v| v.get("usedPct")).is_none_or(Value::is_null)
                });
                let mut out = w.clone();
                out["usedPct"] = if incomplete {
                    Value::Null
                } else {
                    let sum: f64 = readings.iter().filter_map(|r| {
                        r["windows"].as_array().and_then(|ws| ws.iter().find(|v| v["name"] == name))
                            .and_then(|v| v["usedPct"].as_f64())
                    }).sum();
                    Value::from(sum)
                };
                out
            })
            .collect();
        out["windows"] = Value::Array(merged);
    }
    out["capturedAt"] = if readings.iter().all(|r| r.get("capturedAt").is_some_and(|v| !v.is_null())) {
        Value::from(readings.iter().filter_map(|r| r["capturedAt"].as_f64()).fold(f64::INFINITY, f64::min))
    } else {
        Value::Null
    };
    out["stale"] = Value::Bool(readings.iter().any(|r| {
        r["stale"].as_bool().unwrap_or(false) || r.get("error").is_some_and(truthy)
    }));
    if errors.is_empty() {
        out.as_object_mut().unwrap().remove("error");
    } else {
        out["error"] = Value::from(errors.join("; "));
    }
    if let Some(code) = readings.iter().find_map(|r| {
        if r.get("error").is_some_and(truthy) { r["errorCode"].as_str().map(str::to_string) } else { None }
    }) {
        out["errorCode"] = Value::from(code);
    }
    out
}

fn truthy(value: &Value) -> bool {
    pacer_js_json::js_semantics::truthy(value)
}

impl NativeUsage {
    async fn refresh_owned(&self, ctx: &Ctx, name: &str, automatic: bool) -> Result<Value, CoreError> {
        let strategy = load_strategy(&ctx.pacer_home)
            .map_err(|e| CoreError::new(Code::Internal, format!("load strategy: {e}")))?;
        let Some(account) = strategy["accounts"].get(name) else {
            let mut error = CoreError::new(Code::InvalidInput, format!("Unknown account {name}"));
            error.hint = Some("Run pacer account list to see configured accounts.".to_string());
            return Err(error);
        };
        let hosts = strategy["hosts"].clone();
        let key = format!(
            "{}:{}:{}",
            ctx.pacer_home.to_string_lossy(),
            pacer_js_json::stringify(account),
            pacer_js_json::stringify(&hosts)
        );
        let running = { self.inner.refresh_pending.lock().unwrap().get(&key).cloned() };
        if let Some(running) = running {
            return Ok(running.await);
        }
        let capability = crate::refresh::refresh_capability(account);
        if capability == "unavailable" {
            return Ok(json!({"account": name, "capability": capability, "outcome": "unsupported",
                "capturedAt": null, "source": null, "error": null}));
        }
        let runners: Vec<Value> = strategy["runners"]
            .as_object()
            .map(|runners| {
                runners
                    .values()
                    .filter(|runner| runner.get("account").and_then(Value::as_str) == Some(name))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default();
        let this = self.inner.clone();
        let ctx = ctx.clone();
        let account = account.clone();
        let name = name.to_string();
        let capability = capability.to_string();
        let job_key = key.clone();
        let future: BoxFuture<'static, Value> = Box::pin(async move {
            let this = NativeUsage { inner: this };
            let prior: Value = this
                .cached_base_owned(
                    ctx.clone(),
                    provider_cfg(&account, &runners),
                    Some(account.clone()),
                    hosts.clone(),
                    ReadMode { cache_only: true, ..ReadMode::default() },
                )
                .await;
            let suppressed = automatic
                && ctx.now - this.inner.automatic_at.lock().unwrap().get(&job_key).copied()
                    .unwrap_or(f64::NEG_INFINITY)
                    < crate::refresh::AUTOMATIC_INTERVAL_S;
            let (outcome, reading) = if suppressed {
                ("unchanged", prior)
            } else {
                this.inner.automatic_at.lock().unwrap().insert(job_key.clone(), ctx.now);
                let current: Value = this
                    .cached_base_owned(
                        ctx.clone(),
                        provider_cfg(&account, &runners),
                        Some(account.clone()),
                        hosts.clone(),
                        ReadMode { refresh: true, ..ReadMode::default() },
                    )
                    .await;
                let outcome = crate::refresh::refresh_outcome(&capability, &prior, &current);
                (outcome, current)
            };
            json!({
                "account": name,
                "capability": capability,
                "outcome": outcome,
                "capturedAt": reading.get("capturedAt").cloned().unwrap_or(Value::Null),
                "source": reading.get("source").cloned().unwrap_or(Value::Null),
                "error": reading.get("error").cloned().unwrap_or(Value::Null),
            })
        });
        let shared = future.shared();
        self.inner.refresh_pending.lock().unwrap().insert(key.clone(), shared.clone());
        let value = shared.await;
        self.inner.refresh_pending.lock().unwrap().remove(&key);
        Ok(value)
    }
}

use crate::usage_spec::provider_cfg;
