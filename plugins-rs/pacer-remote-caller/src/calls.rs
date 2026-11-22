//! Implements the five `remoteCaller.*` handlers. Port of
//! `plugins/pacer-remote-caller/index.ts`: every handler opens a session for the
//! requested `alias`, performs the primary work, then closes the session.
//!
//! The close-because semantics of the TypeScript `try`/`finally` (with or
//! without a `catch` that flips `failed`) are reproduced exactly:
//!
//! * `finally` without `catch` (reachability, identity, questionRead): close
//!   always runs; a close failure replaces the primary result or error.
//! * `finally` with a `failed` flag (fetch, usageRead): a failed primary
//!   swallows a close error and preserves the original error; a successful
//!   primary lets a close error replace the reply.

use pacer_plugin::{Ctx, HandlerResult, PluginError};
use serde_json::{Value, json};

/// Fixed PROBE script timing, mirroring index.ts: PROBE 15000/65536.
const PROBE_TIMEOUT_MS: u64 = 15_000;
const PROBE_MAX_BYTES: u64 = 65_536;
/// Fixed SET_IDENTITY timing, mirroring index.ts: 50000/65536.
const IDENTITY_TIMEOUT_MS: u64 = 50_000;
const IDENTITY_MAX_BYTES: u64 = 65_536;
/// Fixed QUESTION timing, mirroring index.ts: 20000/8192.
const QUESTION_TIMEOUT_MS: u64 = 20_000;
const QUESTION_MAX_BYTES: u64 = 8192;
/// Fixed CODEX_USAGE timing, mirroring index.ts: 60000/65536.
const CODEX_TIMEOUT_MS: u64 = 60_000;
const CODEX_MAX_BYTES: u64 = 65_536;

/// The params for `capability.hosts.open`, mirroring
/// `createHosts.open(alias)` (packages/plugin-sdk/src/hosts.ts): `{alias}`
/// only when the request carries an `alias` field, otherwise `{}` (JSON drops
/// an `undefined` alias).
fn open_params(params: &Value) -> Value {
    match params.get("alias") {
        Some(alias) => json!({ "alias": alias }),
        None => json!({}),
    }
}

/// Open the remote session for `params.alias`. The session string defaults to
/// `""` when the host returns none (mirroring an `undefined` `opened.session`).
async fn open(ctx: &Ctx, params: &Value) -> Result<String, PluginError> {
    let opened = ctx.host.call("capability.hosts.open", open_params(params)).await?;
    Ok(opened
        .get("session")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_owned())
}

/// Run one fixed script on `session` (`capability.hosts.run`).
async fn run(
    ctx: &Ctx,
    session: &str,
    script: &str,
    args: Value,
    timeout_ms: u64,
    max_bytes: u64,
) -> Result<Value, PluginError> {
    ctx.host
        .call(
            "capability.hosts.run",
            json!({
                "session": session,
                "script": script,
                "args": args,
                "timeoutMs": timeout_ms,
                "maxBytes": max_bytes
            }),
        )
        .await
}

/// Close `session` (`capability.hosts.close`).
async fn close(ctx: &Ctx, session: &str) -> Result<Value, PluginError> {
    ctx.host
        .call("capability.hosts.close", json!({ "session": session }))
        .await
}

/// `try { primary } finally { close }`: close always runs and a close failure
/// replaces the primary result or error.
async fn finally_close(
    primary: Result<Value, PluginError>,
    close: Result<Value, PluginError>,
) -> HandlerResult {
    match (primary, close) {
        (Ok(value), Ok(_)) => Ok(value),
        (Err(error), Ok(_)) => Err(error),
        (_, Err(error)) => Err(error),
    }
}

