//! Server-side effects for native runner operations: a `JobStarter` backed by
//! the delegation runtime and the terminal opener used by interactive
//! `runner.add`.
use std::path::PathBuf;

use pacer_config_ops::runner_check_ops::JobStarter;
use pacer_config_ops::runner_ops::TerminalOpener;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_delegation::Runtime;
use serde_json::{Value, json};

/// Starts a check job through the delegation runtime (B1 job files + the
/// shared `pacer_lifecycle::runner_check::check` decision helper).
pub(crate) struct DelegatingJobStarter<'a> {
    runtime: &'a Runtime,
}

impl<'a> DelegatingJobStarter<'a> {
    pub(crate) fn new(runtime: &'a Runtime) -> Self {
        Self { runtime }
    }
}

impl JobStarter for DelegatingJobStarter<'_> {
    fn start<'a>(&'a self, ctx: &'a Ctx, params: &'a Value) -> OpFuture<'a> {
        pacer_delegation::runner_check::start(ctx, self.runtime, params)
    }
}

/// Opens `pacer runner add` in a terminal. `PACER_TEST_TERMINAL=record` writes
/// the argv to `$PACER_HOME/terminal-open.log` for parity tests; without a
/// native terminal owner the command is returned with `opened: false`.
pub(crate) struct NativeTerminalOpener;

fn log_file(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("terminal-open.log")
}

impl NativeTerminalOpener {
    fn record(ctx: &Ctx, argv: &[String]) -> Result<(), CoreError> {
        use std::io::Write;
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_file(ctx))
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        writeln!(file, "{}", serde_json::to_string(argv).unwrap())
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))
    }
}

impl TerminalOpener for NativeTerminalOpener {
    fn open<'a>(
        &'a self,
        ctx: &'a Ctx,
        argv: &[String],
        title: &str,
        worktree: Option<&str>,
    ) -> OpFuture<'a> {
        let argv = argv.to_vec();
        let title = title.to_string();
        let worktree = worktree.map(str::to_string);
        Box::pin(async move {
            if ctx.env.get("PACER_TEST_TERMINAL").map(String::as_str) == Some("record") {
                Self::record(ctx, &argv)?;
                return Ok(json!({"opened": true, "argv": argv, "title": title}));
            }
            let mut result = json!({"opened": false, "argv": argv, "title": title});
            if let Some(worktree) = worktree {
                result["worktree"] = json!(worktree);
            }
            Ok(result)
        })
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::collections::HashMap;

    #[tokio::test]
    async fn recording_terminal_captures_the_runner_add_argv() {
        let dir = tempfile::tempdir().unwrap();
        let mut env = HashMap::new();
        env.insert("PACER_TEST_TERMINAL".into(), "record".into());
        let ctx = Ctx::with(dir.path().into(), dir.path().into(), env, 1.0);
        let argv = vec!["pacer".into(), "runner".into(), "add".into()];
        let reply = NativeTerminalOpener
            .open(&ctx, &argv, "pacer settings", None)
            .await
            .unwrap();
        assert_eq!(reply["opened"], true);
        let logged = std::fs::read_to_string(log_file(&ctx)).unwrap();
        assert_eq!(serde_json::from_str::<Value>(logged.trim()).unwrap(), json!(argv));
    }
}
