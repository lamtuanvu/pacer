#![allow(clippy::result_large_err)]
//! Bridge for `taskReview` probe and post-store effects owned by the TypeScript core.
use pacer_foundation::api::{Code, CoreError};
use serde_json::{Value, json};

fn unavailable(message: &str) -> CoreError {
    CoreError::new(Code::Unavailable, message)
}

fn map_body(value: &Value) -> Result<Value, CoreError> {
    if let Some(error) = value.get("error") {
        return Err(crate::native::config_sync::error(error));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| unavailable("invalid task review bridge response"))
}

pub(crate) fn task_review_stays_forwarded(probe: &Value) -> bool {
    probe
        .get("forward")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

pub(crate) async fn http_probe(
    target: Option<(u16, String)>,
    params: &Value,
) -> Result<Value, CoreError> {
    use axum::body::Body;
    use http_body_util::BodyExt;
    use hyper_util::{
        client::legacy::{Client, connect::HttpConnector},
        rt::TokioExecutor,
    };
    let run = async {
        let (port, token) = target.ok_or_else(|| unavailable("pacer core is restarting"))?;
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(format!(
                "http://127.0.0.1:{port}/_internal/task-review-probe"
            ))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(params.to_string()))
            .map_err(|_| unavailable("task review probe bridge unavailable"))?;
        let client: Client<HttpConnector, Body> =
            Client::builder(TokioExecutor::new()).build_http();
        let response = client
            .request(request)
            .await
            .map_err(|_| unavailable("task review probe bridge unavailable"))?;
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|_| unavailable("task review probe bridge unavailable"))?
            .to_bytes();
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| unavailable("invalid task review probe response"))?;
        map_body(&value)
    };
    tokio::time::timeout(std::time::Duration::from_secs(120), run)
        .await
        .map_err(|_| unavailable("task review probe bridge timed out"))?
}

pub(crate) async fn http_effects(
    target: Option<(u16, String)>,
    id: &str,
    verdict: &str,
    kind: Option<&str>,
    note: Option<&str>,
) -> Result<Value, CoreError> {
    use axum::body::Body;
    use http_body_util::BodyExt;
    use hyper_util::{
        client::legacy::{Client, connect::HttpConnector},
        rt::TokioExecutor,
    };
    let run = async {
        let (port, token) = target.ok_or_else(|| unavailable("pacer core is restarting"))?;
        let body = json!({
            "id": id,
            "verdict": verdict,
            "kind": kind,
            "note": note,
        });
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(format!(
                "http://127.0.0.1:{port}/_internal/task-review-effects"
            ))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .map_err(|_| unavailable("task review effects bridge unavailable"))?;
        let client: Client<HttpConnector, Body> =
            Client::builder(TokioExecutor::new()).build_http();
        let response = client
            .request(request)
            .await
            .map_err(|_| unavailable("task review effects bridge unavailable"))?;
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|_| unavailable("task review effects bridge unavailable"))?
            .to_bytes();
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| unavailable("invalid task review effects response"))?;
        map_body(&value)
    };
    tokio::time::timeout(std::time::Duration::from_secs(120), run)
        .await
        .map_err(|_| unavailable("task review effects bridge timed out"))?
}

pub(crate) async fn stdio_probe<W: tokio::io::AsyncWrite + Unpin>(
    core: &mut W,
    prefix: &str,
    key: &str,
    params: &Value,
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Result<Value, CoreError> {
    use tokio::io::AsyncWriteExt;
    let req_id = format!("{prefix}:{}", hex::encode(rand::random::<[u8; 16]>()));
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "_internal.task-review.probe",
        "params": {"key": key, "params": params},
    });
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| CoreError::new(Code::Internal, "task review probe encoding failed"))?;
    bytes.push(b'\n');
    core.write_all(&bytes)
        .await
        .map_err(|_| unavailable("task review probe channel closed"))?;
    core.flush()
        .await
        .map_err(|_| unavailable("task review probe channel closed"))?;
    tokio::time::timeout(
        std::time::Duration::from_secs(120),
        receive(replies, &req_id),
    )
    .await
    .map_err(|_| unavailable("task review probe bridge timed out"))?
}

#[allow(clippy::too_many_arguments)]
pub(crate) async fn stdio_effects<W: tokio::io::AsyncWrite + Unpin>(
    core: &mut W,
    prefix: &str,
    key: &str,
    id: &str,
    verdict: &str,
    kind: Option<&str>,
    note: Option<&str>,
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Result<Value, CoreError> {
    use tokio::io::AsyncWriteExt;
    let req_id = format!("{prefix}:{}", hex::encode(rand::random::<[u8; 16]>()));
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "_internal.task-review.effects",
        "params": {"key": key, "id": id, "verdict": verdict, "kind": kind, "note": note},
    });
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| CoreError::new(Code::Internal, "task review effects encoding failed"))?;
    bytes.push(b'\n');
    core.write_all(&bytes)
        .await
        .map_err(|_| unavailable("task review effects channel closed"))?;
    core.flush()
        .await
        .map_err(|_| unavailable("task review effects channel closed"))?;
    tokio::time::timeout(
        std::time::Duration::from_secs(120),
        receive(replies, &req_id),
    )
    .await
    .map_err(|_| unavailable("task review effects bridge timed out"))?
}

async fn receive(
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
    id: &str,
) -> Result<Value, CoreError> {
    while let Some(value) = replies.recv().await {
        if value.get("id").and_then(Value::as_str) != Some(id) {
            continue;
        }
        return if let Some(error) = value.get("error") {
            Err(crate::native::config_sync::error(error))
        } else {
            value
                .get("result")
                .cloned()
                .ok_or_else(|| unavailable("invalid task review bridge response"))
        };
    }
    Err(unavailable("task review bridge channel closed"))
}
