#![allow(clippy::result_large_err)]
//! TypeScript bridge for ops that stay effectful or probe-heavy in Core.
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
        .ok_or_else(|| unavailable("invalid core bridge response"))
}

fn http_path(op: &str) -> Result<&'static str, CoreError> {
    match op {
        "machine.get" | "machine.set" | "machine.rotate" => Ok("/_internal/machine-bridge"),
        "files.search" => Ok("/_internal/files-search"),
        "setup.check" => Ok("/_internal/setup-check"),
        _ => Err(unavailable("core bridge unavailable")),
    }
}

fn stdio_method(op: &str) -> Result<&'static str, CoreError> {
    match op {
        "machine.get" | "machine.set" | "machine.rotate" => Ok("_internal.machine.bridge"),
        "files.search" => Ok("_internal.files.search"),
        "setup.check" => Ok("_internal.setup.check"),
        _ => Err(unavailable("core bridge unavailable")),
    }
}

pub(crate) fn request_body(op: &str, params: &Value) -> Result<Value, CoreError> {
    match op {
        "machine.get" | "machine.set" | "machine.rotate" => Ok(json!({"op": op, "params": params})),
        "files.search" | "setup.check" => Ok(params.clone()),
        _ => Err(unavailable("core bridge unavailable")),
    }
}

pub(crate) async fn http(
    target: Option<(u16, String)>,
    op: &str,
    params: Value,
) -> Result<Value, CoreError> {
    use axum::body::Body;
    use http_body_util::BodyExt;
    use hyper_util::{
        client::legacy::{Client, connect::HttpConnector},
        rt::TokioExecutor,
    };
    let path = http_path(op)?;
    let body = request_body(op, &params)?;
    let run = async move {
        let (port, token) = target.ok_or_else(|| unavailable("pacer core is restarting"))?;
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(format!("http://127.0.0.1:{port}{path}"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(body.to_string()))
            .map_err(|_| unavailable("core bridge unavailable"))?;
        let client: Client<HttpConnector, Body> =
            Client::builder(TokioExecutor::new()).build_http();
        let response = client
            .request(request)
            .await
            .map_err(|_| unavailable("core bridge unavailable"))?;
        let bytes = response
            .into_body()
            .collect()
            .await
            .map_err(|_| unavailable("core bridge unavailable"))?
            .to_bytes();
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| unavailable("invalid core bridge response"))?;
        map_body(&value)
    };
    tokio::time::timeout(std::time::Duration::from_secs(120), run)
        .await
        .map_err(|_| unavailable("core bridge timed out"))?
}

pub(crate) async fn stdio<W: tokio::io::AsyncWrite + Unpin>(
    core: &mut W,
    prefix: &str,
    key: &str,
    op: &str,
    params: Value,
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Result<Value, CoreError> {
    use tokio::io::AsyncWriteExt;
    let method = stdio_method(op)?;
    let id = format!("{prefix}:{}", hex::encode(rand::random::<[u8; 16]>()));
    let mut bridge_params = request_body(op, &params)?;
    if let Value::Object(map) = &mut bridge_params {
        map.insert("key".into(), key.into());
    }
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": bridge_params,
    });
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| CoreError::new(Code::Internal, "core bridge encoding failed"))?;
    bytes.push(b'\n');
    core.write_all(&bytes)
        .await
        .map_err(|_| unavailable("core bridge channel closed"))?;
    core.flush()
        .await
        .map_err(|_| unavailable("core bridge channel closed"))?;
    tokio::time::timeout(std::time::Duration::from_secs(120), receive(replies, &id))
        .await
        .map_err(|_| unavailable("core bridge timed out"))?
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
                .ok_or_else(|| unavailable("invalid core bridge response"))
        };
    }
    Err(unavailable("core bridge channel closed"))
}
