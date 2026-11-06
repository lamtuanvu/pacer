#![allow(clippy::result_large_err)]
//! Fixed bridge for host-read injection snapshots from the TypeScript owner.
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
        .ok_or_else(|| unavailable("invalid host read response"))
}

pub(crate) async fn http(
    target: Option<(u16, String)>,
    alias: Option<&str>,
) -> Result<Value, CoreError> {
    use axum::body::Body;
    use http_body_util::BodyExt;
    use hyper_util::{
        client::legacy::{Client, connect::HttpConnector},
        rt::TokioExecutor,
    };
    let run = async {
        let (port, token) = target.ok_or_else(|| unavailable("pacer core is restarting"))?;
        let body = alias
            .map(|a| json!({"alias": a}))
            .unwrap_or_else(|| json!({}));
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(format!("http://127.0.0.1:{port}/_internal/host-read-parts"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .map_err(|_| unavailable("host read bridge unavailable"))?;
        let client: Client<HttpConnector, Body> =
            Client::builder(TokioExecutor::new()).build_http();
        let response = client
            .request(request)
            .await
            .map_err(|_| unavailable("host read bridge unavailable"))?;
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|_| unavailable("host read bridge unavailable"))?
            .to_bytes();
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| unavailable("invalid host read response"))?;
        map_body(&value)
    };
    tokio::time::timeout(std::time::Duration::from_secs(120), run)
        .await
        .map_err(|_| unavailable("host read bridge timed out"))?
}

pub(crate) async fn stdio<W: tokio::io::AsyncWrite + Unpin>(
    core: &mut W,
    prefix: &str,
    key: &str,
    alias: Option<&str>,
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Result<Value, CoreError> {
    use tokio::io::AsyncWriteExt;
    let id = format!("{prefix}:{}", hex::encode(rand::random::<[u8; 16]>()));
    let mut params = json!({"key": key});
    if let Some(alias) = alias {
        params["alias"] = alias.into();
    }
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "_internal.host-read.parts",
        "params": params,
    });
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| CoreError::new(Code::Internal, "host read encoding failed"))?;
    bytes.push(b'\n');
    core.write_all(&bytes)
        .await
        .map_err(|_| unavailable("host read channel closed"))?;
    core.flush()
        .await
        .map_err(|_| unavailable("host read channel closed"))?;
    tokio::time::timeout(std::time::Duration::from_secs(120), receive(replies, &id))
        .await
        .map_err(|_| unavailable("host read bridge timed out"))?
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
                .ok_or_else(|| unavailable("invalid host read response"))
        };
    }
    Err(unavailable("host read channel closed"))
}
