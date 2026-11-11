#![allow(clippy::result_large_err)]
//! Core bridge for native `task.send`: the live-worker check, the locked lease claim and the
//! delivery into the worker stay in the TypeScript core (`src/api/task-send-bridge.ts`).
use crate::native::task_send_ops::Bridge;
use pacer_foundation::api::{Code, CoreError, OpFuture};
use serde_json::{Value, json};

fn unavailable(message: &str) -> CoreError {
    CoreError::new(Code::Unavailable, message)
}

fn map_reply(value: &Value) -> Result<Value, CoreError> {
    if let Some(error) = value.get("error") {
        return Err(crate::native::config_sync::error(error));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| unavailable("invalid task send bridge response"))
}

pub(crate) struct HttpBridge {
    pub(crate) target: Option<(u16, String)>,
}

impl HttpBridge {
    async fn post(&self, request: Value) -> Result<Value, CoreError> {
        use axum::body::Body;
        use http_body_util::BodyExt;
        use hyper_util::{
            client::legacy::{Client, connect::HttpConnector},
            rt::TokioExecutor,
        };
        let run = async {
            let (port, token) = self
                .target
                .clone()
                .ok_or_else(|| unavailable("pacer core is restarting"))?;
            let body = json!({"request": request});
            let request = axum::http::Request::builder()
                .method("POST")
                .uri(format!("http://127.0.0.1:{port}/_internal/task-send"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(body.to_string()))
                .map_err(|_| unavailable("task send bridge unavailable"))?;
            let client: Client<HttpConnector, Body> =
                Client::builder(TokioExecutor::new()).build_http();
            let response = client
                .request(request)
                .await
                .map_err(|_| unavailable("task send bridge unavailable"))?;
            let bytes = response
                .into_body()
                .collect()
                .await
                .map_err(|_| unavailable("task send bridge unavailable"))?
                .to_bytes();
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| unavailable("invalid task send bridge response"))?;
            map_reply(&value)
        };
        tokio::time::timeout(std::time::Duration::from_secs(120), run)
            .await
            .map_err(|_| unavailable("task send bridge timed out"))?
    }
}

impl Bridge for HttpBridge {
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
        let req_id = format!(
            "{}:{}",
            self.prefix,
            hex::encode(rand::random::<[u8; 16]>())
        );
        let line = json!({
            "jsonrpc": "2.0",
            "id": req_id,
            "method": "_internal.task-send",
            "params": {"key": self.key, "request": request},
        });
        let mut bytes = serde_json::to_vec(&line)
            .map_err(|_| CoreError::new(Code::Internal, "task send bridge encoding failed"))?;
        bytes.push(b'\n');
        self.core
            .write_all(&bytes)
            .await
            .map_err(|_| unavailable("task send bridge channel closed"))?;
        self.core
            .flush()
            .await
            .map_err(|_| unavailable("task send bridge channel closed"))?;
        let receive = async {
            while let Some(value) = self.replies.recv().await {
                if value.get("id").and_then(Value::as_str) == Some(req_id.as_str()) {
                    return map_reply(&value);
                }
            }
            Err(unavailable("task send bridge channel closed"))
        };
        tokio::time::timeout(std::time::Duration::from_secs(120), receive)
            .await
            .map_err(|_| unavailable("task send bridge timed out"))?
    }
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> Bridge for StdioBridge<'_, W> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(self.send(request))
    }
}
