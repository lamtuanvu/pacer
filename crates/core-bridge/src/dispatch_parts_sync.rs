#![allow(clippy::result_large_err)]
//! Fixed bridge for the dispatch parts only TypeScript computes
//! (`src/api/dispatch-parts-bridge.ts`): `params.kind` is `dispatch.executor-guards` or
//! `dispatch.enforcement-exclusions`; no caller-controlled operation crosses this channel.
//! Replies past [`MAX_REPLY`] are refused, and the enforcement probes Core may run are
//! bounded by a 30 s deadline.
use pacer_foundation::api::{Code, CoreError};
use serde_json::Value;
use std::time::Duration;

/// The largest reply accepted: a few hundred short rows.
pub const MAX_REPLY: usize = 1024 * 1024;
const DEADLINE: Duration = Duration::from_secs(30);

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
        .ok_or_else(|| unavailable("invalid dispatch parts response"))
}

pub async fn http(target: Option<(u16, String)>, params: Value) -> Result<Value, CoreError> {
    use axum::body::Body;
    use http_body_util::{BodyExt, Limited};
    use hyper_util::{
        client::legacy::{Client, connect::HttpConnector},
        rt::TokioExecutor,
    };
    let run = async {
        let (port, token) = target.ok_or_else(|| unavailable("pacer core is restarting"))?;
        let request = axum::http::Request::builder()
            .method("POST")
            .uri(format!("http://127.0.0.1:{port}/_internal/dispatch-parts"))
            .header("authorization", format!("Bearer {token}"))
            .header("content-type", "application/json")
            .body(Body::from(params.to_string()))
            .map_err(|_| unavailable("dispatch parts bridge unavailable"))?;
        let client: Client<HttpConnector, Body> =
            Client::builder(TokioExecutor::new()).build_http();
        let response = client
            .request(request)
            .await
            .map_err(|_| unavailable("dispatch parts bridge unavailable"))?;
        let bytes = Limited::new(response.into_body(), MAX_REPLY)
            .collect()
            .await
            .map_err(|_| unavailable("invalid dispatch parts response"))?
            .to_bytes();
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| unavailable("invalid dispatch parts response"))?;
        map_body(&value)
    };
    tokio::time::timeout(DEADLINE, run)
        .await
        .map_err(|_| unavailable("dispatch parts bridge timed out"))?
}

pub async fn stdio<W: tokio::io::AsyncWrite + Unpin>(
    core: &mut W,
    prefix: &str,
    key: &str,
    params: Value,
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Result<Value, CoreError> {
    use tokio::io::AsyncWriteExt;
    let id = format!("{prefix}:{}", hex::encode(rand::random::<[u8; 16]>()));
    let mut params = match params {
        Value::Object(params) => params,
        _ => serde_json::Map::new(),
    };
    params.insert("key".into(), Value::String(key.into()));
    let request = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "_internal.dispatch.parts",
        "params": params,
    });
    let mut bytes = serde_json::to_vec(&request)
        .map_err(|_| CoreError::new(Code::Internal, "dispatch parts encoding failed"))?;
    bytes.push(b'\n');
    core.write_all(&bytes)
        .await
        .map_err(|_| unavailable("dispatch parts channel closed"))?;
    core.flush()
        .await
        .map_err(|_| unavailable("dispatch parts channel closed"))?;
    tokio::time::timeout(DEADLINE, receive(replies, &id))
        .await
        .map_err(|_| unavailable("dispatch parts bridge timed out"))?
}

async fn receive(
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
    id: &str,
) -> Result<Value, CoreError> {
    while let Some(value) = replies.recv().await {
        if value.get("id").and_then(Value::as_str) != Some(id) {
            continue;
        }
        if serde_json::to_vec(&value).map_or(true, |bytes| bytes.len() > MAX_REPLY) {
            return Err(unavailable("invalid dispatch parts response"));
        }
        return map_body(&value);
    }
    Err(unavailable("dispatch parts channel closed"))
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;

    #[tokio::test]
    async fn stdio_sends_the_key_and_refuses_oversized_replies() {
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        let mut sink = Vec::new();
        let params = json!({"kind": "dispatch.executor-guards", "runners": []});
        let call = stdio(&mut sink, "p", "k", params.clone(), &mut rx);
        let reply = json!({"id": "other", "result": []});
        tx.send(reply).unwrap();
        drop(tx);
        assert_eq!(
            call.await.unwrap_err().message,
            "dispatch parts channel closed"
        );
        let line: Value = serde_json::from_slice(&sink).unwrap();
        assert_eq!(line["method"], "_internal.dispatch.parts");
        assert_eq!(line["params"]["key"], "k");
        assert_eq!(line["params"]["kind"], "dispatch.executor-guards");

        let id = line["id"].as_str().unwrap().to_owned();
        let big = "x".repeat(MAX_REPLY);
        let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
        tx.send(json!({"id": id, "result": big})).unwrap();
        let error = receive(&mut rx, &id).await.unwrap_err();
        assert_eq!(error.message, "invalid dispatch parts response");
        tx.send(json!({"id": id, "error": {"code": "invalid_input", "message": "m"}}))
            .unwrap();
        assert_eq!(
            receive(&mut rx, &id).await.unwrap_err().code,
            Code::InvalidInput
        );
    }

    #[tokio::test]
    async fn http_without_a_core_is_unavailable() {
        let error = http(None, json!({})).await.unwrap_err();
        assert_eq!(error.message, "pacer core is restarting");
    }
}
