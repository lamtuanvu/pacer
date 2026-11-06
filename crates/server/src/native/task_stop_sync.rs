#![allow(clippy::result_large_err)]
//! Bridge for `taskStop` probe and post-store effects owned by the TypeScript core.
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
        .ok_or_else(|| unavailable("invalid task stop bridge response"))
}

pub(crate) fn task_stop_stays_forwarded(probe: &Value) -> bool {
    probe.get("forward").and_then(Value::as_bool).unwrap_or(true)
}

pub(crate) async fn http_probe(
    target: Option<(u16, String)>,
    id: &str,
) -> Result<Value, CoreError> {
    use axum::body::Body;
    use http_body_util::BodyExt;
    use hyper_util::{
        client::legacy::{Client, connect::HttpConnector},
        rt::TokioExecutor,
    };
    let run = async {
        let (port, token) = target.ok_or_else(|| unavailable("pacer core is restarting"))?;
        let body = json!({"id": id});
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(format!("http://127.0.0.1:{port}/_internal/task-stop-probe"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .map_err(|_| unavailable("task stop probe bridge unavailable"))?;
        let client: Client<HttpConnector, Body> =
            Client::builder(TokioExecutor::new()).build_http();
        let response = client
            .request(request)
            .await
            .map_err(|_| unavailable("task stop probe bridge unavailable"))?;
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|_| unavailable("task stop probe bridge unavailable"))?
            .to_bytes();
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| unavailable("invalid task stop probe response"))?;
        map_body(&value)
    };
    tokio::time::timeout(std::time::Duration::from_secs(120), run)
        .await
        .map_err(|_| unavailable("task stop probe bridge timed out"))?
}

pub(crate) async fn http_effects(
    target: Option<(u16, String)>,
    id: &str,
    before_state: Option<&str>,
) -> Result<Value, CoreError> {
    use axum::body::Body;
    use http_body_util::BodyExt;
    use hyper_util::{
        client::legacy::{Client, connect::HttpConnector},
        rt::TokioExecutor,
    };
    let run = async {
        let (port, token) = target.ok_or_else(|| unavailable("pacer core is restarting"))?;
        let body = json!({"id": id, "beforeState": before_state});
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(format!("http://127.0.0.1:{port}/_internal/task-stop-effects"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .map_err(|_| unavailable("task stop effects bridge unavailable"))?;
        let client: Client<HttpConnector, Body> =
            Client::builder(TokioExecutor::new()).build_http();
        let response = client
            .request(request)
            .await
            .map_err(|_| unavailable("task stop effects bridge unavailable"))?;
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|_| unavailable("task stop effects bridge unavailable"))?
            .to_bytes();
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| unavailable("invalid task stop effects response"))?;
        map_body(&value)
    };
    tokio::time::timeout(std::time::Duration::from_secs(120), run)
        .await
        .map_err(|_| unavailable("task stop effects bridge timed out"))?
}

pub(crate) async fn stdio_probe<W: tokio::io::AsyncWrite + Unpin>(
    core: &mut W,
    prefix: &str,
    key: &str,
    id: &str,
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Result<Value, CoreError> {
    use tokio::io::AsyncWriteExt;
    let req_id = format!("{prefix}:{}", hex::encode(rand::random::<[u8; 16]>()));
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "_internal.task-stop.probe",
        "params": {"key": key, "id": id},
    });
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| CoreError::new(Code::Internal, "task stop probe encoding failed"))?;
    bytes.push(b'\n');
    core.write_all(&bytes)
        .await
        .map_err(|_| unavailable("task stop probe channel closed"))?;
    core.flush()
        .await
        .map_err(|_| unavailable("task stop probe channel closed"))?;
    tokio::time::timeout(
        std::time::Duration::from_secs(120),
        receive(replies, &req_id),
    )
    .await
    .map_err(|_| unavailable("task stop probe bridge timed out"))?
}

pub(crate) async fn stdio_effects<W: tokio::io::AsyncWrite + Unpin>(
    core: &mut W,
    prefix: &str,
    key: &str,
    id: &str,
    before_state: Option<&str>,
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Result<Value, CoreError> {
    use tokio::io::AsyncWriteExt;
    let req_id = format!("{prefix}:{}", hex::encode(rand::random::<[u8; 16]>()));
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "_internal.task-stop.effects",
        "params": {"key": key, "id": id, "beforeState": before_state},
    });
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| CoreError::new(Code::Internal, "task stop effects encoding failed"))?;
    bytes.push(b'\n');
    core.write_all(&bytes)
        .await
        .map_err(|_| unavailable("task stop effects channel closed"))?;
    core.flush()
        .await
        .map_err(|_| unavailable("task stop effects channel closed"))?;
    tokio::time::timeout(
        std::time::Duration::from_secs(120),
        receive(replies, &req_id),
    )
    .await
    .map_err(|_| unavailable("task stop effects bridge timed out"))?
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
                .ok_or_else(|| unavailable("invalid task stop bridge response"))
        };
    }
    Err(unavailable("task stop bridge channel closed"))
}
