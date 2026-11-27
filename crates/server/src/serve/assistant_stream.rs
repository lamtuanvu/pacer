//! The ephemeral `GET /v3/assistant/turns/<id>/stream` answer stream.
//!
//! Mirrors `src/assistant/stream.ts`: SSE `data:` frames of `{delta}`,
//! `{status}` and `{done}`, replayed from the start for a late subscriber and
//! closed as soon as the turn emits `done`. Nothing here is persisted: answer
//! text only lives in the turn's in-memory frame list and the outbox carries
//! the turn's state without it.

use axum::{
    body::Body,
    http::{HeaderValue, Response, StatusCode},
};
use futures_util::stream::{Stream, unfold};
use pacer_assistant_ops::assistant_ops::live;
use serde_json::{Value, json};
use std::collections::VecDeque;

fn frame(value: Value) -> Vec<u8> {
    format!(
        "data: {}\n\n",
        serde_json::to_string(&value).unwrap_or_else(|_| "{}".into())
    )
    .into_bytes()
}

/// Build the stream response for one turn. An unknown or already-forgotten turn
/// gets a terminal error frame rather than a hanging connection.
pub fn stream(turn_id: &str) -> Response<Body> {
    let mut initial = VecDeque::from([frame(json!({"status":"connected"}))]);
    let receiver = match live::subscribe(turn_id) {
        Some(receiver) => Some(receiver),
        None => {
            initial.push_back(frame(json!({"done":{"state":"error","error":"That answer is no longer streaming. Open the conversation to read it."}})));
            None
        }
    };
    let closed = receiver.is_none();
    let body = unfold(
        (initial, receiver, closed),
        |(mut queue, mut receiver, mut closed)| async move {
            loop {
                if let Some(item) = queue.pop_front() {
                    return Some((Ok::<Vec<u8>, std::convert::Infallible>(item), (queue, receiver, closed)));
                }
                if closed {
                    return None;
                }
                match receiver.as_mut().and_then(|rx| rx.try_recv().ok()) {
                    Some(value) => {
                        queue.push_back(frame(value.clone()));
                        closed = value.get("done").is_some();
                    }
                    None => match receiver.as_mut() {
                        Some(rx) => match rx.recv().await {
                            Some(value) => {
                                queue.push_back(frame(value.clone()));
                                closed = value.get("done").is_some();
                            }
                            None => return None,
                        },
                        None => return None,
                    },
                }
            }
        },
    );
    response(body)
}

fn response<S>(body: S) -> Response<Body>
where
    S: Stream<Item = Result<Vec<u8>, std::convert::Infallible>> + Send + 'static,
{
    let mut response = Response::new(Body::from_stream(body));
    *response.status_mut() = StatusCode::OK;
    response.headers_mut().insert(
        axum::http::header::CONTENT_TYPE,
        HeaderValue::from_static("text/event-stream"),
    );
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        HeaderValue::from_static("no-cache"),
    );
    response
}
