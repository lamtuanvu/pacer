#![allow(clippy::result_large_err)]
//! Bridge for `autoCleanTask` side effects owned by the TypeScript core.
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
        .ok_or_else(|| unavailable("invalid task clean response"))
}

pub(crate) async fn http(
    target: Option<(u16, String)>,
    ids: &[String],
) -> Result<Value, CoreError> {
    use axum::body::Body;
    use http_body_util::BodyExt;
    use hyper_util::{
        client::legacy::{Client, connect::HttpConnector},
        rt::TokioExecutor,
    };
    let run = async {
        let (port, token) = target.ok_or_else(|| unavailable("pacer core is restarting"))?;
        let body = json!({"ids": ids});
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(format!("http://127.0.0.1:{port}/_internal/task-auto-clean"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .map_err(|_| unavailable("task clean bridge unavailable"))?;
        let client: Client<HttpConnector, Body> =
            Client::builder(TokioExecutor::new()).build_http();
        let response = client
            .request(request)
            .await
            .map_err(|_| unavailable("task clean bridge unavailable"))?;
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|_| unavailable("task clean bridge unavailable"))?
            .to_bytes();
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| unavailable("invalid task clean response"))?;
        map_body(&value)
    };
    tokio::time::timeout(std::time::Duration::from_secs(120), run)
        .await
        .map_err(|_| unavailable("task clean bridge timed out"))?
}

pub(crate) async fn stdio<W: tokio::io::AsyncWrite + Unpin>(
    core: &mut W,
    prefix: &str,
    key: &str,
    ids: &[String],
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Result<Value, CoreError> {
    use tokio::io::AsyncWriteExt;
    let req_id = format!("{prefix}:{}", hex::encode(rand::random::<[u8; 16]>()));
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": req_id,
        "method": "_internal.task-auto-clean",
        "params": {"key": key, "ids": ids},
    });
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| CoreError::new(Code::Internal, "task clean encoding failed"))?;
    bytes.push(b'\n');
    core.write_all(&bytes)
        .await
        .map_err(|_| unavailable("task clean channel closed"))?;
    core.flush()
        .await
        .map_err(|_| unavailable("task clean channel closed"))?;
    tokio::time::timeout(
        std::time::Duration::from_secs(120),
        receive(replies, &req_id),
    )
    .await
    .map_err(|_| unavailable("task clean bridge timed out"))?
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
                .ok_or_else(|| unavailable("invalid task clean response"))
        };
    }
    Err(unavailable("task clean channel closed"))
}
