//! Native `statusBrokerPartsFor` for both doors. One `StatusRuntime` is built
//! per door process with that door's plugin link, so every status op reads usage
//! and the plugin registry through the door rather than the TS core's sealed
//! `/_internal/status-broker-parts` route (deleted in B12-6).

use super::extension_calls::DoorPlugins;
use crate::{serve::core_child::CoreChild, stdio_plugins::PluginLink};
use pacer_foundation::{Ctx, api::OpFuture};
use pacer_status::compute::{ActivityRebuilds, LoginPaths, StatusRuntime};
use serde_json::Value;
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
