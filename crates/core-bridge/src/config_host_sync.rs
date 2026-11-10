#![allow(clippy::result_large_err)]
//! Fixed bridge for config.get host-field injection from the TypeScript owner.
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
        .ok_or_else(|| unavailable("invalid config host response"))
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
                "http://127.0.0.1:{port}/_internal/config-host-parts"
            ))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from("{}"))
            .map_err(|_| unavailable("config host bridge unavailable"))?;
        let client: Client<HttpConnector, Body> =
            Client::builder(TokioExecutor::new()).build_http();
        let response = client
            .request(request)
            .await
            .map_err(|_| unavailable("config host bridge unavailable"))?;
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|_| unavailable("config host bridge unavailable"))?
            .to_bytes();
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| unavailable("invalid config host response"))?;
        map_body(&value)
    };
    tokio::time::timeout(std::time::Duration::from_secs(120), run)
        .await
        .map_err(|_| unavailable("config host bridge timed out"))?
}

pub async fn stdio<W: tokio::io::AsyncWrite + Unpin>(
    core: &mut W,
    prefix: &str,
    key: &str,
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Result<Value, CoreError> {
    use tokio::io::AsyncWriteExt;
    let id = format!("{prefix}:{}", hex::encode(rand::random::<[u8; 16]>()));
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "_internal.config-host.parts",
        "params": {"key": key},
    });
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| CoreError::new(Code::Internal, "config host encoding failed"))?;
    bytes.push(b'\n');
    core.write_all(&bytes)
        .await
        .map_err(|_| unavailable("config host channel closed"))?;
    core.flush()
        .await
        .map_err(|_| unavailable("config host channel closed"))?;
    tokio::time::timeout(std::time::Duration::from_secs(120), receive(replies, &id))
        .await
        .map_err(|_| unavailable("config host bridge timed out"))?
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
                .ok_or_else(|| unavailable("invalid config host response"))
        };
    }
    Err(unavailable("config host channel closed"))
}
