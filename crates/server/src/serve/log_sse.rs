//! The v3 task-log follow stream. The persisted task store remains shared with the core.
#![allow(clippy::result_large_err)]
use super::{js_trim::js_trim, native_error};
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
use pacer_store::TaskLogReader;
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

fn read_chunk(store: &TaskLogReader, id: &str, offsets: &mut Offsets) -> Result<Chunk, CoreError> {
    let task = store
        .read(id)
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?
        .ok_or_else(|| CoreError::new(Code::UnknownTask, format!("unknown task {id}")))?;
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

fn poll(
    store: &TaskLogReader,
    id: &str,
    offsets: &mut Offsets,
    frames: &mut VecDeque<String>,
) -> Result<bool, CoreError> {
    poll_limit(store, id, offsets, frames, 4)
}

fn poll_limit(
    store: &TaskLogReader,
    id: &str,
    offsets: &mut Offsets,
    frames: &mut VecDeque<String>,
    limit: usize,
) -> Result<bool, CoreError> {
    for _ in 0..limit {
        let chunk = read_chunk(store, id, offsets)?;
        let empty = chunk.stdout.is_empty() && chunk.stderr.is_empty();
        if !empty {
            frames.push_back(log_frame(&chunk.stdout, &chunk.stderr));
        }
        if !chunk.done {
            return Ok(false);
        }
        if empty {
            frames.push_back("event: done\ndata: {}\n\n".to_owned());
            return Ok(true);
        }
    }
    Ok(false)
}

pub async fn follow(ctx: Ctx, id: String) -> Response {
    let mut offsets = Offsets::default();
    // Resolve missing tasks and file errors before committing SSE headers.
    let initial = match tokio::task::spawn_blocking({
        let ctx = ctx.clone();
        let id = id.clone();
        move || {
            let store = TaskLogReader::open(&ctx.pacer_home)
                .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
            let chunk = read_chunk(&store, &id, &mut offsets)?;
            Ok::<_, CoreError>((chunk, offsets, Arc::new(Mutex::new(store))))
        }
    })
    .await
    {
        Ok(Ok(initial)) => initial,
        Ok(Err(error)) => return native_error(error),
        Err(error) => return native_error(CoreError::new(Code::Internal, error.to_string())),
    };
    let (first, mut offsets, store) = initial;
    let mut frames = VecDeque::from([": connected\n\n".to_owned()]);
    if !first.stdout.is_empty() || !first.stderr.is_empty() {
        frames.push_back(log_frame(&first.stdout, &first.stderr));
    }
    let mut done = first.done && first.stdout.is_empty() && first.stderr.is_empty();
    if done {
        frames.push_back("event: done\ndata: {}\n\n".to_owned());
    } else if first.done {
        done = match tokio::task::spawn_blocking({
            let store = Arc::clone(&store);
            let id = id.clone();
            move || {
                let store = store
                    .lock()
                    .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
                let mut next_offsets = offsets;
                let mut next_frames = VecDeque::new();
                poll_limit(&store, &id, &mut next_offsets, &mut next_frames, 3)
                    .map(|ended| (next_offsets, next_frames, ended))
            }
        })
        .await
        {
            Ok(Ok((next_offsets, next_frames, ended))) => {
                offsets = next_offsets;
                frames.extend(next_frames);
                ended
            }
            Ok(Err(error)) => return native_error(error),
            Err(error) => return native_error(CoreError::new(Code::Internal, error.to_string())),
        };
    }
    let source = stream::unfold(
        (
            store,
            id,
            offsets,
            frames,
            done,
            tokio::time::Instant::now(),
        ),
        |(store, id, mut offsets, mut frames, mut done, mut keepalive)| async move {
            loop {
                if let Some(frame) = frames.pop_front() {
                    return Some((
                        Ok::<Bytes, io::Error>(Bytes::from(frame)),
                        (store, id, offsets, frames, done, keepalive),
                    ));
                }
                if done {
                    return None;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
                let result = tokio::task::spawn_blocking({
                    let reader = Arc::clone(&store);
                    let id = id.clone();
                    move || {
                        let mut output = VecDeque::new();
                        let ended = reader
                            .lock()
                            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))
                            .and_then(|reader| poll(&reader, &id, &mut offsets, &mut output));
                        (offsets, output, ended)
                    }
                })
                .await;
                match result {
                    Ok((next, output, Ok(ended))) => {
                        offsets = next;
                        frames = output;
                        done = ended;
                    }
                    Ok((_, _, Err(error))) => {
                        return Some((
                            Err(io::Error::other(error)),
                            (store, id, offsets, frames, true, keepalive),
                        ));
                    }
                    Err(error) => {
                        return Some((
                            Err(io::Error::other(error)),
                            (store, id, offsets, frames, true, keepalive),
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
