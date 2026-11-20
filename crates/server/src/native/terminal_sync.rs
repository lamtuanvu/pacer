//! Core bridge transports for native `terminal.*` (`src/api/terminal-parts-bridge.ts`).
use crate::native::core_bridge_sync;
use pacer_foundation::api::OpFuture;
use pacer_task_ops::terminal_ops::TerminalBridge;
use serde_json::Value;

pub(crate) struct HttpBridge {
    pub(crate) target: Option<(u16, String)>,
}

impl TerminalBridge for HttpBridge {
    fn parts(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(core_bridge_sync::http(
            self.target.clone(),
            "terminal.parts",
            request,
        ))
    }
}

pub(crate) struct StdioBridge<'a, W> {
    pub(crate) core: &'a mut W,
    pub(crate) prefix: &'a str,
    pub(crate) key: &'a str,
    pub(crate) replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> TerminalBridge for StdioBridge<'_, W> {
    fn parts(&mut self, request: Value) -> OpFuture<'_> {
        Box::pin(core_bridge_sync::stdio(
            self.core,
            self.prefix,
            self.key,
            "terminal.parts",
            request,
            self.replies,
        ))
    }
}
