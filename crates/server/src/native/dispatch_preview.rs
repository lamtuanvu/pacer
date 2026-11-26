//! Bridges for native `dispatch.preview` and `dispatch.explain`: the cache-only
//! usage-broker parts still cross to Core (`status_sync`); the dispatch parts are
//! answered in-process by `pacer_dispatch::guards` with a process-wide
//! [`VersionCache`] (`NativeParts`).
use crate::native::status_sync;
use pacer_config_ops::strategy_load::native_load;
use pacer_dispatch::VersionCache;
use pacer_dispatch_ops::enforcement_ops::Bridge as EnforcementBridge;
use pacer_dispatch_ops::preview_ops::Bridge;
use pacer_foundation::{Ctx, api::OpFuture};
use serde_json::{Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

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

fn native_parts<'a>(ctx: &'a Ctx, params: Value, cache: &'a VersionCache) -> OpFuture<'a> {
    let ctx = ctx.clone();
    Box::pin(async move { pacer_dispatch::guards::dispatch_parts(&ctx, &params, cache).await })
}

pub(crate) struct NativeParts<'a> {
    pub(crate) target: Option<(u16, String)>,
    pub(crate) ctx: &'a Ctx,
    pub(crate) cache: &'a VersionCache,
}

impl Bridge for NativeParts<'_> {
    fn status(&mut self, params: Value) -> OpFuture<'_> {
        Box::pin(status_sync::http(self.target.clone(), params))
    }
    fn parts(&mut self, params: Value) -> OpFuture<'_> {
        native_parts(self.ctx, params, self.cache)
    }
}

pub(crate) struct NativeStdioParts<'a, W> {
    pub(crate) core: &'a mut W,
    pub(crate) prefix: &'a str,
    pub(crate) key: &'a str,
    pub(crate) replies: &'a mut UnboundedReceiver<Value>,
    pub(crate) ctx: &'a Ctx,
    pub(crate) cache: &'a VersionCache,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> Bridge for NativeStdioParts<'_, W> {
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
        native_parts(self.ctx, params, self.cache)
    }
}

/// Native dispatch parts for `dispatch.enforcement` and
/// `dispatch.enforcement.denied`. The board's former
/// `dispatch_enforcement_sync.rs` owned this implementation; it lives beside
/// the preview bridge because both answer `pacer_dispatch::guards` in-process.
pub(crate) struct EnforcementParts<'a> {
    pub(crate) ctx: &'a Ctx,
    pub(crate) cache: &'a VersionCache,
}

impl EnforcementBridge for EnforcementParts<'_> {
    fn parts(&mut self, params: Value) -> OpFuture<'_> {
        native_parts(self.ctx, params, self.cache)
    }
}
