//! Front-door dispatch for native `service.install` and `update.apply`.
//!
//! Rust refuses callers and validates params. Core runs the install transaction and
//! service-manager calls (`launchctl`/`systemctl`) or the shared update job. Over HTTP an
//! admitted request crosses the private effects bridge with no deadline, as a forwarded request
//! has none. Over stdio it is forwarded unchanged: the bridge would hold the request loop for the
//! whole install, while the core child answers forwarded requests concurrently.
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_install::install_ops::{self, ServiceEffects};
use pacer_messaging_ops::msg_ops::{current_dir, orca_worktree, own_worktree};
use pacer_update::apply::{self, UpdateEffects};
use serde_json::{Value, json};

/// Ops a front door dispatches natively through [`admit`], then Core.
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

/// The caller refusals and schema, without any Core effect.
#[allow(clippy::result_large_err)]
pub(crate) fn admit(ctx: &Ctx, op: &str, params: &Value) -> Result<(), CoreError> {
    match op {
        "service.install" => install_ops::admit(ctx, params),
        "update.apply" => apply::admit(ctx, params),
        _ => Err(CoreError::new(Code::UnknownOp, "unknown operation")),
    }
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
