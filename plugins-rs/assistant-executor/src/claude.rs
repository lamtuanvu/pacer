//! Claude Code ask-mode stream-json parsing. Port of the `parseClaudeRun`,
//! `claudeExpectFromCommand`, `claudePluginsAllowed`, `samePath` and the
//! ask-mode environment constants in `plugins/assistant-executor/index.ts`.

use serde_json::{Map, Value, json};

use crate::js_string::{obj_string, to_js_string};
use crate::reply::AskCommand;

/// Mirrors ask-mode constants so this plugin does not import the host module.
const CLAUDE_EMPTY_MCP: &str = "{\"mcpServers\":{}}";
const CLAUDE_ALLOWED_PACER_TOOLS: &str = "mcp__pacer__*";
const CLAUDE_PERMISSION_MODE: &str = "dontAsk";
pub const CLAUDE_EXPECT_TOOLS_ENV: &str = "CLAUDE_CODE_EXPECT_TOOLS";

/// Expected init surface from a host-issued claude ask-mode command.
#[derive(Debug, Clone)]
pub struct ClaudeInitExpect {
    pub permission_mode: String,
    pub cwd: String,
    pub version: String,
    /// Exact `mcp__pacer__*` tool names when MCP tools are on; empty for digest-only.
    pub tools: Vec<String>,
    /// Require `mcp_servers: [{name:pacer,status:connected}]` when true.
    pub pacer_mcp: bool,
}

/// Built-in Claude Code plugins that ask-mode init still lists (path must be `builtin`).
pub const CLAUDE_ASK_BUILTIN_PLUGIN_SOURCES: [&str; 2] =
    ["agents-md@builtin", "telemetry@builtin"];

fn is_hook_event(event: &Map<String, Value>) -> bool {
    let ty = event.get("type").and_then(Value::as_str).unwrap_or("");
    let subtype = event.get("subtype").and_then(Value::as_str).unwrap_or("");
    ty == "hook" || ty.starts_with("hook_") || subtype.starts_with("hook")
}

