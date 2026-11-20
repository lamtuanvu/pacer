//! Core bridge transports for native `client.control.*` and the capture credential of
//! `client.register` (`/_internal/client-control`, `_internal.client-control`).
use pacer_foundation::api::OpFuture;
use pacer_machine_ops::client_ops::ClientBridge;
use serde_json::{Value, json};

pub struct HttpBridge {
    pub target: Option<(u16, String)>,
}

impl ClientBridge for HttpBridge {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            let body = json!({ "request": request });
            crate::core_bridge_sync::http(self.target.clone(), "client.control", body).await
        })
    }
}

pub struct StdioBridge<'a, W> {
    pub core: &'a mut W,
    pub prefix: &'a str,
    pub key: &'a str,
    pub replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> ClientBridge for StdioBridge<'_, W> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            let body = json!({ "request": request });
            crate::core_bridge_sync::stdio(
                self.core,
                self.prefix,
                self.key,
                "client.control",
                body,
                self.replies,
            )
            .await
        })
    }
}
