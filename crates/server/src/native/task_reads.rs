#![allow(clippy::result_large_err)] // NativeOp and CoreError use this public API by value.
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_store::TaskStore;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::File,
    io::{Read, Seek, SeekFrom},
    path::Path,
};

const KINDS: &[&str] = &[
    "policy",
    "plugin_state",
    "task_started",
    "task_settled",
    "verdict",
    "retry",
    "message",
    "mode",
    "budget_refreshed",
    "executor_state",
    "host_state",
    "account_state",
    "config",
    "update",
];
const LEVELS: &[&str] = &["info", "warn", "error"];
const TERMINAL: &[&str] = &[
    "done",
    "partial",
    "failed",
    "limit",
    "stopped",
    "needs_input",
];

fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

fn object(params: &Value) -> Result<&serde_json::Map<String, Value>, CoreError> {
    params.as_object().ok_or_else(|| {
        invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(params)
        ))
    })
}

fn optional_string<'a>(
    params: &'a serde_json::Map<String, Value>,
    name: &str,
    max: Option<usize>,
) -> Result<Option<&'a str>, CoreError> {
    let Some(value) = params.get(name) else {
        return Ok(None);
    };
    let text = value.as_str().ok_or_else(|| {
        invalid(format!(
            "{name}: Invalid input: expected string, received {}",
            type_name(value)
        ))
    })?;
    if text.is_empty() {
        return Err(invalid(format!(
            "{name}: Too small: expected string to have >=1 characters"
        )));
    }
    if max.is_some_and(|n| text.chars().count() > n) {
        return Err(invalid(format!(
            "{name}: Too big: expected string to have <=128 characters"
        )));
    }
    Ok(Some(text))
}

fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn checked<T>(result: Result<T, CoreError>, issues: &mut Vec<String>) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(error) => {
            issues.push(error.message);
            None
        }
    }
}

fn activity_limit(p: &serde_json::Map<String, Value>) -> Result<usize, CoreError> {
    match p.get("limit") {
        None => Ok(50),
        Some(v) if !v.is_number() => Err(invalid(format!(
            "limit: Invalid input: expected number, received {}",
            type_name(v)
        ))),
        Some(v)
            if v.as_f64()
                .is_none_or(|n| !n.is_finite() || n.fract() != 0.0) =>
        {
            Err(invalid(
                "limit: Invalid input: expected int, received number",
            ))
        }
        Some(v) => {
            let n = v.as_f64().unwrap_or(50.0);
            let mut issues = Vec::new();
            if n < -9_007_199_254_740_991.0 {
                issues.push("limit: Too small: expected int to be >=-9007199254740991");
            } else if n > 9_007_199_254_740_991.0 {
                issues.push("limit: Too big: expected int to be <=9007199254740991");
            }
            if n < 1.0 {
                issues.push("limit: Too small: expected number to be >=1");
            } else if n > 500.0 {
                issues.push("limit: Too big: expected number to be <=500");
            }
            if issues.is_empty() {
                Ok(n as usize)
            } else {
                Err(invalid(issues.join("; ")))
            }
        }
    }
}

fn activity_kinds(p: &serde_json::Map<String, Value>) -> Result<Option<&Vec<Value>>, CoreError> {
    match p.get("kinds") {
        None => Ok(None),
        Some(Value::Array(values))
            if values
                .iter()
                .all(|v| v.as_str().is_some_and(|k| KINDS.contains(&k))) =>
        {
            Ok(Some(values))
        }
        Some(Value::Array(values)) => {
            let indexes = values
                .iter()
                .enumerate()
                .filter(|(_, v)| !v.as_str().is_some_and(|k| KINDS.contains(&k)))
                .map(|(i, _)| i);
            let options = KINDS
                .iter()
                .map(|k| format!("\"{k}\""))
                .collect::<Vec<_>>()
                .join("|");
            Err(invalid(
                indexes
                    .map(|index| {
                        format!("kinds.{index}: Invalid option: expected one of {options}")
                    })
                    .collect::<Vec<_>>()
                    .join("; "),
            ))
        }
        Some(other) => Err(invalid(format!(
            "kinds: Invalid input: expected array, received {}",
            type_name(other)
        ))),
    }
}

