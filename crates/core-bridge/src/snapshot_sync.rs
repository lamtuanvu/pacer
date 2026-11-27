#![allow(clippy::result_large_err)]
//! Fixed bridge for snapshot-probe injection parts from the TypeScript owner.
use pacer_foundation::api::{Code, CoreError};
use serde_json::Value;

fn unavailable(message: &str) -> CoreError {
    CoreError::new(Code::Unavailable, message)
}

fn map_body(value: &Value) -> Result<Value, CoreError> {
    if let Some(error) = value.get("error") {
        return Err(crate::config_sync::error(error));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| unavailable("invalid snapshot probe response"))
}

pub async fn http(target: Option<(u16, String)>) -> Result<Value, CoreError> {
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
                "http://127.0.0.1:{port}/_internal/snapshot-probe-parts"
            ))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            // Native status is added by the front door; TS only supplies the other parts.
            .body(Body::from(r#"{"status":false}"#))
            .map_err(|_| unavailable("snapshot probe bridge unavailable"))?;
        let client: Client<HttpConnector, Body> =
            Client::builder(TokioExecutor::new()).build_http();
        let response = client
            .request(request)
            .await
            .map_err(|_| unavailable("snapshot probe bridge unavailable"))?;
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|_| unavailable("snapshot probe bridge unavailable"))?
            .to_bytes();
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| unavailable("invalid snapshot probe response"))?;
        map_body(&value)
    };
    tokio::time::timeout(std::time::Duration::from_secs(120), run)
        .await
        .map_err(|_| unavailable("snapshot probe bridge timed out"))?
}

/// Send the probe request, returning its id. Split from `stdio_reply` so the
/// front door can keep pumping core frames while it awaits the reply.
pub async fn stdio_send<W: tokio::io::AsyncWrite + Unpin>(
    core: &mut W,
    prefix: &str,
    key: &str,
) -> Result<String, CoreError> {
    use tokio::io::AsyncWriteExt;
    let id = format!("{prefix}:{}", hex::encode(rand::random::<[u8; 16]>()));
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "_internal.snapshot-probe.parts",
        "params": {"key": key, "status": false},
    });
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| CoreError::new(Code::Internal, "snapshot probe encoding failed"))?;
    bytes.push(b'\n');
    core.write_all(&bytes)
        .await
        .map_err(|_| unavailable("snapshot probe channel closed"))?;
    core.flush()
        .await
        .map_err(|_| unavailable("snapshot probe channel closed"))?;
    Ok(id)
}

/// Await the reply to a request already sent by `stdio_send`.
pub async fn stdio_reply(
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
    id: String,
) -> Result<Value, CoreError> {
    tokio::time::timeout(std::time::Duration::from_secs(120), receive(replies, &id))
        .await
        .map_err(|_| unavailable("snapshot probe bridge timed out"))?
}

/// Send and await in one step for callers that do not pump core frames.
pub async fn stdio<W: tokio::io::AsyncWrite + Unpin>(
    core: &mut W,
    prefix: &str,
    key: &str,
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Result<Value, CoreError> {
    let id = stdio_send(core, prefix, key).await?;
    stdio_reply(replies, id).await
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
            Err(crate::config_sync::error(error))
        } else {
            value
                .get("result")
                .cloned()
                .ok_or_else(|| unavailable("invalid snapshot probe response"))
        };
    }
    Err(unavailable("snapshot probe channel closed"))
}
