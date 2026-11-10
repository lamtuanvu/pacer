//! Core effects bridge transports for native `service.install` and `update.apply`.
//! Core runs the install transaction and service-manager calls (`launchctl`/`systemctl`)
//! and the shared update job; Rust has already refused callers and validated params.
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_install::install_ops::{self, ServiceEffects};
use pacer_messaging_ops::msg_ops::{current_dir, orca_worktree, own_worktree};
use pacer_update::apply::{self, UpdateEffects};
use serde_json::{Value, json};

/// Ops a front door dispatches through [`call`] with a Core effects bridge.
pub(crate) fn uses_effects(op: &str) -> bool {
    install_ops::uses_effects(op) || apply::uses_effects(op)
}

/// Work-grant callers, and a task worktree as the process directory, whose executor
/// check needs Core (`isExecutorSession` confirms the Orca provider from the strategy).
pub(crate) fn stays_forwarded(ctx: &Ctx, op: &str) -> bool {
    let grant = match op {
        "service.install" => install_ops::stays_forwarded(ctx),
        "update.apply" => apply::stays_forwarded(ctx),
        _ => return false,
    };
    grant || current_dir().is_some_and(|cwd| own_worktree(ctx, &cwd) || orca_worktree(&cwd))
}

#[allow(clippy::result_large_err)]
pub(crate) async fn call<E: ServiceEffects + UpdateEffects>(
    ctx: &Ctx,
    op: &str,
    params: Value,
    effects: &mut E,
) -> Result<Value, CoreError> {
    match op {
        "service.install" => install_ops::service_install(ctx, params, effects).await,
        "update.apply" => apply::update_apply(ctx, params, effects).await,
        _ => Err(CoreError::new(Code::UnknownOp, "unknown operation")),
    }
}

pub(crate) struct HttpEffects {
    pub(crate) target: Option<(u16, String)>,
}

impl HttpEffects {
    fn effect(&mut self, bridge: &'static str, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            crate::native::core_bridge_sync::http(
                self.target.clone(),
                bridge,
                json!({ "request": request }),
            )
            .await
        })
    }
}

impl ServiceEffects for HttpEffects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        self.effect("service.effects", request)
    }
}

impl UpdateEffects for HttpEffects {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        self.effect("update.effects", request)
    }
}

pub(crate) struct StdioEffects<'a, W> {
    pub(crate) core: &'a mut W,
    pub(crate) prefix: &'a str,
    pub(crate) key: &'a str,
    pub(crate) replies: &'a mut tokio::sync::mpsc::UnboundedReceiver<Value>,
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> StdioEffects<'_, W> {
    fn effect(&mut self, bridge: &'static str, request: Value) -> OpFuture<'_> {
        Box::pin(async move {
            crate::native::core_bridge_sync::stdio(
                self.core,
                self.prefix,
                self.key,
                bridge,
                json!({ "request": request }),
                self.replies,
            )
            .await
        })
    }
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> ServiceEffects for StdioEffects<'_, W> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        self.effect("service.effects", request)
    }
}

impl<W: tokio::io::AsyncWrite + Unpin + Send> UpdateEffects for StdioEffects<'_, W> {
    fn call(&mut self, request: Value) -> OpFuture<'_> {
        self.effect("update.effects", request)
    }
}