/// Resolve a path lexically against the current directory (node's `resolve`),
/// keeping absolute paths as-is and normalizing `.` and `..` components.
fn resolve(p: &str) -> std::path::PathBuf {
    let abs = if std::path::Path::new(p).is_absolute() {
        std::path::PathBuf::from(p)
    } else {
        std::env::current_dir()
            .map(|c| c.join(p))
            .unwrap_or_else(|_| std::path::PathBuf::from(p))
    };
    let mut out = std::path::PathBuf::new();
    for comp in abs.components() {
        match comp {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    out
}

/// Compare paths the way Claude's init cwd may realpath them (e.g. /var →
/// /private/var on macOS).
pub fn same_path(a: &str, b: &str) -> bool {
    if a == b || resolve(a) == resolve(b) {
        return true;
    }
    match (std::fs::canonicalize(a), std::fs::canonicalize(b)) {
        (Ok(pa), Ok(pb)) => pa == pb,
        _ => false,
    }
}

fn plugin_name(plugin: &Map<String, Value>) -> String {
    obj_string(plugin, "name", "plugin")
}

/// True when every listed plugin is an allowlisted builtin (`source` + `path: "builtin"`).
pub fn claude_plugins_allowed(plugins: &[Value]) -> bool {
    plugins.iter().all(|plugin| {
        let Some(p) = plugin.as_object() else {
            return false;
        };
        let source = p.get("source").and_then(Value::as_str);
        let path = p.get("path").and_then(Value::as_str);
        CLAUDE_ASK_BUILTIN_PLUGIN_SOURCES.contains(&source.unwrap_or("")) && path == Some("builtin")
    })
}

fn same_tool_set(listed: &[Value], expected: &[String]) -> bool {
    if listed.len() != expected.len() {
        return false;
    }
    listed.iter().all(|name| {
        let name = name.as_str().unwrap_or("");
        expected.iter().any(|e| e == name)
    })
}

fn pacer_connected(mcp: Option<&[Value]>) -> bool {
    let Some(mcp) = mcp else {
        return false;
    };
    if mcp.len() != 1 {
        return false;
    }
    let Some(server) = mcp.first().and_then(Value::as_object) else {
        return false;
    };
    server.get("name").and_then(Value::as_str) == Some("pacer")
        && server.get("status").and_then(Value::as_str) == Some("connected")
}

fn pacer_failed(mcp: Option<&[Value]>) -> bool {
    match mcp {
        None => true,
        Some(mcp) => {
            let pacer = mcp
                .iter()
                .find(|s| s.get("name").and_then(Value::as_str) == Some("pacer"))
                .and_then(Value::as_object);
            match pacer {
                None => true,
                Some(s) => s.get("status").and_then(Value::as_str) != Some("connected"),
            }
        }
    }
}

/// Port of `parseClaudeRun`: read Claude Code's `--output-format stream-json`.
pub fn parse_claude_run(stdout: &str, expect: Option<&ClaudeInitExpect>) -> Value {
    let mut text: Vec<String> = Vec::new();
    let mut tools: Vec<Value> = Vec::new();
    let mut by_id: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    let mut session: Option<String> = None;
    let mut error: Option<String> = None;
    let mut input: f64 = 0.0;
    let mut output: f64 = 0.0;
    let mut cache_read: f64 = 0.0;
    let mut cache_write: f64 = 0.0;
    let mut measured = false;
    let mut saw_init = false;
    for line in stdout.split('\n') {
        if line.trim().is_empty() {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let Some(event) = event.as_object() else {
            continue;
        };
        if let Some(s) = event.get("session_id").and_then(Value::as_str) {
            session = Some(s.to_owned());
        }
        if is_hook_event(event) {
            error = Some("a Claude hook lifecycle event ran".into());
            tools.push(json!({ "tool": "claude:hook", "status": "present" }));
            continue;
        }
        if event.get("type").and_then(Value::as_str) == Some("system")
            && event.get("subtype").and_then(Value::as_str) == Some("init")
        {
            saw_init = true;
            let listed: Option<Vec<Value>> = event
                .get("tools")
                .and_then(Value::as_array)
                .cloned();
            let mcp: Option<Vec<Value>> = event
                .get("mcp_servers")
                .and_then(Value::as_array)
                .cloned();
            let plugins: Option<Vec<Value>> = event
                .get("plugins")
                .and_then(Value::as_array)
                .cloned();
            let slash: Option<Vec<Value>> = event
                .get("slash_commands")
                .and_then(Value::as_array)
                .cloned();
            let skills: Option<&Vec<Value>> = event.get("skills").and_then(Value::as_array);
            // event.agents is intentionally unread.
            let mode = event.get("permissionMode").and_then(Value::as_str).unwrap_or("");
            let cwd = event.get("cwd").and_then(Value::as_str).unwrap_or("");
            let version = event
                .get("claude_code_version")
                .and_then(Value::as_str)
                .unwrap_or("");
            let plugins_ok = plugins
                .as_deref()
                .is_some_and(claude_plugins_allowed);
            let slash_ok = slash
                .as_deref()
                .is_some_and(|s| s.is_empty());
            let skills_ok = skills.is_none_or(|s| s.is_empty());
            let matches = expect.is_none_or(|e| {
                mode == e.permission_mode
                    && same_path(cwd, &e.cwd)
                    && version == e.version
            });
            let want_pacer = expect.map_or(false, |e| e.pacer_mcp);
            let want_tools: Vec<String> = expect.map(|e| e.tools.clone()).unwrap_or_default();
            let surface_ok = if want_pacer {
                listed
                    .as_deref()
                    .is_some_and(|l| same_tool_set(l, &want_tools))
                    && pacer_connected(mcp.as_deref())
                    && plugins_ok
                    && slash_ok
                    && skills_ok
            } else {
                listed
                    .as_deref()
                    .is_some_and(|l| l.is_empty())
                    && mcp.as_deref().is_some_and(|m| m.is_empty())
                    && plugins_ok
                    && slash_ok
                    && skills_ok
            };
            if surface_ok && matches {
                tools.push(json!({
                    "tool": "claude:init",
                    "status": if want_pacer { "pacer" } else { "empty" }
                }));
            } else {
                if let Some(listed) = &listed {
                    for name in listed {
                        tools.push(json!({ "tool": to_js_string(name), "status": "available" }));
                    }
                }
                if let Some(mcp) = &mcp {
                    for server in mcp {
                        let name = obj_string_obj(server, "name", "mcp");
                        let status = obj_string_obj(server, "status", "available");
                        tools.push(json!({ "tool": name, "status": status }));
                    }
                }
                if let Some(plugins) = &plugins {
                    for plugin in plugins {
                        tools.push(json!({
                            "tool": plugin_name(plugin.as_object().expect("plugin object")),
                            "status": "available"
                        }));
                    }
                }
                if let Some(slash) = &slash {
                    for name in slash {
                        tools.push(json!({ "tool": to_js_string(name), "status": "available" }));
                    }
                }
                if want_pacer && pacer_failed(mcp.as_deref()) {
                    if error.is_none() {
                        error = Some("claude pacer MCP server failed to connect".into());
                    }
                } else if !surface_ok {
                    if error.is_none() {
                        error = Some(if want_pacer {
                            "claude init did not expose exactly the pacer MCP tools".into()
                        } else {
                            "claude init surface was not empty".into()
                        });
                    }
                } else if !matches && error.is_none() {
                    error = Some("claude init did not match the issued ask-mode turn".into());
                }
            }
            continue;
        }
        if event.get("type").and_then(Value::as_str) == Some("assistant") {
            let message = event.get("message").and_then(Value::as_object);
            if let Some(message) = message
                && let Some(content) = message.get("content").and_then(Value::as_array)
            {
                for block in content {
                    let Some(b) = block.as_object() else {
                        continue;
                    };
                    let btype = b.get("type").and_then(Value::as_str);
                    match btype {
                        Some("text") => {
                            if let Some(t) = b.get("text").and_then(Value::as_str) {
                                text.push(t.to_owned());
                            }
                        }
                        Some("tool_use") => {
                            let name = obj_string(b, "name", "");
                            let idx = tools.len();
                            tools.push(json!({ "tool": name, "status": "completed" }));
                            if let Some(id) = b.get("id").and_then(Value::as_str)
                                && !id.is_empty()
                            {
                                by_id.insert(id.to_owned(), idx);
                            }
                        }
                        _ => {}
                    }
                }
            }
        } else if event.get("type").and_then(Value::as_str) == Some("user") {
            let message = event.get("message").and_then(Value::as_object);
            if let Some(message) = message
                && let Some(content) = message.get("content").and_then(Value::as_array)
            {
                for block in content {
                    let Some(b) = block.as_object() else {
                        continue;
                    };
                    if b.get("type").and_then(Value::as_str) != Some("tool_result")
                        || b.get("is_error").and_then(Value::as_bool) != Some(true)
                    {
                        continue;
                    }
                    if let Some(id) = b.get("tool_use_id").and_then(Value::as_str)
                        && let Some(&idx) = by_id.get(id)
                    {
                        let tool = tools
                            .get(idx)
                            .and_then(Value::as_object)
                            .and_then(|t| t.get("tool"))
                            .cloned()
                            .unwrap_or_default();
                        tools[idx] = json!({ "tool": tool, "status": "error" });
                    }
                }
            }
        } else if event.get("type").and_then(Value::as_str) == Some("result") {
            if event.get("is_error").and_then(Value::as_bool) == Some(true) {
                error = Some(
                    event
                        .get("result")
                        .and_then(Value::as_str)
                        .map_or("the agent failed".into(), ToOwned::to_owned),
                );
            } else if let Some(r) = event.get("result").and_then(Value::as_str)
                && !r.is_empty()
                && text.is_empty()
            {
                text.push(r.to_owned());
            }
            if let Some(usage) = event.get("usage").and_then(Value::as_object)
                && let (Some(new_input), Some(new_output)) = (
                    usage.get("input_tokens").and_then(Value::as_f64),
                    usage.get("output_tokens").and_then(Value::as_f64),
                )
            {
                measured = true;
                input = new_input;
                output = new_output;
                cache_read = usage
                    .get("cache_read_input_tokens")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
                cache_write = usage
                    .get("cache_creation_input_tokens")
                    .and_then(Value::as_f64)
                    .unwrap_or(0.0);
            }
        }
    }
    if expect.is_some() && !saw_init && error.is_none() {
        error = Some("claude stream-json init event was missing".into());
    }
    let mut out = Map::new();
    out.insert("text".into(), Value::String(text.concat()));
    if let Some(s) = session {
        out.insert("session".into(), Value::String(s));
    }
    if let Some(e) = error {
        out.insert("error".into(), Value::String(e));
    }
    out.insert("tools".into(), Value::Array(tools));
    let mut usage = Map::new();
    usage.insert("input".into(), json!(input));
    usage.insert("output".into(), json!(output));
    if cache_read != 0.0 {
        usage.insert("cacheRead".into(), json!(cache_read));
    }
    if cache_write != 0.0 {
        usage.insert("cacheWrite".into(), json!(cache_write));
    }
    usage.insert(
        "coverage".into(),
        Value::String(if measured { "measured" } else { "unknown" }.into()),
    );
    out.insert("usage".into(), Value::Object(usage));
    Value::Object(out)
}

/// `String(server.name ?? "mcp")` / `String(server.status ?? "available")` for an
/// MCP server record (which may be a non-object value).
fn obj_string_obj(v: &Value, key: &str, fallback: &str) -> String {
    match v.as_object() {
        Some(map) => obj_string(map, key, fallback),
        None => fallback.to_owned(),
    }
}

fn argv_flag(argv: &[String], name: &str) -> Option<String> {
    if let Some(eq) = argv.iter().find(|a| a.starts_with(&format!("{name}="))) {
        return Some(eq[name.len() + 1..].to_owned());
    }
    let at = argv.iter().position(|a| a == name)?;
    argv.get(at + 1).cloned()
}

/// Read one host Claude CONTROL turn result (single JSON object with
/// `claudeControl: true`); port of `parseClaudeControlRun` (index.ts:53-75).
pub fn parse_claude_control_run(stdout: &str) -> Option<Value> {
    let raw: Value = serde_json::from_str(stdout).ok()?;
    let raw = raw.as_object()?;
    if raw.get("claudeControl").and_then(Value::as_bool) != Some(true) {
        return None;
    }
    let mut out = Map::new();
    out.insert(
        "text".into(),
        raw
            .get("text")
            .and_then(Value::as_str)
            .map(|s| Value::String(s.to_owned()))
            .unwrap_or_else(|| Value::String(String::new())),
    );
    if let Some(s) = raw.get("session").and_then(Value::as_str) {
        out.insert("session".into(), Value::String(s.to_owned()));
    }
    if let Some(e) = raw.get("error").and_then(Value::as_str) {
        out.insert("error".into(), Value::String(e.to_owned()));
    }
    let tools: Vec<Value> = raw
        .get("tools")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .map(|t| {
                    json!({
                        "tool": obj_string_obj(t, "tool", ""),
                        "status": obj_string_obj(t, "status", "")
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    out.insert("tools".into(), Value::Array(tools));
    out.insert(
        "usage".into(),
        raw.get("usage")
            .cloned()
            .unwrap_or_else(|| json!({ "input": 0, "output": 0, "coverage": "unknown" })),
    );
    out.insert(
        "toolsHealthy".into(),
        Value::Bool(raw.get("toolsHealthy").and_then(Value::as_bool).unwrap_or(false)),
    );
    out.insert("claudeControl".into(), Value::Bool(true));
    Some(Value::Object(out))
}

/// Expected init surface from a host-issued claude ask-mode command.
pub fn claude_expect_from_command(c: &AskCommand) -> Option<ClaudeInitExpect> {
    if c.argv.first().map(String::as_str) != Some("claude") {
        return None;
    }
    let permission_mode = argv_flag(&c.argv, "--permission-mode");
    let version = c
        .env
        .get("CLAUDE_CODE_EXPECT_VERSION")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match (permission_mode, version) {
        (Some(permission_mode), Some(version)) => {
            let mcp_json = argv_flag(&c.argv, "--mcp-config");
            let allowed = argv_flag(&c.argv, "--allowedTools");
            let expect_tools: Vec<String> = c
                .env
                .get(CLAUDE_EXPECT_TOOLS_ENV)
                .and_then(Value::as_str)
                .map(|v| {
                    v.split(',')
                        .map(|s| s.trim().to_owned())
                        .filter(|s| !s.is_empty())
                        .collect()
                })
                .unwrap_or_default();
            let pacer_mcp = mcp_json
                .as_deref()
                .is_some_and(|m| m != CLAUDE_EMPTY_MCP)
                && allowed.as_deref() == Some(CLAUDE_ALLOWED_PACER_TOOLS)
                && !expect_tools.is_empty();
            Some(ClaudeInitExpect {
                permission_mode: if permission_mode.is_empty() {
                    CLAUDE_PERMISSION_MODE.into()
                } else {
                    permission_mode
                },
                cwd: c.cwd.clone(),
                version,
                pacer_mcp,
                tools: if pacer_mcp { expect_tools } else { Vec::new() },
            })
        }
        _ => None,
    }
}