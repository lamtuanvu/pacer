//! Core bridges for native `dispatch.preview` and `dispatch.explain`: the cache-only
//! usage-broker parts (`status_sync`) and the dispatch parts (`dispatch_parts_sync`).
use crate::native::{dispatch_parts_sync, preview_ops::Bridge, status_sync};
use pacer_config_ops::strategy_load::native_load;
use pacer_foundation::{Ctx, api::OpFuture};
use serde_json::{Value, json};

/// Inputs only TypeScript answers: a strategy `strategy_load` leaves to TypeScript, a
/// `strategyDraft` whose YAML Bun may read differently, then [`preview_ops::stays_forwarded`].
///
/// [`preview_ops::stays_forwarded`]: crate::native::preview_ops::stays_forwarded
pub fn dispatch_preview_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    use pacer_config_ops::strategy_preview_ops::strategy_preview_stays_forwarded;
    if !crate::native::preview_ops::needs_dispatch_parts(op) {
        return false;
    }
    let draft = params.get("strategyDraft");
    !matches!(native_load(&ctx.pacer_home), Some(Ok(_)))
        || draft
            .is_some_and(|draft| strategy_preview_stays_forwarded(ctx, &json!({"draft": draft})))
        || crate::native::preview_ops::stays_forwarded(ctx, op, params)
}

pub(crate) struct HttpBridge {
    pub(crate) target: Option<(u16, String)>,
}

impl Bridge for HttpBridge {
    fn status(&mut self, params: Value) -> OpFuture<'_> {
        Box::pin(status_sync::http(self.target.clone(), params))
    }
    fn parts(&mut self, params: Value) -> OpFuture<'_> {
        Box::pin(dispatch_parts_sync::http(self.target.clone(), params))
    }
}

pub(crate) struct StdioBridge<'a, W> {
    pub(crate) core: &'a mut W,
    pub(crate) prefix: &'a str,
    pub(crate) key: &'a str,
    pub(crate) replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> Bridge for StdioBridge<'_, W> {
    fn status(&mut self, params: Value) -> OpFuture<'_> {
        Box::pin(status_sync::stdio(
            self.core,
            self.prefix,
            self.key,
            params,
            self.replies,
        ))
    }
    fn parts(&mut self, params: Value) -> OpFuture<'_> {
        Box::pin(dispatch_parts_sync::stdio(
            self.core,
            self.prefix,
            self.key,
            params,
            self.replies,
        ))
    }
}
