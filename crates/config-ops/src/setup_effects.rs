//! Native `strategy.build` and `executor.setup.candidates` with their private
//! Core effects bridge (`/_internal/setup-effects`, `_internal.setup.effects`).
//! Rust owns validation, files, prompts and result assembly. Core runs only
//! effects that need its in-process state: the rendered live status, the
//! terminal hand-off under desktop work admission, and endpoint-plugin probes
//! of the fixed local model servers.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::Value;
use std::time::Duration;

/// One Core effect per call; requests are `{"kind": ...}` objects.
pub trait SetupEffects: Send {
    fn call(&mut self, request: Value) -> OpFuture<'_>;
}

/// Ops a front door dispatches through [`call`] with a Core effects bridge.
pub fn uses_effects(op: &str) -> bool {
    matches!(op, "strategy.build" | "executor.setup.candidates")
}

/// Registry entry for ops that run only through [`call`].
pub fn effects_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "setup effects bridge unavailable",
        ))
    })
}

/// `app` is true for an app-authenticated HTTP caller, whose terminals open in the app.
pub async fn call(
    ctx: &Ctx,
    op: &str,
    params: Value,
    app: bool,
    effects: &mut dyn SetupEffects,
) -> Result<Value, CoreError> {
    match op {
        "strategy.build" => {
            crate::strategy_build_ops::strategy_build(ctx, params, app, effects).await
        }
        "executor.setup.candidates" => {
            crate::executor_candidates_ops::candidates(ctx, params, effects).await
        }
        _ => Err(CoreError::new(Code::UnknownOp, "unknown operation")),
    }
}

/// Inputs only TypeScript reproduces, and work-grant callers, whose scope Core checks.
pub fn setup_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    if !matches!(
        op,
        "strategy.build" | "executor.setup.candidates" | "setup.init"
    ) {
        return false;
    }
    if ctx
        .env
        .get("PACER_WORK_GRANT")
        .is_some_and(|grant| !grant.is_empty())
    {
        return true;
    }
    if crate::executor_setup_ops::enforcement(ctx).is_err() {
        return false;
    }
    match op {
        "executor.setup.candidates" => crate::executor_candidates_ops::stays_forwarded(ctx),
        "setup.init" => crate::setup_init_ops::stays_forwarded(ctx, params),
        _ => false,
    }
}

pub(crate) fn unavailable(message: &str) -> CoreError {
    CoreError::new(Code::Unavailable, message)
}

/// `ctx.which`: the first executable regular file named `bin` on `PATH`.
pub(crate) fn which(ctx: &Ctx, bin: &str) -> Option<std::path::PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    ctx.env
        .get("PATH")?
        .split(':')
        .filter(|dir| !dir.is_empty())
        .map(|dir| std::path::Path::new(dir).join(bin))
        .find(|path| {
            std::fs::metadata(path)
                .is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
        })
}

/// Exit code and stdout of a fixed argv run with `ctx.env`; `None` when it
/// cannot start or exceeds `timeout`. Output beyond 4 MiB is cut off.
pub(crate) async fn run(ctx: &Ctx, argv: &[&str], timeout: Duration) -> Option<(i32, String)> {
    use tokio::io::AsyncReadExt;
    let (bin, args) = argv.split_first()?;
    let mut child = tokio::process::Command::new(bin)
        .args(args)
        .env_clear()
        .envs(&ctx.env)
        .current_dir(&ctx.home)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .ok()?;
    let mut stdout = child.stdout.take()?;
    let work = async {
        let mut out = Vec::new();
        let _ = (&mut stdout).take(4 << 20).read_to_end(&mut out).await;
        let status = child.wait().await.ok()?;
        Some((
            status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out).into_owned(),
        ))
    };
    tokio::time::timeout(timeout, work).await.ok().flatten()
}