fn optional_offset(params: &serde_json::Map<String, Value>, name: &str) -> Result<u64, CoreError> {
    let Some(value) = params.get(name) else {
        return Ok(0);
    };
    let offset = match value.as_f64() {
        _ if !value.is_number() => {
            return Err(invalid(format!(
                "{name}: Invalid input: expected number, received {}",
                type_name(value)
            )));
        }
        Some(n) if !n.is_finite() || n.fract() != 0.0 => {
            return Err(invalid(format!(
                "{name}: Invalid input: expected int, received number"
            )));
        }
        Some(n) if n < -9_007_199_254_740_991.0 => {
            return Err(invalid(format!(
                "{name}: Too small: expected int to be >=-9007199254740991; {name}: Too small: expected number to be >=0"
            )));
        }
        Some(n) if n < 0.0 => {
            return Err(invalid(format!(
                "{name}: Too small: expected number to be >=0"
            )));
        }
        Some(n) if n > 9_007_199_254_740_991.0 => {
            return Err(invalid(format!(
                "{name}: Too big: expected int to be <=9007199254740991"
            )));
        }
        Some(n) => n as u64,
        None => {
            return Err(invalid(format!(
                "{name}: Invalid input: expected int, received number"
            )));
        }
    };
    Ok(offset)
}

fn valid_entry(entry: &Value) -> bool {
    entry.get("id").is_some_and(Value::is_string)
        && entry
            .get("at")
            .and_then(Value::as_f64)
            .is_some_and(f64::is_finite)
        && entry
            .get("kind")
            .and_then(Value::as_str)
            .is_some_and(|k| KINDS.contains(&k))
        && entry
            .get("level")
            .and_then(Value::as_str)
            .is_some_and(|l| LEVELS.contains(&l))
        && entry.get("text").is_some_and(Value::is_string)
        && ["repo", "taskId", "executor", "host", "machineId"]
            .iter()
            .all(|key| entry.get(*key).is_none_or(Value::is_string))
}

pub(super) fn activity_list(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let params = if params.is_null() { json!({}) } else { params };
        let p = object(&params)?;
        let mut issues = Vec::new();
        let before = checked(optional_string(p, "before", None), &mut issues).flatten();
        let limit = checked(activity_limit(p), &mut issues).unwrap_or(50);
        let repo = checked(optional_string(p, "repo", None), &mut issues).flatten();
        let kinds = checked(activity_kinds(p), &mut issues).flatten();
        let task_id = checked(optional_string(p, "taskId", Some(128)), &mut issues).flatten();
        if !issues.is_empty() {
            return Err(invalid(issues.join("; ")));
        }
        let file = ctx.pacer_home.join("state/activity.jsonl");
        let raw = match std::fs::read(file) {
            Ok(raw) => String::from_utf8_lossy(&raw).into_owned(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(error) => return Err(CoreError::new(Code::Internal, error.to_string())),
        };
        let all: Vec<Value> = raw
            .lines()
            .filter_map(|line| serde_json::from_str::<Value>(line).ok())
            .filter(valid_entry)
            .rev()
            .collect();
        let start = match before {
            None => 0,
            Some(cursor) => match all.iter().position(|entry| entry["id"] == cursor) {
                Some(index) => index + 1,
                None => return Ok(json!({"entries": [], "next": null})),
            },
        };
        let filtered: Vec<Value> = all
            .into_iter()
            .skip(start)
            .filter(|entry| {
                repo.is_none_or(|v| entry.get("repo").and_then(Value::as_str) == Some(v))
                    && task_id
                        .is_none_or(|v| entry.get("taskId").and_then(Value::as_str) == Some(v))
                    && kinds.is_none_or(|values| values.contains(&entry["kind"]))
            })
            .collect();
        let next = if filtered.len() > limit {
            filtered
                .get(limit - 1)
                .and_then(|entry| entry.get("id"))
                .cloned()
                .unwrap_or(Value::Null)
        } else {
            Value::Null
        };
        Ok(json!({"entries": filtered.into_iter().take(limit).collect::<Vec<_>>(), "next": next}))
    })
}

fn read_from(file: Option<&Path>, offset: u64) -> Result<(String, u64), CoreError> {
    let Some(path) = file else {
        return Ok((String::new(), offset));
    };
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((String::new(), offset));
        }
        Err(error) => return Err(CoreError::new(Code::Internal, error.to_string())),
    };
    // Some filesystems reject seeks to valid JS cursors far beyond EOF. Match
    // the TS reader's empty result and retain the requested cursor in that case.
    let length = file
        .metadata()
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?
        .len();
    if offset >= length {
        return Ok((String::new(), offset));
    }
    file.seek(SeekFrom::Start(offset))
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    let mut bytes = vec![0; 256 * 1024];
    let n = file
        .read(&mut bytes)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    Ok((
        String::from_utf8_lossy(&bytes[..n]).into_owned(),
        offset + n as u64,
    ))
}

