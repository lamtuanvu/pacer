#![allow(clippy::result_large_err)] // NativeOp and CoreError use this public API by value.
use pacer_config::strategy::{StrategyError, load_strategy};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_store::{StoreError, TaskStore};
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

pub fn activity_list(ctx: &Ctx, params: Value) -> OpFuture<'_> {
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
    if let Err(error) = file.seek(SeekFrom::Start(offset)) {
        // Some filesystems reject seeks beyond their maximum file size.
        // A regular file already shorter than the offset has no bytes there.
        if error.kind() == std::io::ErrorKind::InvalidInput
            && file
                .metadata()
                .is_ok_and(|m| m.is_file() && offset >= m.len())
        {
            return Ok((String::new(), offset));
        }
        return Err(CoreError::new(Code::Internal, error.to_string()));
    }
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

pub fn task_log(ctx: &Ctx, params: Value) -> OpFuture<'_> {
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

fn optional_bool(
    params: &serde_json::Map<String, Value>,
    name: &str,
) -> Result<Option<bool>, CoreError> {
    match params.get(name) {
        None => Ok(None),
        Some(Value::Bool(value)) => Ok(Some(*value)),
        Some(other) => Err(invalid(format!(
            "{name}: Invalid input: expected boolean, received {}",
            type_name(other)
        ))),
    }
}

fn retention_days(ctx: &Ctx) -> Result<i64, CoreError> {
    match load_strategy(&ctx.pacer_home) {
        Ok(strategy) => Ok(strategy
            .get("taskRetentionDays")
            .and_then(Value::as_i64)
            .or_else(|| {
                strategy
                    .get("taskRetentionDays")
                    .and_then(Value::as_f64)
                    .map(|n| n as i64)
            })
            .unwrap_or(14)),
        Err(StrategyError::Missing(_)) => Ok(14),
        Err(error) => Err(CoreError::new(Code::InvalidInput, error.to_string())),
    }
}

fn store_error(error: StoreError) -> CoreError {
    match error {
        StoreError::UnknownTask(id) => {
            CoreError::new(Code::UnknownTask, format!("unknown task {id}"))
        }
        StoreError::Admission(message) if message == "task retention is already running" => {
            CoreError::new(Code::Conflict, message)
                .hint("wait for the active archive or restore operation")
        }
        StoreError::Conflict | StoreError::Admission(_) => {
            CoreError::new(Code::Conflict, error.to_string())
        }
        StoreError::InvalidRecord => {
            CoreError::new(Code::InvalidInput, "retention days must be non-negative")
        }
        other => CoreError::new(Code::Internal, other.to_string()),
    }
}

fn clip_goal(goal: &str) -> String {
    pacer_read_model::js::clip(goal, 200)
}

fn clip_title(title: &str) -> String {
    let points: Vec<char> = title.chars().collect();
    if points.len() <= 60 {
        return title.into();
    }
    let prefix: String = points[..59].iter().collect();
    let cut = prefix.rfind(' ').filter(|i| *i > 0).unwrap_or(prefix.len());
    let trimmed = prefix[..cut].trim_end_matches(|c: char| c.is_whitespace());
    format!("{}…", if trimmed.is_empty() { "Task" } else { trimmed })
}

fn visible_state(task: &Value) -> Value {
    let state = task.get("state").cloned().unwrap_or(Value::Null);
    if state.as_str() == Some("running")
        && task
            .get("question")
            .is_some_and(|q| q.is_object() && q.get("answer").is_none())
    {
        json!("needs_input")
    } else {
        state
    }
}

pub fn summarize_api_task(task: &Value) -> Value {
    let goal = task
        .pointer("/brief/goal")
        .and_then(Value::as_str)
        .unwrap_or("");
    let title = match task
        .get("title")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        Some(_) => clip_title(&pacer_read_model::tasks::full_title(task)),
        None => clip_title(&pacer_read_model::tasks::goal_title(goal, true)),
    };
    let mut out = json!({
        "task_id": task.get("id").cloned().unwrap_or(Value::Null),
        "title": title,
        "goal": clip_goal(goal),
        "state": visible_state(task),
        "kind": task.get("kind").cloned().unwrap_or(Value::Null),
        "requested_executor": task.get("requestedExecutor").cloned().unwrap_or(Value::Null),
        "placement": task.get("placement").cloned().unwrap_or(Value::Null),
        "queue": task.get("queue").cloned().unwrap_or(Value::Null),
        "attempts": task.get("attempts").and_then(Value::as_array).map(|attempts| {
            attempts.iter().map(|a| json!({
                "executor": a.get("executor").cloned().unwrap_or(Value::Null),
                "exit_code": a.get("exitCode").cloned().unwrap_or(Value::Null),
                "limit_hit": a.get("limitHit").cloned().unwrap_or(Value::Null),
                "timed_out": a.get("timedOut").cloned().unwrap_or(Value::Null),
                "log": a.get("log").cloned().unwrap_or(Value::Null),
            })).collect::<Vec<_>>()
        }).unwrap_or_default(),
        "result": task.get("result").cloned().unwrap_or(Value::Null),
        "review": task.get("review").cloned().unwrap_or(Value::Null),
        "resolved": task.get("resolved").cloned().unwrap_or(Value::Null),
    });
    if task.get("archived").and_then(Value::as_bool) == Some(true) {
        out["archived"] = json!(true);
        if let Some(path) = task.get("archivePath") {
            out["archive_path"] = path.clone();
        }
    }
    for (src, dest) in [
        ("executorFallback", "executor_fallback"),
        ("stopPending", "stop_pending"),
        ("question", "question"),
        ("reviewRequest", "reviewRequest"),
    ] {
        if let Some(value) = task.get(src)
            && !value.is_null()
        {
            out[dest] = value.clone();
        }
    }
    out
}

fn prune_result_json(result: pacer_store::PruneResult) -> Value {
    json!({
        "dryRun": result.dry_run,
        "bytesSaved": result.bytes_saved,
        "workingSetBytes": result.working_set_bytes,
        "tasks": result.tasks.into_iter().map(|task| json!({
            "id": task.id,
            "archivePath": task.archive_path,
            "files": task.files,
            "bytes": task.bytes,
            "bytesSaved": task.bytes_saved,
        })).collect::<Vec<_>>(),
    })
}

pub fn task_prune(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let params = if params.is_null() { json!({}) } else { params };
        let p = object(&params)?;
        let mut issues = Vec::new();
        let dry_run = checked(optional_bool(p, "dry_run"), &mut issues).flatten();
        if !issues.is_empty() {
            return Err(invalid(issues.join("; ")));
        }
        let days = retention_days(ctx)?;
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(store_error)?;
        let result = store
            .prune(days, dry_run.unwrap_or(false), ctx.now)
            .map_err(store_error)?;
        Ok(prune_result_json(result))
    })
}

pub fn task_restore(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let params = if params.is_null() { json!({}) } else { params };
        let p = object(&params)?;
        let mut issues = Vec::new();
        let id = checked(optional_string(p, "id", Some(128)), &mut issues).flatten();
        if id.is_none() && !p.contains_key("id") {
            issues.push("id: Invalid input: expected string, received undefined".into());
        }
        if !issues.is_empty() {
            return Err(invalid(issues.join("; ")));
        }
        let Some(id) = id else {
            return Err(invalid(
                "id: Invalid input: expected string, received undefined",
            ));
        };
        let mut store = TaskStore::open(&ctx.pacer_home).map_err(store_error)?;
        let task = store.restore(id, ctx.now).map_err(store_error)?;
        Ok(summarize_api_task(&task))
    })
}

#[cfg(test)]
mod tests;
