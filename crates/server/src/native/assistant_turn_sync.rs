#![allow(clippy::result_large_err)]
//! Core bridge for native `assistant.ask` and `assistant.cancel`: the turn runs in the TypeScript
//! process (`src/api/assistant-turn-bridge.ts`). Only those two operations cross this channel.
use pacer_assistant_ops::assistant_ops::turn::TurnBridge;
pub(crate) use pacer_assistant_ops::assistant_ops::turn::{
    call, needs_turn_bridge as needs_bridge,
};
use pacer_foundation::api::{Code, CoreError, OpFuture};
use serde_json::{Value, json};
use std::time::Duration;

/// The largest reply accepted; a turn reply is two ids or one flag.
const MAX_REPLY: usize = 1024 * 1024;
/// Admission reads the cached status before a turn starts. A repeat with the same `requestId` is safe.
const DEADLINE: Duration = Duration::from_secs(120);

fn unavailable(message: &str) -> CoreError {
    CoreError::new(Code::Unavailable, message)
}

fn map_reply(value: &Value) -> Result<Value, CoreError> {
    if let Some(error) = value.get("error") {
        return Err(crate::native::core_bridge_sync::error(error));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| unavailable("invalid assistant turn bridge response"))
}

pub(crate) struct HttpBridge {
    pub(crate) target: Option<(u16, String)>,
}

impl HttpBridge {
    async fn post(&self, request: Value) -> Result<Value, CoreError> {
        use axum::body::Body;
        use http_body_util::{BodyExt, Limited};
        use hyper_util::{
            client::legacy::{Client, connect::HttpConnector},
            rt::TokioExecutor,
        };
        let run = async {
            let (port, token) = self
                .target
                .clone()
                .ok_or_else(|| unavailable("pacer core is restarting"))?;
            let request = axum::http::Request::builder()
                .method("POST")
                .uri(format!("http://127.0.0.1:{port}/_internal/assistant-turn"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(json!({"request": request}).to_string()))
                .map_err(|_| unavailable("assistant turn bridge unavailable"))?;
            let client: Client<HttpConnector, Body> =
                Client::builder(TokioExecutor::new()).build_http();
            let response = client
                .request(request)
                .await
                .map_err(|_| unavailable("assistant turn bridge unavailable"))?;
            let bytes = Limited::new(response.into_body(), MAX_REPLY)
                .collect()
                .await
                .map_err(|_| unavailable("invalid assistant turn bridge response"))?
                .to_bytes();
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| unavailable("invalid assistant turn bridge response"))?;
            map_reply(&value)
        };
        tokio::time::timeout(DEADLINE, run)
            .await
            .map_err(|_| unavailable("assistant turn bridge timed out"))?
    }
}

impl TurnBridge for HttpBridge {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(self.post(request))
    }
}

pub(crate) struct StdioBridge<'a, W> {
    pub(crate) core: &'a mut W,
    pub(crate) prefix: &'a str,
    pub(crate) key: &'a str,
    pub(crate) replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> StdioBridge<'_, W> {
    async fn send(&mut self, request: Value) -> Result<Value, CoreError> {
        use tokio::io::AsyncWriteExt;
        let id = format!(
            "{}:{}",
            self.prefix,
            hex::encode(rand::random::<[u8; 16]>())
        );
        let line = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": "_internal.assistant.turn",
            "params": {"key": self.key, "request": request},
        });
        let mut bytes = serde_json::to_vec(&line)
            .map_err(|_| CoreError::new(Code::Internal, "assistant turn bridge encoding failed"))?;
        bytes.push(b'\n');
        self.core
            .write_all(&bytes)
            .await
            .map_err(|_| unavailable("assistant turn bridge channel closed"))?;
        self.core
            .flush()
            .await
            .map_err(|_| unavailable("assistant turn bridge channel closed"))?;
        let receive = async {
            while let Some(value) = self.replies.recv().await {
                if value.get("id").and_then(Value::as_str) == Some(id.as_str()) {
                    return map_reply(&value);
                }
            }
            Err(unavailable("assistant turn bridge channel closed"))
        };
        tokio::time::timeout(DEADLINE, receive)
            .await
            .map_err(|_| unavailable("assistant turn bridge timed out"))?
    }
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> TurnBridge for StdioBridge<'_, W> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(self.send(request))
    }
}
