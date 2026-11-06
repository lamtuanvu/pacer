#![allow(clippy::result_large_err)]
//! Stdio-only sequential orchestration for `host.set` (write, endpoint finish, read parts).
use pacer_foundation::{Ctx, api::CoreError};
use serde_json::Value;

use super::{config_writes, host_mut_ops};

pub(crate) async fn call_stdio_set<W: tokio::io::AsyncWrite + Unpin>(
    ctx: &Ctx,
    params: Value,
    core: &mut W,
    prefix: &str,
    key: &str,
    replies: &mut tokio::sync::mpsc::UnboundedReceiver<Value>,
) -> Result<Value, CoreError> {
    let alias = host_mut_ops::host_set_write(ctx, params).await?;
    super::config_sync::stdio(core, prefix, key, "host.set", replies).await?;
    let parts =
        super::host_read_sync::stdio(core, prefix, key, Some(alias.as_str()), replies).await?;
    let summary = host_mut_ops::host_set_summary(parts, &alias)?;
    config_writes::finish(ctx, "host.set", &summary)?;
    Ok(summary)
}
