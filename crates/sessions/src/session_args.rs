//! CLI session grammar. Transport, attachment upload and execution stay in TS.
use crate::targets::js_space;
use serde_json::{Value, json};
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
#[error("{0}")]
pub struct ArgsError(String);
impl From<&str> for ArgsError {
    fn from(message: &str) -> Self {
        Self(message.into())
    }
}
impl From<String> for ArgsError {
    fn from(message: String) -> Self {
        Self(message)
    }
}
pub fn parse_session_args(args: &[String]) -> Result<Value, ArgsError> {
    let command = args.first().map(String::as_str).unwrap_or("");
    if !["start", "end", "resume"].contains(&command) {
        return Err("usage: pacer session start|end|resume".into());
    }
    let mut result = json!({"command":command,"attachments":[],"request":"","json":false});
    let mut i = 1;
    while i < args.len() {
        let arg = &args[i];
        if arg == "--" {
            result["request"] = json!(args[i + 1..].join(" "));
            break;
        }
        if arg == "--json" {
            result["json"] = json!(true);
            i += 1;
            continue;
        }
        if ["--repo", "--executor", "--base", "--checkout", "--attach"].contains(&arg.as_str()) {
            i += 1;
            let value = args
                .get(i)
                .filter(|s| !s.is_empty())
                .ok_or_else(|| format!("{arg} requires a value"))?;
            if arg == "--attach" {
                if let Some(a) = result["attachments"].as_array_mut() {
                    a.push(json!(value));
                }
            } else {
                result[&arg[2..]] = json!(value);
            }
        } else if command != "start"
            && result["id"].as_str().is_none_or(str::is_empty)
            && !arg.starts_with('-')
        {
            result["id"] = json!(arg);
        } else {
            return Err(format!(
                "Unknown session argument: {arg}. Put the initial prompt after --."
            )
            .into());
        }
        i += 1;
    }
    if result.get("base").is_some() && result.get("checkout").is_some() {
        return Err("--base and --checkout are mutually exclusive".into());
    }
    if command == "start"
        && result["request"]
            .as_str()
            .unwrap_or("")
            .trim_matches(js_space)
            .is_empty()
    {
        return Err("Put your request after --".into());
    }
    if command != "start" && result["id"].as_str().is_none_or(str::is_empty) {
        return Err("A session ID is required".into());
    }
    Ok(result)
}
