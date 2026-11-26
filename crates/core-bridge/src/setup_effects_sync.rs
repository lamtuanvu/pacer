//! Core effects bridge transports for `strategy.build`, `executor.setup.candidates` and `setup.init`.
use pacer_config_ops::{executor_setup_ops::EndpointModels, setup_effects::SetupEffects};
use pacer_foundation::api::OpFuture;
use serde_json::{Value, json};

pub struct HttpEffects {
    pub target: Option<(u16, String)>,
}

impl EndpointModels for HttpEffects {
    fn models(&mut self, base_url: &str, timeout_ms: u32) -> OpFuture<'_> {
        let body =
            json!({ "request": {"kind":"models","baseUrl":base_url,"timeoutMs":timeout_ms} });
        Box::pin(async move {
            crate::core_bridge_sync::http(self.target.clone(), "setup.effects", body).await
        })
    }
}

impl SetupEffects for HttpEffects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            let body = json!({ "request": request });
            crate::core_bridge_sync::http(self.target.clone(), "setup.effects", body).await
        })
    }
}

pub struct StdioEffects<'a, W> {
    pub core: &'a mut W,
    pub prefix: &'a str,
    pub key: &'a str,
    pub replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> EndpointModels for StdioEffects<'_, W> {
    fn models(&mut self, base_url: &str, timeout_ms: u32) -> OpFuture<'_> {
        let request = json!({"kind":"models","baseUrl":base_url,"timeoutMs":timeout_ms});
        Box::pin(async move {
            let body = json!({ "request": request });
            crate::core_bridge_sync::stdio(
                self.core,
                self.prefix,
                self.key,
                "setup.effects",
                body,
                self.replies,
            )
            .await
        })
    }
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> SetupEffects for StdioEffects<'_, W> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            let body = json!({ "request": request });
            crate::core_bridge_sync::stdio(
                self.core,
                self.prefix,
                self.key,
                "setup.effects",
                body,
                self.replies,
            )
            .await
        })
    }
}