fn js_trim(text: &str) -> &str {
    text.trim_matches(|c| {
        matches!(c,
            '\u{0009}'..='\u{000D}' | '\u{0020}' | '\u{00A0}' | '\u{1680}' |
            '\u{2000}'..='\u{200A}' | '\u{2028}' | '\u{2029}' | '\u{202F}' |
            '\u{205F}' | '\u{3000}' | '\u{FEFF}'
        )
    })
}

fn finite_js_number(text: &str) -> bool {
    let text = js_trim(text);
    if text.is_empty() {
        return false;
    }
    let radix = [
        ("0x", 16),
        ("0X", 16),
        ("0b", 2),
        ("0B", 2),
        ("0o", 8),
        ("0O", 8),
    ]
    .into_iter()
    .find_map(|(prefix, radix)| text.strip_prefix(prefix).map(|digits| (digits, radix)));
    if let Some((digits, radix)) = radix {
        if digits.is_empty() {
            return false;
        }
        let mut value = 0.0_f64;
        for digit in digits.chars() {
            let Some(digit) = digit.to_digit(radix) else {
                return false;
            };
            value = value * f64::from(radix) + f64::from(digit);
            if !value.is_finite() {
                return false;
            }
        }
        return true;
    }
    text.parse::<f64>().is_ok_and(f64::is_finite)
}

pub(super) fn task_log(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let params = if params.is_null() { json!({}) } else { params };
        let p = object(&params)?;
        let mut issues = Vec::new();
        let id = checked(optional_string(p, "id", Some(128)), &mut issues).flatten();
        if id.is_none() && !p.contains_key("id") {
            issues.push("id: Invalid input: expected string, received undefined".into());
        }
        let stdout_offset = checked(optional_offset(p, "stdout"), &mut issues).unwrap_or(0);
        let stderr_offset = checked(optional_offset(p, "stderr"), &mut issues).unwrap_or(0);
        if !issues.is_empty() {
            return Err(invalid(issues.join("; ")));
        }
        let Some(id) = id else {
            return Err(invalid(
                "id: Invalid input: expected string, received undefined",
            ));
        };
        let mut store = TaskStore::open(&ctx.pacer_home)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        let task = store
            .read(id)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?
            .ok_or_else(|| CoreError::new(Code::UnknownTask, format!("unknown task {id}")))?;
        let run_dir = task.pointer("/run/dir").and_then(Value::as_str);
        let last_log = task
            .get("attempts")
            .and_then(Value::as_array)
            .and_then(|attempts| attempts.last())
            .and_then(|attempt| attempt.get("log"))
            .and_then(Value::as_str);
        let out_file = run_dir
            .map(|dir| Path::new(dir).join("stdout"))
            .or_else(|| last_log.map(std::path::PathBuf::from));
        let err_file = run_dir.map(|dir| Path::new(dir).join("stderr"));
        let source_input = json!([
            out_file.as_ref().map(|p| p.to_string_lossy().into_owned()),
            err_file.as_ref().map(|p| p.to_string_lossy().into_owned())
        ]);
        let source = format!(
            "{:x}",
            Sha256::digest(serde_json::to_vec(&source_input).unwrap_or_default())
        );
        let (stdout, stdout_next) = read_from(out_file.as_deref(), stdout_offset)?;
        let (stderr, stderr_next) = if err_file.is_some() {
            read_from(err_file.as_deref(), stderr_offset)?
        } else {
            (String::new(), 0)
        };
        let done = task
            .get("state")
            .and_then(Value::as_str)
            .is_some_and(|state| TERMINAL.contains(&state))
            || run_dir.is_some_and(|dir| {
                std::fs::read_to_string(Path::new(dir).join("exit"))
                    .ok()
                    .is_some_and(|s| finite_js_number(&s))
            });
        Ok(
            json!({"stdout":stdout,"stderr":stderr,"next":{"stdout":stdout_next,"stderr":stderr_next},"done":done,"source":source}),
        )
    })
}

#[cfg(test)]
mod tests;
