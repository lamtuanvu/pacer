//! The v3 task-log follow stream. The persisted task store remains shared with the core.
#![allow(clippy::result_large_err)]
use super::{auth::AuthKind, core_child::CoreChild, js_trim::js_trim, native_error, proxy};
use axum::{
    body::{Body, Bytes},
    http::{HeaderValue, StatusCode},
    response::Response,
};
use futures_util::stream;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_store::{StoreError, TaskLogReader};
use serde_json::Value;
use std::{
    collections::VecDeque,
    fs::File,
    io::{self, Read, Seek, SeekFrom},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

#[derive(Default, Clone, Copy)]
struct Offsets {
    stdout: u64,
    stderr: u64,
}
#[derive(Debug)]
enum ReadError {
    Core(CoreError),
    Compatibility,
}
impl From<CoreError> for ReadError {
    fn from(error: CoreError) -> Self {
        Self::Core(error)
    }
}
struct Chunk {
    stdout: String,
    stderr: String,
    done: bool,
}
fn log_frame(stdout: &str, stderr: &str) -> String {
    format!(
        "event: log\ndata: {{\"stdout\":{},\"stderr\":{}}}\n\n",
        serde_json::to_string(stdout).unwrap_or_default(),
        serde_json::to_string(stderr).unwrap_or_default()
    )
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
    ];
    for (prefix, base) in radix {
        if let Some(digits) = text.strip_prefix(prefix) {
            return !digits.is_empty()
                && digits.chars().all(|c| c.is_digit(base))
                && digits
                    .chars()
                    .fold(0.0_f64, |value, digit| {
                        value * f64::from(base) + f64::from(digit.to_digit(base).unwrap_or(0))
                    })
                    .is_finite();
        }
    }
    text.parse::<f64>().is_ok_and(f64::is_finite)
}

fn read_file(path: Option<&Path>, offset: &mut u64) -> io::Result<String> {
    let Some(path) = path else {
        return Ok(String::new());
    };
    let mut file = match File::open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(String::new()),
        Err(error) => return Err(error),
    };
    file.seek(SeekFrom::Start(*offset))?;
    let mut bytes = vec![0; 256 * 1024];
    let len = file.read(&mut bytes)?;
    *offset += len as u64;
    Ok(String::from_utf8_lossy(&bytes[..len]).into_owned())
}

fn read_chunk(store: &TaskLogReader, id: &str, offsets: &mut Offsets) -> Result<Chunk, ReadError> {
    let task = store
        .read(id)
        .map_err(|error| match error {
            StoreError::CompatibilityRequired | StoreError::Sql(_) => ReadError::Compatibility,
            error => ReadError::Core(CoreError::new(Code::Internal, error.to_string())),
        })?
        .ok_or_else(|| CoreError::new(Code::UnknownTask, format!("unknown task {id}")))?;
    // Import validation intentionally does not validate run/attempt log values.
    // Let the TS fallback preserve its truthiness, path errors and short circuits.
    if task
        .get("run")
        .is_some_and(|run| run.get("dir").and_then(Value::as_str).is_none())
        || task.get("attempts").and_then(Value::as_array).is_none()
        || task
            .get("attempts")
            .and_then(Value::as_array)
            .and_then(|a| a.last())
            .and_then(|a| a.get("log"))
            .is_some_and(|log| !log.is_string())
    {
        return Err(ReadError::Compatibility);
    }
    let run = task.get("run").and_then(Value::as_object);
    let run_dir = run.and_then(|run| run.get("dir")).and_then(Value::as_str);
    let out_path = run_dir
        .map(|dir| Path::new(dir).join("stdout"))
        .or_else(|| {
            task.get("attempts")?
                .as_array()?
                .last()?
                .get("log")?
                .as_str()
                .map(Path::new)
                .map(Path::to_path_buf)
        });
    let err_path = run_dir.map(|dir| Path::new(dir).join("stderr"));
    let stdout = read_file(out_path.as_deref(), &mut offsets.stdout)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    let stderr = read_file(err_path.as_deref(), &mut offsets.stderr)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    let terminal = matches!(
        task.get("state").and_then(Value::as_str),
        Some("done" | "partial" | "failed" | "limit" | "stopped" | "needs_input")
    );
    let exited = run_dir.is_some_and(|dir| {
        std::fs::read_to_string(Path::new(dir).join("exit"))
            .ok()
            .map(|text| js_trim(&text).to_owned())
            .is_some_and(|text| finite_js_number(&text))
    });
    Ok(Chunk {
        stdout,
        stderr,
        done: terminal || exited,
    })
}

