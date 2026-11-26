//! Bridges for native `dispatch.enforcement`, `dispatch.enforcement.probe` and
//! `dispatch.enforcement.denied`: the TypeScript-only pieces (--version filling
//! the in-process cache, certificate status, enforcement key, exclusion reason)
//! are answered by `pacer_dispatch::guards` through [`NativeParts`]. `probe`
//! forwards its canary job to Core.
use pacer_dispatch::VersionCache;
use pacer_dispatch_ops::enforcement_ops::Bridge;
use pacer_foundation::{Ctx, api::OpFuture};
use serde_json::Value;

/// Whether an enforcement call must stay forwarded through the front doors
/// (HTTP and stdio): only a probe whose canary job Core must start. `denied`
/// never forwards: it authorizes the `pet_` identity itself, and the enforcement
/// read is fully native after B2-5.
pub fn dispatch_enforcement_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    match op {
        "dispatch.enforcement" | "dispatch.enforcement.denied" => {
            crate::native::enforcement_ops::dispatch_enforcement_stays_forwarded(ctx, op, params)
        }
        "dispatch.enforcement.probe" => {
            crate::native::enforcement_ops::dispatch_enforcement_probe_stays_forwarded(ctx, params)
        }
        _ => false,
    }
}

fn native_parts<'a>(ctx: &'a Ctx, params: Value, cache: &'a VersionCache) -> OpFuture<'a> {
    let ctx = ctx.clone();
    Box::pin(async move { pacer_dispatch::guards::dispatch_parts(&ctx, &params, cache).await })
}

/// Native dispatch parts for both HTTP and stdio. The version cache is shared
/// with the rest of the process for the listener's (or session's) lifetime.
pub(crate) struct NativeParts<'a> {
    pub(crate) ctx: &'a Ctx,
    pub(crate) cache: &'a VersionCache,
}

impl Bridge for NativeParts<'_> {
    fn parts(&mut self, params: Value) -> OpFuture<'_> {
        native_parts(self.ctx, params, self.cache)
    }
}
