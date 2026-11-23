//! `identity` for `pacer-agent-session` (M3 C3), ported one-to-one from
//! `plugins/agent-session/index.ts`. Returns the identity plan the host
//! executes in the workspace/account: an assigned id for claude-code, a
//! `session.get`/`session.create` command for opencode (model in
//! `provider/model` form), nothing for codex.

use crate::capabilities::capabilities;
use pacer_plugin::PluginError;
use serde_json::{Map, Value, json};

fn get_str<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

/// The host executes this plan in the selected workspace/account and persists
/// the result (`index.ts:89-106`). `uuid` supplies a fresh v4 id for
/// claude-code, mirroring `crypto.randomUUID`.
pub fn identity(input: &Value, uuid: &dyn Fn() -> String) -> Result<Value, PluginError> {
    let cap = capabilities(input);
    if !cap
        .get("interactive")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(PluginError::new(
            "not_allowed",
            cap.get("reason")
                .and_then(Value::as_str)
                .unwrap_or_default(),
        ));
    }
    let agent = get_str(input, "agent");
    let sid = get_str(input, "sessionId");
    let sid_set = sid.is_some_and(|s| !s.is_empty());

    if agent == Some("opencode") {
        if sid_set {
            return Ok(json!({
                "kind": "command",
                "argv": ["opencode", "api", "--standalone", "session.get", "--param",
                         format!("sessionID={}", sid.unwrap_or_default())],
                "idPath": ["data", "id"],
            }));
        }
        let mut model: Option<Map<String, Value>> = None;
        if let Some(m) = get_str(input, "model") {
            match m.find('/') {
                Some(s) if s >= 1 && s < m.len() - 1 => {
                    let mut mm = Map::new();
                    mm.insert("providerID".into(), Value::String(m[..s].to_owned()));
                    mm.insert("id".into(), Value::String(m[s + 1..].to_owned()));
                    model = Some(mm);
                }
                _ => {
                    return Err(PluginError::new(
                        "invalid_input",
                        "OpenCode models must use provider/model format.",
                    ));
                }
            }
        }
        let task_id = get_str(input, "taskId").unwrap_or("undefined");
        let mut data = Map::new();
        data.insert("title".into(), Value::String(format!("pacer {task_id}")));
        data.insert("agent".into(), Value::String("build".into()));
        if let Some(model) = model {
            data.insert("model".into(), Value::Object(model));
        }
        let data_str = serde_json::to_string(&Value::Object(data)).unwrap_or_default();
        return Ok(json!({
            "kind": "command",
            "argv": ["opencode", "api", "--standalone", "session.create", "--data", data_str],
            "idPath": ["data", "id"],
        }));
    }

    if sid_set {
        return Ok(json!({ "kind": "assigned", "id": sid.unwrap_or_default() }));
    }
    if agent == Some("claude-code") {
        return Ok(json!({ "kind": "assigned", "id": uuid() }));
    }
    Ok(json!({ "kind": "none" }))
}
