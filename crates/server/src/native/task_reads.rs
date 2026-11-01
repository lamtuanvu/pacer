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
    if max.is_some_and(|n| text.encode_utf16().count() > n) {
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
        Some(v) if v.as_f64().is_some_and(|n| n.fract() != 0.0) => Err(invalid(
            "limit: Invalid input: expected int, received number",
        )),
        Some(v) if v.as_f64().is_some_and(|n| n < 1.0) => {
            Err(invalid("limit: Too small: expected number to be >=1"))
        }
        Some(v) if v.as_f64().is_some_and(|n| n > 500.0) => {
            Err(invalid("limit: Too big: expected number to be <=500"))
        }
        Some(v) => Ok(v.as_u64().unwrap_or(50) as usize),
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
    let offset = match value.as_u64() {
        Some(n) if n <= 9_007_199_254_740_991 => n,
        _ if !value.is_number() => {
            return Err(invalid(format!(
                "{name}: Invalid input: expected number, received {}",
                type_name(value)
            )));
        }
        _ if value.as_f64().is_some_and(|n| n.fract() != 0.0) => {
            return Err(invalid(format!(
                "{name}: Invalid input: expected int, received number"
            )));
        }
        _ if value.as_f64().is_some_and(|n| n < 0.0) => {
            return Err(invalid(format!(
                "{name}: Too small: expected number to be >=0"
            )));
        }
        _ => {
            return Err(invalid(format!(
                "{name}: Too big: expected int to be <=9007199254740991"
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
                    .is_some_and(|s| {
                        !s.trim().is_empty() && s.trim().parse::<f64>().is_ok_and(f64::is_finite)
                    })
            });
        Ok(
            json!({"stdout":stdout,"stderr":stderr,"next":{"stdout":stdout_next,"stderr":stderr_next},"done":done,"source":source}),
        )
    })
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::{collections::HashMap, fs};

    fn ctx(dir: &tempfile::TempDir) -> Ctx {
        Ctx::with(dir.path().into(), dir.path().into(), HashMap::new(), 1000.0)
    }

    #[tokio::test]
    async fn activity_pages_by_file_order_and_filters_malformed_rows() {
        let dir = tempfile::tempdir().unwrap();
        fs::create_dir(dir.path().join("state")).unwrap();
        fs::write(dir.path().join("state/activity.jsonl"),
            "{\"id\":\"a\",\"at\":1,\"kind\":\"config\",\"level\":\"info\",\"text\":\"first\",\"repo\":\"r\"}\ninvalid\n{\"id\":\"b\",\"at\":1,\"kind\":\"mode\",\"level\":\"warn\",\"text\":\"second\"}\n{\"id\":\"c\",\"at\":1,\"kind\":\"config\",\"level\":\"info\",\"text\":\"third\",\"repo\":\"r\",\"taskId\":\"t\"}\n").unwrap();
        let c = ctx(&dir);
        let first = activity_list(&c, json!({"limit":2})).await.unwrap();
        assert_eq!(first["entries"][0]["id"], "c");
        assert_eq!(first["entries"][1]["id"], "b");
        assert_eq!(first["next"], "b");
        assert_eq!(
            activity_list(&c, json!({"before":"b"})).await.unwrap()["entries"][0]["id"],
            "a"
        );
        assert_eq!(
            activity_list(&c, json!({"repo":"r","kinds":["config"],"taskId":"t"}))
                .await
                .unwrap()["entries"][0]["id"],
            "c"
        );
        assert!(
            activity_list(&c, json!({"before":"missing"}))
                .await
                .unwrap()["entries"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        assert_eq!(
            activity_list(&c, json!({"limit":501}))
                .await
                .unwrap_err()
                .message,
            "limit: Too big: expected number to be <=500"
        );
        assert_eq!(
            activity_list(&c, json!({"before":"","limit":0}))
                .await
                .unwrap_err()
                .message,
            "before: Too small: expected string to have >=1 characters; limit: Too small: expected number to be >=1"
        );
    }

    #[tokio::test]
    async fn task_log_reads_byte_offsets_caps_and_reports_source() {
        let dir = tempfile::tempdir().unwrap();
        let c = ctx(&dir);
        let id = "t-20261101-184223-ea3b";
        let run = dir.path().join("runs/test");
        fs::create_dir_all(&run).unwrap();
        fs::write(run.join("stdout"), vec![b'x'; 256 * 1024 + 3]).unwrap();
        fs::write(run.join("stderr"), "error").unwrap();
        let mut store = TaskStore::open(dir.path()).unwrap();
        store.insert(&json!({"id":id,"rev":1,"state":"running","createdAt":1000,"brief":{"repo":"/tmp/repo"},"attempts":[],"run":{"dir":run}}), 1000.0).unwrap();
        let first = task_log(&c, json!({"id":id})).await.unwrap();
        assert_eq!(first["stdout"].as_str().unwrap().len(), 256 * 1024);
        assert_eq!(first["next"]["stdout"], 256 * 1024);
        assert_eq!(first["stderr"], "error");
        assert_eq!(first["done"], false);
        let second = task_log(&c, json!({"id":id,"stdout":256 * 1024,"stderr":5}))
            .await
            .unwrap();
        assert_eq!(second["stdout"], "xxx");
        assert_eq!(second["source"], first["source"]);
        fs::write(run.join("exit"), "0\n").unwrap();
        assert_eq!(task_log(&c, json!({"id":id})).await.unwrap()["done"], true);
        assert_eq!(
            task_log(&c, json!({"id":"missing"}))
                .await
                .unwrap_err()
                .code,
            Code::UnknownTask
        );
        assert_eq!(
            task_log(&c, json!({"id":id,"stdout":-1}))
                .await
                .unwrap_err()
                .code,
            Code::InvalidInput
        );
        assert_eq!(
            task_log(&c, json!({"id":"","stdout":-1}))
                .await
                .unwrap_err()
                .message,
            "id: Too small: expected string to have >=1 characters; stdout: Too small: expected number to be >=0"
        );
    }
}
