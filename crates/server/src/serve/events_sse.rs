//! Public `/v2/events` and `/v3/events` SSE from the shared outbox read model.
#![allow(clippy::result_large_err)]
use super::{native_error, native_json};
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
use pacer_read_model::events::{CONNECTED, SseCursor};
use pacer_store::{StoreError, TaskStore};
use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

fn local_zone(ctx: &Ctx) -> chrono_tz::Tz {
    if let Some(name) = ctx.env.get("TZ") {
        if let Ok(zone) = name.parse() {
            return zone;
        }
    }
    std::env::var("TZ")
        .ok()
        .and_then(|name| name.parse().ok())
        .unwrap_or(chrono_tz::UTC)
}

#[cfg(unix)]
fn pid_alive(pid: i64) -> bool {
    if pid <= 0 {
        return false;
    }
    use nix::sys::signal::kill;
    use nix::unistd::Pid;
    match kill(Pid::from_raw(pid as i32), None) {
        Ok(()) => true,
        Err(nix::errno::Errno::EPERM) => true,
        Err(_) => false,
    }
}

#[cfg(not(unix))]
fn pid_alive(_pid: i64) -> bool {
    false
}

fn cursor_error() -> CoreError {
    CoreError::new(
        Code::InvalidInput,
        "since must be a non-negative integer",
    )
}

fn store_error(error: StoreError) -> CoreError {
    match error {
        StoreError::CompatibilityRequired => {
            CoreError::new(Code::Internal, "task store compatibility required")
        }
        other => CoreError::new(Code::Internal, other.to_string()),
    }
}

pub async fn stream(
    ctx: Ctx,
    protocol: u8,
    last_event_id: Option<&str>,
    since: Option<&str>,
    tail_ms: u64,
) -> Response {
    let now_ms = ctx.now * 1000.0;
    let cursor = match SseCursor::new(last_event_id, since, protocol, now_ms) {
        Ok(cursor) => cursor,
        Err(pacer_read_model::Error::Cursor) => {
            return native_json(StatusCode::BAD_REQUEST, cursor_error().body());
        }
        Err(error) => {
            return native_error(CoreError::new(Code::Internal, error.to_string()));
        }
    };
    let store = match tokio::task::spawn_blocking({
        let home = ctx.pacer_home.clone();
        move || TaskStore::open(&home)
    })
    .await
    {
        Ok(Ok(store)) => Arc::new(Mutex::new(store)),
        Ok(Err(error)) => return native_error(store_error(error)),
        Err(error) => return native_error(CoreError::new(Code::Internal, error.to_string())),
    };
    let zone = local_zone(&ctx);
    let tail = Duration::from_millis(tail_ms.max(1));
    let source = stream::unfold(
        (
            ctx,
            store,
            cursor,
            zone,
            Vec::<String>::new(),
            now_ms,
            true,
            tail,
        ),
        move |(ctx, store, mut cursor, zone, mut pending, mut now_ms, mut first, tail)| async move {
            loop {
                if let Some(frame) = pending.pop() {
                    return Some((
                        Ok::<Bytes, std::io::Error>(Bytes::from(frame)),
                        (
                            ctx,
                            store,
                            cursor,
                            zone,
                            pending,
                            now_ms,
                            first,
                            tail,
                        ),
                    ));
                }
                if cursor.is_closed() {
                    return None;
                }
                if first {
                    pending.push(CONNECTED.to_owned());
                    first = false;
                    continue;
                }
                let ctx = ctx.at_now();
                now_ms = ctx.now * 1000.0;
                if let Some(frame) = cursor.heartbeat(now_ms) {
                    pending.push(frame.to_owned());
                    continue;
                }
                let ctx_for_poll = ctx.clone();
                let store_for_poll = store.clone();
                let mut cursor_for_poll = cursor;
                let polled = tokio::task::spawn_blocking(move || {
                    let mut store = store_for_poll.lock().unwrap();
                    cursor_for_poll
                        .poll(&ctx_for_poll, &mut store, zone, &pid_alive)
                        .map(|frames| (cursor_for_poll, frames))
                })
                .await;
                cursor = match polled {
                    Ok(Ok((next, frames))) => {
                        if !frames.is_empty() {
                            pending.push(frames);
                        }
                        next
                    }
                    Ok(Err(_)) | Err(_) => return None,
                };
                if !pending.is_empty() {
                    continue;
                }
                if cursor.is_closed() {
                    return None;
                }
                tokio::time::sleep(tail).await;
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
