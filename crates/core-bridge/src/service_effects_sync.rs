//! Core effects bridge for `service.install`.
//! The bridge runs on the Core (TypeScript) side and executes the
//! launchctl/systemctl operations that need root/sudo.
use pacer_foundation::api::OpFuture;
use pacer_install::ServiceEffects;
use serde_json::Value;

pub struct HttpServiceEffects {
    pub target: Option<(u16, String)>,
}

impl ServiceEffects for HttpServiceEffects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            let body = serde_json::json!({ "request": request });
            crate::core_bridge_sync::http(self.target.clone(), "service.effects", body).await
        })
    }
}

pub struct StdioServiceEffects<'a, W> {
    pub core: &'a mut W,
    pub prefix: &'a str,
    pub key: &'a str,
    pub replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> ServiceEffects for StdioServiceEffects<'_, W> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            let body = serde_json::json!({ "request": request });
            crate::core_bridge_sync::stdio(
                self.core,
                self.prefix,
                self.key,
                "service.effects",
                body,
                self.replies,
            )
            .await
        })
    }
}
