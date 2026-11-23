//! `assistant.reply`, the executor backend. Port of
//! `plugins/assistant-executor/index.ts` `readAll`, `run`, `resumeFailed`,
//! `mcpConnectFailed`, `sawHook`, `parseAsk` and `reply` (index.ts:215-408).

use pacer_plugin::{Ctx, HandlerResult, Host, PluginError, js};
use serde_json::{Map, Value, json};

use crate::claude::{claude_expect_from_command, parse_claude_control_run, parse_claude_run};
use crate::parse::parse_run;

/// Well-known secret ref the host binds for ask-mode grants (index.ts:338).
pub const ASK_GRANT_REF: &str = "secrets:assistantAskGrant";

const CLAUDE_EMPTY_MCP: &str = "{\"mcpServers\":{}}";
const MAX_OUTPUT: usize = 16 * 1024 * 1024;
const CHUNK_LEN: u64 = 262144;

/// The host-issued ask-mode command (index.ts `AskCommand`).
#[derive(Debug, Clone)]
pub struct AskCommand {
    pub argv: Vec<String>,
    pub cwd: String,
    /// Environment as the host built the command (plain string values).
    pub env: Map<String, Value>,
    pub stdin: String,
    pub timeout_ms: u64,
}

impl AskCommand {
    /// Parse an `AskCommand` object from the reply params.
    pub fn from_value(v: &Value) -> Option<AskCommand> {
        let obj = v.as_object()?;
        let argv: Vec<String> = obj
            .get("argv")
            .and_then(Value::as_array)?
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        let env: Map<String, Value> = obj
            .get("env")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        Some(AskCommand {
            argv,
            cwd: obj.get("cwd").and_then(Value::as_str).unwrap_or("").to_owned(),
            env,
            stdin: obj.get("stdin").and_then(Value::as_str).unwrap_or("").to_owned(),
            timeout_ms: obj
                .get("timeoutMs")
                .and_then(Value::as_u64)
                .unwrap_or(0),
        })
    }
}

/// `--flag=value` or `--flag value` lookup (index.ts `argvFlag`).
pub(crate) fn argv_flag(argv: &[String], name: &str) -> Option<String> {
    if let Some(eq) = argv.iter().find(|a| a.starts_with(&format!("{name}="))) {
        return Some(eq[name.len() + 1..].to_owned());
    }
    let at = argv.iter().position(|a| a == name)?;
    argv.get(at + 1).cloned()
}

/// `argvFlag` over an `AskCommand`.
impl AskCommand {
    pub fn flag(&self, name: &str) -> Option<String> {
        argv_flag(&self.argv, name)
    }
}

/// Refs bound by the host as secret references for one turn's grants.
#[derive(Default)]
struct Refs {
    config_ref: Option<String>,
    grant_ref: Option<String>,
}

/// Read a spawned process's buffered output via `capability.process.outputChunk`
/// (index.ts `readAll`): chunks of at most 262144 bytes until an empty chunk or
/// 16 MiB, decoded leniently then lossy UTF-8.
async fn read_all(host: &Host, handle: &str) -> Result<String, PluginError> {
    let mut parts: Vec<u8> = Vec::new();
    let mut offset: u64 = 0;
    while offset < MAX_OUTPUT as u64 {
        let base64 = host
            .call(
                "capability.process.outputChunk",
                json!({ "handle": handle, "offset": offset, "length": CHUNK_LEN }),
            )
            .await?
            .get("base64")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        let bytes = js::base64::decode_lenient(&base64);
        if bytes.is_empty() {
            break;
        }
        let len = bytes.len() as u64;
        parts.extend_from_slice(&bytes);
        offset += len;
    }
    Ok(String::from_utf8_lossy(&parts).into_owned())
}

/// What one ask-mode CLI run produced.
struct RunValue {
    code: i64,
    timed_out: bool,
    stdout: String,
}

