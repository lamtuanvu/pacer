//! Core effects bridge transports for `service.handover` and `service.work`.
use pacer_foundation::api::OpFuture;
use pacer_update::handover::HandoverBridge;
use serde_json::{Value, json};

pub(crate) struct HttpHandoverBridge {
    pub(crate) target: Option<(u16, String)>,
}

impl HandoverBridge for HttpHandoverBridge {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            let body = json!({ "request": request });
            crate::native::core_bridge_sync::http(self.target.clone(), "handover.effects", body)
                .await
        })
    }
}

#[allow(dead_code)]
pub(crate) struct StdioHandoverBridge<'a, W> {
    pub(crate) core: &'a mut W,
    pub(crate) prefix: &'a str,
    pub(crate) key: &'a str,
    pub(crate) replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> HandoverBridge for StdioHandoverBridge<'_, W> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            let body = json!({ "request": request });
            crate::native::core_bridge_sync::stdio(
                self.core,
                self.prefix,
                self.key,
                "handover.effects",
                body,
                self.replies,
            )
            .await
        })
    }
}
