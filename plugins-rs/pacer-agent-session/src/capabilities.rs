//! Capability and delegation-controller logic for `pacer-agent-session`
//! (M3 C3), ported one-to-one from `plugins/agent-session/index.ts`.
//!
//! `delegation_control` describes a candidate native control path without
//! certifying it; `capabilities` inspects actual option tokens (never
//! substrings such as `--model-provider`) and decides whether interactive
//! sessions are supported for the given `--help` output.

use serde_json::{Value, json};

/// ECMAScript `\s` (WhiteSpace + LineTerminator, the same set the SDK's
/// `js::trim` uses). `help` strings come from CLI `--help` output, so a
/// Non-BMP codepoint can never be a token boundary here.
fn is_ws(c: char) -> bool {
    matches!(
        c,
        '\u{0009}'
            | '\u{000a}'
            | '\u{000b}'
            | '\u{000c}'
            | '\u{000d}'
            | '\u{0020}'
            | '\u{00a0}'
            | '\u{1680}'
            | '\u{2000}'
            ..='\u{200a}'
                | '\u{2028}'
                | '\u{2029}'
                | '\u{202f}'
                | '\u{205f}'
                | '\u{3000}'
                | '\u{feff}'
    )
}

/// `(?:^|[\s,])option(?=[\s,=<]|$)` — the option must be a whole token,
/// so `--model` does not match `--model-provider`. JS `\s` is the set above.
pub(crate) fn has_option(help: &str, option: &str) -> bool {
    if option.is_empty() || option.len() > help.len() {
        return false;
    }
    let hay = help.as_bytes();
    let needle = option.as_bytes();
    for i in 0..=hay.len() - needle.len() {
        if &hay[i..i + needle.len()] != needle {
            continue;
        }
        let pre_ok = i == 0
            || match help[..i].chars().next_back() {
                Some(prev) => prev == ',' || is_ws(prev),
                None => unreachable!("i>0 implies a prior char"),
            };
        if !pre_ok {
            continue;
        }
        let after = i + needle.len();
        let post_ok = after == hay.len()
            || match help[after..].chars().next() {
                Some(next) => matches!(next, ',' | '=' | '<') || is_ws(next),
                None => unreachable!("after<hay.len() implies a following char"),
            };
        if post_ok {
            return true;
        }
    }
    false
}

/// The option lists `capabilities` requires per agent
/// (`index.ts:25-29` `required`).
const REQUIRED: &[(&str, &[&str])] = &[
    (
        "codex",
        &[
            "--config",
            "--cd",
            "--sandbox",
            "--add-dir",
            "--model",
            "--image",
            "--dangerously-bypass-hook-trust",
        ],
    ),
    (
        "claude-code",
        &[
            "--session-id",
            "--resume",
            "--add-dir",
            "--model",
            "--settings",
        ],
    ),
    ("opencode", &["--standalone", "--session", "--prompt"]),
];

/// A candidate native control path; the host must probe it before
/// certification (`index.ts:8-19`).
pub fn delegation_control(input: &Value) -> Value {
    match input.get("agent").and_then(Value::as_str) {
        Some("claude-code") => json!({"mechanism":"hook","entryPoints":["Agent","Task"]}),
        Some("codex") => json!({"mechanism":"hook","entryPoints":["spawn_agent"]}),
        Some("cursor") => json!({"mechanism":"hook","entryPoints":["subagentStart"]}),
        Some("opencode") => {
            let maj_two = input
                .get("version")
                .and_then(Value::as_str)
                .is_some_and(|v| v.starts_with("2."));
            if maj_two {
                json!({"mechanism":"permission","entryPoints":["subagent"],"permissionAction":"subagent"})
            } else {
                json!({"mechanism":"permission","entryPoints":["task"],"permissionAction":"task"})
            }
        }
        agent => json!({"mechanism":"unsupported","entryPoints":[],"reason":format!(
            "No native subagent control adapter for {}",
            agent.unwrap_or("undefined")
        )}),
    }
}

/// Inspect actual option tokens, not substrings such as `--model-provider`
/// (`index.ts:31-47`). The reason strings are copied verbatim.
pub fn capabilities(input: &Value) -> Value {
    let agent = input.get("agent").and_then(Value::as_str);
    let help = input.get("help").and_then(Value::as_str);
    let resume_help = input.get("resumeHelp").and_then(Value::as_str);
    let api_help = input.get("apiHelp").and_then(Value::as_str);
    let agent_name = agent.unwrap_or("undefined");

    let mut reason: Option<String> = None;
    let (known, required_opts) = match REQUIRED.iter().find(|(a, _)| Some(*a) == agent) {
        Some((_, opts)) => (true, *opts),
        None => (false, &[][..]),
    };
    if !known {
        reason = Some(format!(
            "Interactive sessions are not implemented for {agent_name}."
        ));
    } else if let Some(help) = help {
        let missing: Vec<&str> = required_opts
            .iter()
            .copied()
            .filter(|o| !has_option(help, o))
            .collect();
        if !missing.is_empty() {
            reason = Some(format!(
                "{agent_name} is missing interactive CLI options: {}. Update this CLI or choose another executor.",
                missing.join(", ")
            ));
        } else if agent == Some("codex")
            && let Some(resume_help) = resume_help
        {
            let missing_resume: Vec<&str> = ["--cd", "--sandbox", "--add-dir", "--model"]
                .iter()
                .copied()
                .filter(|o| !has_option(resume_help, o))
                .collect();
            if !missing_resume.is_empty() {
                reason = Some(format!(
                    "codex resume is missing CLI options: {}.",
                    missing_resume.join(", ")
                ));
            }
        } else if agent == Some("opencode")
            && let Some(api_help) = api_help
            && !has_option(api_help, "--standalone")
        {
            reason = Some(
                "OpenCode needs a standalone API command to create and recover native sessions. Update this CLI."
                    .into(),
            );
        }
    }

    let supported = reason.is_none();
    let mut result = json!({
        "interactive": supported,
        "resume": supported,
        "launchImages": supported && agent == Some("codex"),
        "liveImages": false,
        "files": supported,
    });
    if let Some(r) = reason {
        result["reason"] = Value::String(r);
    }
    result
}