/// `try { primary } catch { failed = true; throw } finally { if failed close().catch else close }`:
/// a failed primary keeps its own error (a close error is swallowed); a
/// successful primary lets a close error replace the reply.
async fn swallow_close_after_failure(
    primary: Result<Value, PluginError>,
    close_result: Result<Value, PluginError>,
) -> HandlerResult {
    match primary {
        Ok(value) => match close_result {
            Ok(_) => Ok(value),
            Err(close_error) => Err(close_error),
        },
        Err(error) => {
            // `close().catch(() => {})` — a retired lease may refuse close after
            // a failure; preserve the original transfer error.
            let _ = close_result;
            Err(error)
        }
    }
}

/// Handle `remoteCaller.reachability`: open, PROBE, close; answer
/// `{reachable}` from the probe result.
pub async fn reachability(params: Value, ctx: Ctx) -> HandlerResult {
    let session = open(&ctx, &params).await?;
    let primary = run(
        &ctx,
        &session,
        "PROBE",
        json!([]),
        PROBE_TIMEOUT_MS,
        PROBE_MAX_BYTES,
    )
    .await;
    let close_result = close(&ctx, &session).await;
    let result = finally_close(primary, close_result).await;
    result.map(|value| {
        let code = value.get("code").and_then(Value::as_i64).unwrap_or(-1);
        let timed_out = value
            .get("timedOut")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        json!({ "reachable": code == 0 && !timed_out })
    })
}

/// Handle `remoteCaller.fetch`: open, fetch with request timeouts, close
/// swallowing a close error after a failed primary.
pub async fn fetch(params: Value, ctx: Ctx) -> HandlerResult {
    let session = open(&ctx, &params).await?;
    let mut fetch_params = json!({ "session": session });
    // Only echo the request's timeoutMs/maxBytes when present (JSON drops an
    // absent number field), mirroring index.ts.
    if params.get("timeoutMs").is_some() {
        fetch_params["timeoutMs"] = params["timeoutMs"].clone();
    }
    if params.get("maxBytes").is_some() {
        fetch_params["maxBytes"] = params["maxBytes"].clone();
    }
    let primary = ctx
        .host
        .call("capability.hosts.fetch", fetch_params)
        .await;
    let close_result = close(&ctx, &session).await;
    swallow_close_after_failure(primary, close_result).await
}

/// Handle `remoteCaller.identity`: open, SET_IDENTITY with the three identity
/// args, close.
pub async fn identity(params: Value, ctx: Ctx) -> HandlerResult {
    let session = open(&ctx, &params).await?;
    let args = json!([
        params.get("path").cloned(),
        params.get("name").cloned(),
        params.get("email").cloned()
    ]);
    let primary = run(
        &ctx,
        &session,
        "SET_IDENTITY",
        args,
        IDENTITY_TIMEOUT_MS,
        IDENTITY_MAX_BYTES,
    )
    .await;
    let close_result = close(&ctx, &session).await;
    finally_close(primary, close_result).await
}

/// Handle `remoteCaller.questionRead`: open, QUESTION with the path, close.
pub async fn question_read(params: Value, ctx: Ctx) -> HandlerResult {
    let session = open(&ctx, &params).await?;
    let args = json!([params.get("path").cloned()]);
    let primary = run(
        &ctx,
        &session,
        "QUESTION",
        args,
        QUESTION_TIMEOUT_MS,
        QUESTION_MAX_BYTES,
    )
    .await;
    let close_result = close(&ctx, &session).await;
    finally_close(primary, close_result).await
}

/// Handle `remoteCaller.usageRead`: open, CODEX_USAGE with `[home]` only when
/// `home` is truthy (JS), close.
pub async fn usage_read(params: Value, ctx: Ctx) -> HandlerResult {
    let session = open(&ctx, &params).await?;
    let args = match params.get("home").and_then(Value::as_str) {
        Some(home) if !home.is_empty() => json!([home]),
        _ => json!([]),
    };
    let primary = run(
        &ctx,
        &session,
        "CODEX_USAGE",
        args,
        CODEX_TIMEOUT_MS,
        CODEX_MAX_BYTES,
    )
    .await;
    let close_result = close(&ctx, &session).await;
    swallow_close_after_failure(primary, close_result).await
}
