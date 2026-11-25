//! Parsers for one ask-mode CLI run's output: opencode JSONL (`parse_run`) and
//! the host-issued ACP/Codex single JSON object (`parse_acp_run`). Ports of
//! `plugins/assistant-executor/index.ts` `parseAcpRun` and `parseRun`.

use pacer_plugin::js::trim;
use pacer_plugin::PluginError;
use serde_json::{Map, Value, json};

use crate::js_string::js_str_or;

const USAGE: &str = "usage";

/// The default `usage` record when a run carries none.
fn default_usage() -> Value {
    json!({ "input": 0, "output": 0, "coverage": "unknown" })
}

/// `raw.usage ?? {input:0,output:0,coverage:"unknown"}`.
fn usage_or(raw: &Map<String, Value>) -> Value {
    raw
        .get(USAGE)
        .cloned()
        .unwrap_or_else(default_usage)
}

/// Port of `parseAcpRun`: a single JSON object with `acp: true` or `codex: true`.
pub fn parse_acp_run(stdout: &str) -> Option<Value> {
    let raw: Value = serde_json::from_str(trim(stdout)).ok()?;
    let raw = raw.as_object()?;
    if raw.get("acp").and_then(Value::as_bool) != Some(true)
        && raw.get("codex").and_then(Value::as_bool) != Some(true)
    {
        return None;
    }
    // tools is slice(0, 64).
    let tools: Vec<Value> = raw
        .get("tools")
        .and_then(Value::as_array)
        .map(|a| a.iter().take(64).cloned().collect())
        .unwrap_or_default();
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
    out.insert("tools".into(), Value::Array(tools));
    out.insert(USAGE.into(), usage_or(raw));
    Some(Value::Object(out))
}

/// Port of `parseRun`: opencode's JSON lines. A JSON `null` line makes TS
/// throw a TypeError (`event.sessionID` on null); parity compares only the
/// code, so this returns `Err(internal)` there.
pub fn parse_run(stdout: &str) -> Result<Value, PluginError> {
    if let Some(acp) = parse_acp_run(stdout) {
        return Ok(acp);
    }
    let mut text: Vec<String> = Vec::new();
    let mut tools: Vec<Value> = Vec::new();
    let mut session: Option<String> = None;
    let mut error: Option<String> = None;
    let mut input: f64 = 0.0;
    let mut output: f64 = 0.0;
    let mut cache_read: f64 = 0.0;
    let mut cache_write: f64 = 0.0;
    let mut steps: usize = 0;
    let mut measured: usize = 0;
    for line in stdout.split('\n') {
        if trim(line).is_empty() {
            continue;
        }
        let event: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        // A JSON `null` line: `event.sessionID` throws a TypeError in TS.
        if event.is_null() {
            return Err(PluginError::new(
                "internal",
                "assistant executor: JSONL event was null",
            ));
        }
        let Some(event) = event.as_object() else {
            continue;
        };
        if let Some(s) = event.get("sessionID").and_then(Value::as_str) {
            session = Some(s.to_owned());
        }
        let part = event
            .get("part")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let ty = event.get("type").and_then(Value::as_str);
        match ty {
            Some("text") => {
                if let Some(t) = part.get("text").and_then(Value::as_str) {
                    text.push(t.to_owned());
                }
            }
            Some("tool_use") => {
                let tool = js_str_or(part.get("tool"), "");
                let status = js_str_or(part.get("state").and_then(|s| s.get("status")), "");
                tools.push(json!({ "tool": tool, "status": status }));
            }
            Some("step_finish") => {
                steps += 1;
                let t = part.get("tokens").and_then(Value::as_object);
                if let Some(t) = t
                    && let (Some(new_input), Some(new_output)) = (
                        t.get("input").and_then(Value::as_f64),
                        t.get("output").and_then(Value::as_f64),
                    )
                {
                    measured += 1;
                    input += new_input;
                    output += new_output;
                    cache_read += t
                        .get("cache")
                        .and_then(Value::as_object)
                        .and_then(|c| c.get("read"))
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                    cache_write += t
                        .get("cache")
                        .and_then(Value::as_object)
                        .and_then(|c| c.get("write"))
                        .and_then(Value::as_f64)
                        .unwrap_or(0.0);
                }
            }
            Some("error") => {
                let etype = js_str_or(event.get("error").and_then(|e| e.get("type")), "error");
                let message =
                    js_str_or(event.get("error").and_then(|e| e.get("message")), "the agent failed");
                error = Some(format!("{etype}: {message}"));
            }
            _ => {}
        }
    }
    let coverage = if steps == 0 || measured == 0 {
        "unknown"
    } else if measured == steps {
        "measured"
    } else {
        "partial"
    };
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
    usage.insert("coverage".into(), Value::String(coverage.into()));
    out.insert(USAGE.into(), Value::Object(usage));
    Ok(Value::Object(out))
}