/// Run one ask-mode command, binding the grant only as a secret env reference
/// (index.ts `run`, lines 340-362).
async fn run(host: &Host, refs: &Refs, c: &AskCommand) -> Result<RunValue, PluginError> {
    let is_claude = c.argv.first().map(String::as_str) == Some("claude");
    let is_acp = c.argv.first().map(String::as_str) == Some("opencode")
        && c.argv.get(1).map(String::as_str) == Some("acp");
    let is_codex = c.argv.first().map(String::as_str) == Some("codex");
    let mcp = c.flag("--mcp-config");
    let wants_claude_grant = is_claude
        && refs.grant_ref.is_some()
        && mcp.as_deref().is_some_and(|m| m != CLAUDE_EMPTY_MCP);

    let mut env: Map<String, Value> = Map::new();
    for (k, v) in &c.env {
        env.insert(k.clone(), v.clone());
    }
    if wants_claude_grant
        && let Some(g) = &refs.grant_ref
    {
        env.insert("PACER_ASSISTANT_GRANT".into(), json!({ "secretRef": g }));
    } else if is_codex {
        env.insert("PACER_ASSISTANT_GRANT".into(), json!({ "secretRef": ASK_GRANT_REF }));
    } else if !is_claude
        && let Some(cr) = &refs.config_ref
    {
        env.insert("OPENCODE_CONFIG_CONTENT".into(), json!({ "secretRef": cr }));
        if is_acp {
            env.insert("PACER_ASSISTANT_GRANT".into(), json!({ "secretRef": ASK_GRANT_REF }));
        }
    }

    let result = host
        .call(
            "capability.process.spawn",
            json!({
                "argv": c.argv,
                "cwd": c.cwd,
                "stdin": c.stdin,
                "timeoutMs": c.timeout_ms,
                "env": env,
            }),
        )
        .await?;
    let code = result.get("code").and_then(Value::as_i64).unwrap_or(0);
    let timed_out = result
        .get("timedOut")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let stdout = if result.get("output").is_some() {
        let handle = result
            .get("output")
            .and_then(|o| o.get("stdout"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned();
        read_all(host, &handle).await?
    } else {
        result
            .get("stdout")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned()
    };
    Ok(RunValue {
        code,
        timed_out,
        stdout,
    })
}

/// A resume that failed before the agent answered: no text, and an error or a
/// non-zero exit (index.ts `resumeFailed`).
fn resume_failed(r: &RunValue, o: &Value) -> bool {
    !r.timed_out
        && o.get("text").and_then(Value::as_str).is_none_or(str::is_empty)
        && (r.code != 0 || o.get("error").is_some())
}

/// Init said the pacer MCP server did not connect (index.ts `mcpConnectFailed`).
fn mcp_connect_failed(o: &Value) -> bool {
    o.get("error")
        .and_then(Value::as_str)
        .is_some_and(|e| contains_ignore_case(e, "pacer MCP server failed to connect"))
}

/// A Claude hook ran (index.ts `sawHook`).
fn saw_hook(o: &Value) -> bool {
    let tool_seen = o
        .get("tools")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .any(|t| t.get("tool").and_then(Value::as_str) == Some("claude:hook"));
    tool_seen
        || o.get("error")
            .and_then(Value::as_str)
            .is_some_and(|e| contains_ignore_case(e, "hook lifecycle event"))
}

fn contains_ignore_case(haystack: &str, needle: &str) -> bool {
    let hay = haystack.to_lowercase();
    hay.contains(&needle.to_lowercase())
}

/// `parseAsk`: route opencode/ACP via `parse_run`, else the claude
/// stream-json parser with the expected init surface (index.ts:371-378).
fn parse_ask(command: &AskCommand, stdout: &str) -> Result<Value, PluginError> {
    if command.argv.first().map(String::as_str) != Some("claude") {
        return parse_run(stdout);
    }
    if let Some(control) = parse_claude_control_run(stdout) {
        return Ok(control);
    }
    let Some(expect) = claude_expect_from_command(command) else {
        return Err(PluginError::new(
            "plugin_refused",
            "The claude ask-mode command was missing its expected init surface.",
        ));
    };
    Ok(parse_claude_run(stdout, Some(&expect)))
}

fn cancelled() -> PluginError {
    PluginError::new("plugin_unavailable", "The turn was cancelled.")
}

/// `assistant.reply`: run the host-issued ask-mode command and return the
/// answer, with a session-broken resume fallback and a digest-only retry
/// (index.ts:380-408).
pub async fn reply(params: Value, ctx: Ctx) -> HandlerResult {
    let Some(executor) = params.get("executor") else {
        return Err(PluginError::new(
            "invalid_input",
            "The executor backend needs a host-issued ask-mode command.",
        ));
    };
    let refs = Refs {
        config_ref: executor
            .get("configRef")
            .and_then(Value::as_str)
            .map(str::to_owned),
        grant_ref: executor
            .get("grantRef")
            .and_then(Value::as_str)
            .map(str::to_owned),
    };
    let Some(command) = executor.get("command").and_then(AskCommand::from_value) else {
        return Err(PluginError::new(
            "invalid_input",
            "The executor backend needs a host-issued ask-mode command.",
        ));
    };
    let session = params
        .get("session")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let fallback = executor
        .get("fallback")
        .and_then(AskCommand::from_value);
    let digest_fallback = executor
        .get("digestFallback")
        .and_then(AskCommand::from_value);

    let mut active = command;
    let mut raw = run(&ctx.host, &refs, &active).await?;
    let mut out = parse_ask(&active, &raw.stdout)?;
    if ctx.cancel.is_cancelled() {
        return Err(cancelled());
    }

    // A stored session can be gone: start a new one seeded with the transcript.
    if session.is_some()
        && let Some(fb) = &fallback
        && resume_failed(&raw, &out)
    {
        active = fb.clone();
        raw = run(&ctx.host, &refs, &active).await?;
        out = parse_ask(&active, &raw.stdout)?;
        if ctx.cancel.is_cancelled() {
            return Err(cancelled());
        }
    }

    // Pacer MCP failed to connect: host-issued digest-only retry.
    if let Some(df) = &digest_fallback
        && mcp_connect_failed(&out)
        && !saw_hook(&out)
    {
        active = df.clone();
        raw = run(&ctx.host, &refs, &active).await?;
        out = parse_ask(&active, &raw.stdout)?;
        if ctx.cancel.is_cancelled() {
            return Err(cancelled());
        }
    }

    if raw.timed_out {
        return Err(PluginError::new(
            "plugin_timeout",
            "The agent did not answer in time.",
        ));
    }

    // Claude CONTROL digest-only: host already answered after mcp_status failed.
    let control_digest_ok = out.get("claudeControl").and_then(Value::as_bool) == Some(true)
        && out.get("toolsHealthy").and_then(Value::as_bool) == Some(false)
        && !out.get("text").and_then(Value::as_str).is_none_or(str::is_empty)
        && !out.get("error").and_then(Value::as_str).is_none_or(str::is_empty)
        && out
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|e| contains_ignore_case(e, "digest only"))
        && !saw_hook(&out);

    // Claude: a missing/wrong init or a hook event fails even with text.
    if active.argv.first().map(String::as_str) == Some("claude")
        && out.get("error").is_some()
        && !control_digest_ok
    {
        return Err(PluginError::new(
            "plugin_refused",
            out.get("error").and_then(Value::as_str).unwrap_or_default(),
        ));
    }

    let text = out.get("text").and_then(Value::as_str).unwrap_or("");
    if text.is_empty() {
        let code = raw.code;
        let message = out
            .get("error")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| format!("The agent exited {code} without an answer."));
        return Err(PluginError::new("plugin_unavailable", message));
    }

    let mut result = Map::new();
    result.insert("message".into(), Value::String(text.to_owned()));
    if let Some(s) = out.get("session").and_then(Value::as_str) {
        result.insert("session".into(), Value::String(s.to_owned()));
    }
    if let Some(tools) = out.get("tools").and_then(Value::as_array) {
        let tools: Vec<Value> = tools.iter().take(64).cloned().collect();
        if !tools.is_empty() {
            result.insert("tools".into(), Value::Array(tools));
        }
    }
    result.insert(
        "usage".into(),
        out.get("usage").cloned().unwrap_or_else(|| {
            json!({ "input": 0, "output": 0, "coverage": "unknown" })
        }),
    );
    Ok(Value::Object(result))
}