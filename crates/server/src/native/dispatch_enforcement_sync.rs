//! Core bridges for native `dispatch.enforcement`, `dispatch.enforcement.probe`
//! and `dispatch.enforcement.denied`: the TypeScript-only pieces (--version
//! filling `checkedVersions`, certificate status, enforcement key, exclusion
//! reason) cross the sealed `dispatch-parts` bridge. `dispatch.enforcement`
//! forwards when the repository or policy needs Core; probe forwards its canary
//! job; denied never forwards (it runs under the `pet_` enforcement identity).
use crate::native::{dispatch_parts_sync, enforcement_ops::Bridge};
use pacer_foundation::{Ctx, api::OpFuture};
use serde_json::Value;

/// Whether an enforcement call must stay forwarded through the front doors
/// (HTTP and stdio): the enforcement read when Core must resolve the
/// repository, or a probe whose canary job Core must start. Denied never
/// forwards: it authorizes the `pet_` identity itself.
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

pub(crate) struct HttpBridge {
    pub(crate) target: Option<(u16, String)>,
}

impl Bridge for HttpBridge {
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
