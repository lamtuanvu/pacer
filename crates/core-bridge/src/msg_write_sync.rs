#![allow(clippy::result_large_err)]
//! Core bridges for the native message writes: turn delivery, the human's task
//! publication and worktree auto-clean stay in the TypeScript core.
use pacer_foundation::api::{Code, CoreError, OpFuture};
use pacer_messaging_ops::msg_writes::Bridge;
use serde_json::{Value, json};

fn unavailable(message: &str) -> CoreError {
    CoreError::new(Code::Unavailable, message)
}

fn map_reply(value: &Value) -> Result<Value, CoreError> {
    if let Some(error) = value.get("error") {
        return Err(crate::config_sync::error(error));
    }
    value
        .get("result")
        .cloned()
        .ok_or_else(|| unavailable("invalid message bridge response"))
}

pub fn trace(name: &str, request_id: Option<&Value>) {
    if std::env::var("PACER_DEBUG_NATIVE").as_deref() == Ok("1") {
        match request_id {
            Some(id) => eprintln!("native {name} {id}"),
            None => eprintln!("native {name}"),
        }
    }
}

fn clean_ids(request: &Value) -> Option<Vec<String>> {
    (request["kind"] == "clean").then(|| {
        request["id"]
            .as_str()
            .into_iter()
            .map(str::to_owned)
            .collect()
    })
}

pub struct HttpBridge {
    pub target: Option<(u16, String)>,
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
            let request = axum::http::Request::builder()
                .method("POST")
                .uri(format!("http://127.0.0.1:{port}/_internal/msg-effects"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .body(Body::from(request.to_string()))
                .map_err(|_| unavailable("message bridge unavailable"))?;
            let client: Client<HttpConnector, Body> =
                Client::builder(TokioExecutor::new()).build_http();
            let response = client
                .request(request)
                .await
                .map_err(|_| unavailable("message bridge unavailable"))?;
            let bytes = response
                .into_body()
                .collect()
                .await
                .map_err(|_| unavailable("message bridge unavailable"))?
                .to_bytes();
            let value: Value = serde_json::from_slice(&bytes)
                .map_err(|_| unavailable("invalid message bridge response"))?;
            map_reply(&value)
        };
        tokio::time::timeout(std::time::Duration::from_secs(120), run)
            .await
            .map_err(|_| unavailable("message bridge timed out"))?
    }
}

impl Bridge for HttpBridge {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            match clean_ids(&request) {
                Some(ids) => crate::task_clean_sync::http(self.target.clone(), &ids).await,
                None => self.post(request).await,
            }
        })
    }
}

pub struct StdioBridge<'a, W> {
    pub core: &'a mut W,
    pub prefix: &'a str,
    pub key: &'a str,
    pub replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
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
            "method": "_internal.msg.effects",
            "params": {"key": self.key, "request": request},
        });
        let mut bytes = serde_json::to_vec(&line)
            .map_err(|_| CoreError::new(Code::Internal, "message bridge encoding failed"))?;
        bytes.push(b'\n');
        self.core
            .write_all(&bytes)
            .await
            .map_err(|_| unavailable("message bridge channel closed"))?;
        self.core
            .flush()
            .await
            .map_err(|_| unavailable("message bridge channel closed"))?;
        let receive = async {
            while let Some(value) = self.replies.recv().await {
                if value.get("id").and_then(Value::as_str) == Some(req_id.as_str()) {
                    return map_reply(&value);
                }
            }
            Err(unavailable("message bridge channel closed"))
        };
        tokio::time::timeout(std::time::Duration::from_secs(120), receive)
            .await
            .map_err(|_| unavailable("message bridge timed out"))?
    }
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> Bridge for StdioBridge<'_, W> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            match clean_ids(&request) {
                Some(ids) => {
                    crate::task_clean_sync::stdio(
                        self.core,
                        self.prefix,
                        self.key,
                        &ids,
                        self.replies,
                    )
                    .await
                }
                None => self.send(request).await,
            }
        })
    }
}
