//! Native `agent.preview`, `agent.connect`, `agent.undo` and `agent.disconnect`
//! (`src/api/ops.ts`, `setup.agentPreview`/`agentConnect`/`agentUndo`/`agentDisconnect` in
//! `src/core/setup.ts`).
//!
//! Rust owns the `parseOpParams` refusals (executor for undo/connect/disconnect, then the
//! assistant-grant and enforcement identities) and the Zod params with byte-identical text. The
//! file plan and the undo for the setup area come from the planner plugin (`planner.preview`,
//! install capabilities, ARCH-12), which lives only in the TypeScript plugin host, so an
//! admitted request runs Core: over HTTP through its private effects bridge
//! (`/_internal/agent-effects`), over stdio as the forwarded request.
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use rusqlite::Connection;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

/// The four agent integration ops this module secures, in bridge kind order.
pub const AGENT_OPS: [&str; 4] = [
    "agent.preview",
    "agent.connect",
    "agent.undo",
    "agent.disconnect",
];

/// `parseOpParams`' executor refusal for undo/connect/disconnect, not for `agent.preview`.
pub const EXECUTOR_REFUSAL: &str = "PACER_ROLE=executor: connecting, disconnecting or undoing agent integrations rewrites real agent folders; it is for the operator, not executor sessions.";

const AGENTS: [&str; 4] = ["claude-code", "codex", "cursor", "opencode"];

/// One Core effect per call; requests are `{"kind": ...}` objects carrying the admitted params.
pub trait AgentEffects: Send {
    fn call(&mut self, request: Value) -> OpFuture<'_>;
}

/// Ops a front door dispatches through [`agent_call`] with a Core effects bridge.
pub fn uses_effects(op: &str) -> bool {
    AGENT_OPS.contains(&op)
}

/// Registry entry for the agent ops, which run only with a Core effects bridge.
pub fn agent_effects_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "agent effects bridge unavailable",
        ))
    })
}

/// Work-grant callers, whose scope Core checks.
pub fn stays_forwarded(ctx: &Ctx) -> bool {
    ctx.env
        .get("PACER_WORK_GRANT")
        .is_some_and(|grant| !grant.is_empty())
}

fn kind(op: &str) -> &'static str {
    match op {
        "agent.connect" => "connect",
        "agent.undo" => "undo",
        "agent.disconnect" => "disconnect",
        _ => "preview",
    }
}

fn received(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

/// The `parseOpParams` caller refusals preceding the schema: the executor refusal for
/// undo/connect/disconnect, then `authorizeWorkOperation` (assistant grant, enforcement).
fn authorize(ctx: &Ctx, op: &str) -> Result<(), CoreError> {
    if op != "agent.preview" && ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor") {
        return Err(CoreError::new(Code::NotAllowed, EXECUTOR_REFUSAL));
    }
    if ctx
        .env
        .get("PACER_ASSISTANT_GRANT")
        .is_some_and(|grant| !grant.is_empty())
    {
        return authorize_assistant_grant(ctx, &ctx.env["PACER_ASSISTANT_GRANT"]);
    }
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    Ok(())
}

/// Replicates `authorizeAssistantGrant` (`src/dispatch/work.ts`:129), which `authorizeWorkOperation`
/// runs first when `PACER_ASSISTANT_GRANT` is set. A malformed token, or a token with no live row
/// in `work_grants` (`tasks.db` under `pacer_home/state`) whose kind is `assistant`, is refused;
/// a live assistant grant answers nothing here, because no agent op is `assistant.tool`.
fn authorize_assistant_grant(ctx: &Ctx, token: &str) -> Result<(), CoreError> {
    if !is_pag(token) {
        return Err(CoreError::new(Code::NotAllowed, "Invalid assistant grant"));
    }
    let hash = format!("{:x}", Sha256::digest(token.as_bytes()));
    let live = Connection::open(ctx.pacer_home.join("state").join("tasks.db"))
        .ok()
        .and_then(|db| {
            db.query_row(
                "SELECT kind, expires, revoked FROM work_grants WHERE hash = ?1",
                [&hash],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                },
            )
            .ok()
        });
    match live {
        Some((kind, expires, revoked))
            if kind == "assistant" && revoked == 0 && expires > ctx.now =>
        {
            Err(CoreError::new(
                Code::NotAllowed,
                "An assistant grant runs assistant.tool only.",
            ))
        }
        _ => Err(CoreError::new(
            Code::NotAllowed,
            "Expired or revoked assistant grant",
        )),
    }
}

/// `^pag_[0-9a-f]{64}$`.
fn is_pag(token: &str) -> bool {
    token.len() == 68
        && token.starts_with("pag_")
        && token[4..].bytes().all(|b| b.is_ascii_hexdigit())
}

/// The Zod schema over the params, with issues in schema key order joined by `; `.
/// `null` params parse as `{}` (parseOpParams does `params ?? {}`), so a missing or null
/// object body reports the missing `agent` before any params-kind error.
/// `agent.preview` and `agent.disconnect` are `z.object({agent})`, which strips unknown keys
/// unvalidated, so only `agent` is checked; `agent.connect` and `agent.undo` are
/// `z.object({agent, consent?, preview_revision?})` and check `consent` and
/// `preview_revision` too.
fn schema(op: &str, params: &Value) -> Result<(), CoreError> {
    let empty = serde_json::Map::new();
    let map = match params {
        Value::Object(map) => map,
        Value::Null => &empty,
        other => {
            return Err(CoreError::new(
                Code::InvalidInput,
                format!(
                    "params: Invalid input: expected object, received {}",
                    received(other)
                ),
            ));
        }
    };
    let mut issues = Vec::new();
    match map.get("agent") {
        Some(Value::String(agent)) if AGENTS.contains(&agent.as_str()) => {}
        _ => issues.push("agent: Invalid option: expected one of \"claude-code\"|\"codex\"|\"cursor\"|\"opencode\"".to_string()),
    }
    if op == "agent.connect" || op == "agent.undo" {
        if let Some(value) = map.get("consent")
            && !value.is_boolean()
        {
            issues.push(format!(
                "consent: Invalid input: expected boolean, received {}",
                received(value)
            ));
        }
        if let Some(value) = map.get("preview_revision")
            && !value.is_string()
        {
            issues.push(format!(
                "preview_revision: Invalid input: expected string, received {}",
                received(value)
            ));
        }
    }
    if !issues.is_empty() {
        return Err(CoreError::new(Code::InvalidInput, issues.join("; ")));
    }
    Ok(())
}

/// The refusals and schema; an admitted request is the reference operation's to run.
pub fn admit(ctx: &Ctx, op: &str, params: &Value) -> Result<(), CoreError> {
    authorize(ctx, op)?;
    schema(op, params)
}

pub async fn agent_call(
    ctx: &Ctx,
    op: &str,
    params: Value,
    effects: &mut dyn AgentEffects,
) -> Result<Value, CoreError> {
    admit(ctx, op, &params)?;
    effects
        .call(json!({"kind": kind(op), "params": params}))
        .await
}