/// Compatibility reads use the existing operation, including byte offsets. The
/// core performs durable import/migration; Rust never writes or emulates it.
async fn compatible_chunk(
    store: Arc<Mutex<TaskLogReader>>,
    core: &CoreChild,
    id: &str,
    offsets: &mut Offsets,
) -> Result<Chunk, Response> {
    let next = *offsets;
    let id_owned = id.to_owned();
    let result = tokio::task::spawn_blocking(move || {
        let mut next = next;
        let result = store
            .lock()
            .map_err(|error| ReadError::Core(CoreError::new(Code::Internal, error.to_string())))
            .and_then(|store| read_chunk(&store, &id_owned, &mut next));
        (result, next)
    })
    .await;
    match result {
        Ok((Ok(chunk), next)) => {
            *offsets = next;
            return Ok(chunk);
        }
        Ok((Err(ReadError::Core(error)), _)) => return Err(native_error(error)),
        Err(error) => {
            return Err(native_error(CoreError::new(
                Code::Internal,
                error.to_string(),
            )));
        }
        Ok((Err(ReadError::Compatibility), _)) => (),
    }
    let Some(target) = core.target().await else {
        return Err(proxy::unavailable(false));
    };
    let params = serde_json::json!({"id":id,"stdout":offsets.stdout,"stderr":offsets.stderr});
    let request = axum::http::Request::builder()
        .method("POST")
        .uri("/v3/ops/task.log")
        .header("content-type", "application/json")
        .body(Body::from(params.to_string()))
        .map_err(|error| native_error(CoreError::new(Code::Internal, error.to_string())))?;
    let response = proxy::forward(request, target, AuthKind::Bearer).await;
    if !response.status().is_success() {
        return Err(response);
    }
    let invalid = || {
        native_error(CoreError::new(
            Code::Internal,
            "invalid core task.log response",
        ))
    };
    // JSON escaping can expand each of the two bounded 256 KiB byte chunks.
    let bytes = axum::body::to_bytes(response.into_body(), 4 * 1024 * 1024)
        .await
        .map_err(|_| invalid())?;
    let value: Value = serde_json::from_slice(&bytes).map_err(|_| invalid())?;
    let result = &value["result"];
    let chunk = Chunk {
        stdout: result["stdout"].as_str().ok_or_else(invalid)?.into(),
        stderr: result["stderr"].as_str().ok_or_else(invalid)?.into(),
        done: result["done"].as_bool().ok_or_else(invalid)?,
    };
    offsets.stdout = result["next"]["stdout"].as_u64().ok_or_else(invalid)?;
    offsets.stderr = result["next"]["stderr"].as_u64().ok_or_else(invalid)?;
    Ok(chunk)
}

async fn drain(
    store: &Arc<Mutex<TaskLogReader>>,
    core: &CoreChild,
    id: &str,
    offsets: &mut Offsets,
    frames: &mut VecDeque<String>,
    limit: usize,
) -> Result<bool, Response> {
    for _ in 0..limit {
        let chunk = compatible_chunk(store.clone(), core, id, offsets).await?;
        let empty = chunk.stdout.is_empty() && chunk.stderr.is_empty();
        if !empty {
            frames.push_back(log_frame(&chunk.stdout, &chunk.stderr));
        }
        if !chunk.done {
            return Ok(false);
        }
        if empty {
            frames.push_back("event: done\ndata: {}\n\n".into());
            return Ok(true);
        }
    }
    Ok(false)
}

pub async fn follow(ctx: Ctx, id: String, core: Arc<CoreChild>) -> Response {
    let store = match tokio::task::spawn_blocking(move || TaskLogReader::open(&ctx.pacer_home))
        .await
    {
        Ok(Ok(store)) => Arc::new(Mutex::new(store)),
        Ok(Err(error)) => return native_error(CoreError::new(Code::Internal, error.to_string())),
        Err(error) => return native_error(CoreError::new(Code::Internal, error.to_string())),
    };
    let mut offsets = Offsets::default();
    // Resolve errors before committing SSE headers, including TS compatibility errors.
    let first = match compatible_chunk(store.clone(), &core, &id, &mut offsets).await {
        Ok(chunk) => chunk,
        Err(response) => return response,
    };
    let mut frames = VecDeque::from([": connected\n\n".to_owned()]);
    if !first.stdout.is_empty() || !first.stderr.is_empty() {
        frames.push_back(log_frame(&first.stdout, &first.stderr));
    }
    let mut done = first.done && first.stdout.is_empty() && first.stderr.is_empty();
    if done {
        frames.push_back("event: done\ndata: {}\n\n".to_owned());
    } else if first.done {
        done = match drain(&store, &core, &id, &mut offsets, &mut frames, 3).await {
            Ok(done) => done,
            Err(response) => return response,
        };
    }
    let source = stream::unfold(
        (
            store,
            core,
            id,
            offsets,
            frames,
            done,
            tokio::time::Instant::now(),
        ),
        |(store, core, id, mut offsets, mut frames, mut done, mut keepalive)| async move {
            loop {
                if let Some(frame) = frames.pop_front() {
                    return Some((
                        Ok::<Bytes, io::Error>(Bytes::from(frame)),
                        (store, core, id, offsets, frames, done, keepalive),
                    ));
                }
                if done {
                    return None;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
                match drain(&store, &core, &id, &mut offsets, &mut frames, 4).await {
                    Ok(ended) => done = ended,
                    Err(response) => {
                        return Some((
                            Err(io::Error::other(format!(
                                "task log read failed: {}",
                                response.status()
                            ))),
                            (store, core, id, offsets, frames, true, keepalive),
                        ));
                    }
                }
                if !done && keepalive.elapsed() >= Duration::from_secs(15) {
                    frames.push_back(": keepalive\n\n".to_owned());
                    keepalive = tokio::time::Instant::now();
                }
            }
        },
    );
    let mut response = Response::new(Body::from_stream(source));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        "content-type",
        HeaderValue::from_static("text/event-stream"),
    );
    response
        .headers_mut()
        .insert("cache-control", HeaderValue::from_static("no-cache"));
    response
}

#[cfg(test)]
#[path = "log_sse/tests.rs"]
mod tests;
