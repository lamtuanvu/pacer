//! `attachment` and `prepare` for `pacer-agent-session` (M3 C3), ported
//! one-to-one from `plugins/agent-session/index.ts`. Builds the native
//! subagent argv for codex, claude-code and opencode, keeping Capability's
//! exported functions byte-identical in behavior to the TypeScript
//! reference (RUST-7).

use crate::capabilities::{capabilities, has_option};
use crate::opencode_report::opencode_reporting_source;
use pacer_plugin::PluginError;
use serde_json::{Value, json};

fn get_str<'a>(input: &'a Value, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

fn set_str(input: &Value, key: &str) -> bool {
    get_str(input, key).is_some_and(|s| !s.is_empty())
}

/// How a file is delivered at `phase` (`index.ts:49-56`). `JSON.stringify`
/// becomes `serde_json::to_string` so the reference text matches byte for byte.
pub fn attachment(input: &Value) -> Value {
    let cap = capabilities(input);
    if !cap
        .get("interactive")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return json!({
            "kind": "unsupported",
            "reason": cap.get("reason").and_then(Value::as_str).unwrap_or_default(),
        });
    }
    let phase = get_str(input, "phase");
    let agent = get_str(input, "agent");
    let attachment = input.get("attachment");
    let mime = attachment.and_then(|a| get_str(a, "mime"));
    if phase == Some("launch")
        && agent == Some("codex")
        && mime.is_some_and(|m| m.starts_with("image/"))
    {
        let path = attachment.and_then(|a| a.get("path"));
        return json!({ "kind": "native", "args": ["-i", path] });
    }
    let name = attachment.and_then(|a| a.get("name"));
    let path = attachment.and_then(|a| a.get("path"));
    json!({
        "kind": "reference",
        "text": format!(
            "Use the attached file {} at {}.",
            serde_json::to_string(&name).unwrap_or_else(|_| "null".into()),
            serde_json::to_string(&path).unwrap_or_else(|_| "null".into())
        ),
        "requiresUserSubmit": true,
    })
}

/// Produce the native launch plan (`index.ts:58-86`). `[...new Set([...])]`
/// keeps first-occurrence order; the codex `--no-daemon` gate reads the
/// advertised help, not a version number.
pub fn prepare(input: &Value) -> Result<Value, PluginError> {
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
    let sid = get_str(input, "sessionId");
    let sid_set = set_str(input, "sessionId");
    let nsid = get_str(input, "newSessionId");
    let nsid_set = set_str(input, "newSessionId");
    if sid_set && nsid_set {
        return Err(PluginError::new(
            "invalid_input",
            "Choose a fresh identity or a resume identity, not both.",
        ));
    }
    let agent = get_str(input, "agent");

    let mut references: Vec<String> = Vec::new();
    let mut images: Vec<Value> = Vec::new();
    if !sid_set && let Some(attachments) = input.get("attachments").and_then(Value::as_array) {
        for file in attachments {
            let mut sub = input.clone();
            sub["attachment"] = file.clone();
            sub["phase"] = Value::String("launch".into());
            let delivery = attachment(&sub);
            match delivery.get("kind").and_then(Value::as_str) {
                Some("native") => {
                    if let Some(args) = delivery.get("args").and_then(Value::as_array) {
                        images.extend(args.iter().cloned());
                    }
                }
                Some("reference") => {
                    if let Some(text) = delivery.get("text").and_then(Value::as_str) {
                        references.push(text.to_owned());
                    }
                }
                _ => {
                    let reason = delivery
                        .get("reason")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    return Err(PluginError::new("not_allowed", reason));
                }
            }
        }
    }

    let mut prompt = get_str(input, "request").unwrap_or_default().to_owned();
    for r in &references {
        prompt.push_str("\n\n");
        prompt.push_str(r);
    }

    let run_dir = get_str(input, "runDir").unwrap_or_default();
    let attachment_dir = get_str(input, "attachmentDir");
    let mut dirs: Vec<Value> = Vec::new();
    let mut deduped: Vec<String> = Vec::new();
    let mut add_dir = |p: &str| {
        if !deduped.iter().any(|existing| existing == p) {
            deduped.push(p.to_owned());
            dirs.push(Value::String("--add-dir".into()));
            dirs.push(Value::String(p.to_owned()));
        }
    };
    add_dir(run_dir);
    if let Some(ad) = attachment_dir {
        add_dir(ad);
    }

    let mut argv: Vec<Value> = Vec::new();
    match agent {
        Some("codex") => {
            let help = if sid_set {
                get_str(input, "resumeHelp").or(get_str(input, "help"))
            } else {
                get_str(input, "help")
            };
            argv.push(Value::String("codex".into()));
            if sid_set {
                argv.push(Value::String("resume".into()));
            }
            if help.is_none_or(|h| has_option(h, "--no-daemon")) {
                argv.push(Value::String("--no-daemon".into()));
            }
            argv.push(Value::String("-C".into()));
            argv.push(Value::String(
                get_str(input, "workspace").unwrap_or_default().to_owned(),
            ));
            argv.push(Value::String("-s".into()));
            argv.push(Value::String("workspace-write".into()));
            argv.extend(dirs);
            if let Some(m) = get_str(input, "model") {
                argv.push(Value::String("-m".into()));
                argv.push(Value::String(m.to_owned()));
            }
            argv.extend(images);
            argv.push(Value::String("--".into()));
            argv.push(Value::String(sid.map(str::to_owned).unwrap_or(prompt)));
        }
        Some("claude-code") => {
            argv.push(Value::String("claude".into()));
            argv.extend(dirs);
            if let Some(m) = get_str(input, "model") {
                argv.push(Value::String("--model".into()));
                argv.push(Value::String(m.to_owned()));
            }
            if sid_set {
                argv.push(Value::String("--resume".into()));
                argv.push(Value::String(sid.unwrap_or_default().to_owned()));
            } else {
                if nsid_set {
                    argv.push(Value::String("--session-id".into()));
                    argv.push(Value::String(nsid.unwrap_or_default().to_owned()));
                }
                argv.push(Value::String("--".into()));
                argv.push(Value::String(prompt));
            }
        }
        _ => {
            let id = if sid_set { sid } else { nsid };
            argv.push(Value::String("opencode".into()));
            argv.push(Value::String("--standalone".into()));
            if let Some(id) = id
                && !id.is_empty()
            {
                argv.push(Value::String("--session".into()));
                argv.push(Value::String(id.to_owned()));
            }
            if !sid_set {
                argv.push(Value::String("--prompt".into()));
                argv.push(Value::String(prompt));
            }
        }
    }

    let native_id = if sid_set { sid } else { nsid };
    let mut result = json!({
        "argv": argv,
        "cwd": get_str(input, "workspace").unwrap_or_default(),
    });
    if agent == Some("opencode")
        && let Some(nid) = native_id
        && !nid.is_empty()
    {
        result["reporting"] = json!({
            "source": opencode_reporting_source(nid, run_dir),
            "configEnv": "OPENCODE_CONFIG_CONTENT",
            "configKey": "plugins",
        });
    }
    Ok(result)
}
