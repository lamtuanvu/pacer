//! Executor run claim attach for flag-on [`crate::ProcessOwner`] (P4d-12).

use pacer_plugin_host::{ExecutorClaimResource, NativeRun, RunLaunch, RunLaunchFile};
use std::{path::Path, time::Instant};

/// Core-sealed home for ProcessOwner executor run attach.
#[derive(Clone, Debug)]
pub struct ExecutorCallContext {
    pub home: std::path::PathBuf,
}

pub(crate) struct ExecutorAttachPlan {
    pub grant: ExecutorClaimResource,
    pub context: ExecutorCallContext,
}

pub(crate) fn issue_executor(
    plan: &ExecutorAttachPlan,
    deadline: Instant,
) -> Result<NativeRun, crate::capability::CapabilitySessionError> {
    let launch = &plan.grant.launch;
    let files = launch
        .files
        .as_ref()
        .map(|rows| {
            rows.iter()
                .map(|row| RunLaunchFile {
                    name: row.name.clone(),
                    content: row.content.clone(),
                    mode: row.mode,
                })
                .collect()
        })
        .unwrap_or_default();
    let run_launch = RunLaunch {
        home: plan.context.home.to_string_lossy().into_owned(),
        umask: launch.umask.clone(),
        keep_color: launch.keep_color.clone().unwrap_or_default(),
        argv: launch.argv.clone(),
        executable: launch.executable.clone(),
        cwd: launch.cwd.clone(),
        env: launch.env.clone(),
        stdin: launch.stdin.clone(),
        session: launch.session.clone(),
        files,
    };
    NativeRun::issue(
        &plan.context.home,
        &plan.grant.task_id,
        &plan.grant.provider_id,
        &plan.grant.executor,
        plan.grant.attempt,
        run_launch,
        deadline,
    )
    .map_err(|error| crate::capability::CapabilitySessionError::Native(error.to_string()))
}

pub fn executor_context_from_value(
    value: &serde_json::Value,
) -> Result<Option<ExecutorCallContext>, crate::capability::CapabilitySessionError> {
    let Some(raw) = value.get("executorContext") else {
        return Ok(None);
    };
    let home = raw
        .get("home")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            crate::capability::CapabilitySessionError::Malformed("executorContext home")
        })?;
    Ok(Some(ExecutorCallContext {
        home: Path::new(home).to_path_buf(),
    }))
}
