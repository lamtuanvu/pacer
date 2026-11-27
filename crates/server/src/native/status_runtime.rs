//! Native `statusBrokerPartsFor` for both doors. One `StatusRuntime` is built
//! per door process with that door's plugin link, so every status op reads usage
//! and the plugin registry through the door rather than the TS core's sealed
//! `/_internal/status-broker-parts` route (deleted in B12-6).

use super::extension_calls::DoorPlugins;
use crate::{serve::core_child::CoreChild, stdio_plugins::PluginLink};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_status::compute::{ActivityRebuilds, LoginPaths, StatusRuntime};
use serde_json::{Value, json};
use std::{future::Future, io, pin::pin, sync::Arc};

/// The stdio door's plugin requests travel as lines on a channel the input loop
/// normally drains. A native status op awaits plugin entries *inside* the loop,
/// so keep draining those lines while it runs, or the door deadlocks waiting for
/// a reply the loop would only write after the op finished.
pub(crate) async fn pump_frames<T, F>(
    future: F,
    frames: &mut tokio::sync::mpsc::UnboundedReceiver<Vec<u8>>,
    core: &mut (impl tokio::io::AsyncWrite + Unpin),
) -> io::Result<T>
where
    F: Future<Output = T>,
{
    use tokio::io::AsyncWriteExt;
    let mut future = pin!(future);
    loop {
        tokio::select! {
            result = &mut future => return Ok(result),
            Some(frame) = frames.recv() => {
                core.write_all(&frame).await?;
                core.flush().await?;
            }
        }
    }
}

/// The reply `statusBrokerPartsFor` gives, computed natively for one request.
pub(crate) fn broker_parts(rt: &Arc<StatusRuntime>, ctx: Ctx, params: Value) -> OpFuture<'static> {
    let rt = Arc::clone(rt);
    Box::pin(async move { pacer_status::parts::broker_parts(&ctx, params, &rt).await })
}

/// Adds `status` (or `statusError`, or `statusCached: true`) to the snapshot
/// probe's parts. The front door asks TypeScript only for the non-status parts;
/// status is computed read-only here, and only when the read model's 60 s
/// status cache is stale. This restores `liveSnapshot`'s status reuse
/// (`src/api/events.ts:49-55`) without a status computation on the warm path.
pub(crate) fn with_native_status<'a>(
    rt: &Arc<StatusRuntime>,
    ctx: Ctx,
    parts: OpFuture<'a>,
) -> OpFuture<'a> {
    let rt = Arc::clone(rt);
    Box::pin(async move {
        let mut parts = parts.await?;
        let fresh = pacer_task_ops::snapshot_get_ops::model()
            .lock()
            .map_err(|_| CoreError::new(Code::Internal, "read model lock poisoned"))?
            .status_cache_fresh(&ctx, pacer_read_model::STATUS_CACHE_MAX_AGE_S);
        if fresh {
            parts["statusCached"] = json!(true);
            return Ok(parts);
        }
        let strategy = pacer_read_model::fallback_strategy(&ctx.pacer_home);
        let opts = pacer_status::compute::StatusOptions {
            read_only: true,
            ..Default::default()
        };
        match pacer_status::compute::compute_status(&ctx, &strategy, &opts, &rt).await {
            Ok(status) => parts["status"] = status,
            Err(error) => parts["statusError"] = json!(error.message),
        }
        Ok(parts)
    })
}

fn build(door: Arc<DoorPlugins>) -> Arc<StatusRuntime> {
    Arc::new(StatusRuntime {
        usage: pacer_status::usage::NativeUsage::new(door.clone()),
        door,
        login: Arc::new(LoginPaths::default()),
        activity: Arc::new(ActivityRebuilds::default()),
    })
}

/// The HTTP serve door's runtime, shared by every request of one serve.
pub(crate) fn serve_runtime(core: Arc<CoreChild>) -> Arc<StatusRuntime> {
    build(Arc::new(DoorPlugins::http(core)))
}

/// The stdio door's runtime, shared by one connection's requests.
pub(crate) fn stdio_runtime(link: Arc<PluginLink>) -> Arc<StatusRuntime> {
    build(Arc::new(DoorPlugins::stdio(link)))
}
