//! Core effects bridge transports for `strategy.build` and `executor.setup.candidates`.
use pacer_config_ops::setup_effects::SetupEffects;
use pacer_foundation::api::OpFuture;
use serde_json::{Value, json};

pub(crate) struct HttpEffects {
    pub(crate) target: Option<(u16, String)>,
}

impl SetupEffects for HttpEffects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            let body = json!({ "request": request });
            crate::native::core_bridge_sync::http(self.target.clone(), "setup.effects", body).await
        })
    }
}

pub(crate) struct StdioEffects<'a, W> {
    pub(crate) core: &'a mut W,
    pub(crate) prefix: &'a str,
    pub(crate) key: &'a str,
    pub(crate) replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> SetupEffects for StdioEffects<'_, W> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            let body = json!({ "request": request });
            crate::native::core_bridge_sync::stdio(
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
