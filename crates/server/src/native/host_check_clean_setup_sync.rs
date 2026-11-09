//! Core effects bridge transports for `host.check`, `host.clean`, `host.repo.setup`.
use pacer_config_ops::host_check_clean_setup_ops::HostEffects;
use pacer_foundation::api::OpFuture;
use serde_json::{Value, json};

#[allow(dead_code)]
pub(crate) struct HttpHostEffects {
    pub(crate) target: Option<(u16, String)>,
}

impl HostEffects for HttpHostEffects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            let body = json!({ "request": request });
            crate::native::core_bridge_sync::http(self.target.clone(), "host.effects", body).await
        })
    }
}

#[allow(dead_code)]
pub(crate) struct StdioHostEffects<'a, W> {
    pub(crate) core: &'a mut W,
    pub(crate) prefix: &'a str,
    pub(crate) key: &'a str,
    pub(crate) replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> HostEffects for StdioHostEffects<'_, W> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            let body = json!({ "request": request });
            crate::native::core_bridge_sync::stdio(
                self.core,
                self.prefix,
                self.key,
                "host.effects",
                body,
                self.replies,
            )
            .await
        })
    }
}
