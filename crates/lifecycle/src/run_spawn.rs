//! Detached `_run` launcher plan shared by queue drain and delegate admission.
//! Effectful spawn remains on the TypeScript core until a reviewed native owner
//! wires the same plan through `AdmissionState::drain` launch hooks (P6e-run).

use crate::AdmissionError;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Who may execute [`RunSpawnPlan`] today. Only [`RunSpawnOwner::TypeScriptCore`]
/// performs `std::process::Command` spawn; Rust records the contract for drain
/// launch callbacks and future supervisor cutover.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunSpawnOwner {
    TypeScriptCore,
    /// Reserved for serve-side supervisor spawn (not activated in P6b).
    NativeSupervisor,
}

impl RunSpawnOwner {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TypeScriptCore => "typescript_core",
            Self::NativeSupervisor => "native_supervisor",
        }
    }
}

/// Current effectful owner for production `_run` children.
pub const RUN_SPAWN_OWNER: RunSpawnOwner = RunSpawnOwner::TypeScriptCore;

/// Stdio contract for detached `_run` children: stdin ignored, stdout/stderr append
/// to [`RunSpawnPlan::log_path`] (see `spawnRunnerProcess` in `src/tasks/api.ts`).
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunSpawnStdio {
    DetachedRunnerLog,
}

/// ProcessOwner-facing spawn fields derived from a guarded [`RunSpawnPlan`]. No I/O.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SupervisorRunSpawnSpec {
    pub argv: Vec<String>,
    pub env: HashMap<String, String>,
    pub log_path: PathBuf,
    pub detached: bool,
    pub stdio: RunSpawnStdio,
}

/// Match `selfCommand` in `src/tasks/api.ts`: re-run the script under bun/node,
/// or invoke the compiled binary alone.
pub fn self_command(exec_path: &str, argv1: Option<&str>) -> Vec<String> {
    let script = argv1.filter(|s| s.ends_with(".ts") || s.ends_with(".js") || s.ends_with(".mjs"));
    match script {
        Some(path) => vec![exec_path.to_owned(), path.to_owned()],
        None => vec![exec_path.to_owned()],
    }
}

/// Match `runnerLogPath` in `src/tasks/api.ts`.
pub fn runner_log_path(pacer_home: &Path) -> PathBuf {
    pacer_home.join("logs").join("runner.log")
}

/// argv/env/log contract for `spawn(cmd, [...pre, "_run", taskId], { detached, stdio, env })`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RunSpawnPlan {
    pub argv: Vec<String>,
    pub env: HashMap<String, String>,
    pub log_path: PathBuf,
    pub detached: bool,
    pub owner: RunSpawnOwner,
}

impl RunSpawnPlan {
    pub fn task_id(&self) -> Option<&str> {
        self.argv
            .windows(2)
            .find(|w| w[0] == "_run")
            .map(|w| w[1].as_str())
    }
}

/// Drain launch hooks must refuse mismatched task ids before effectful spawn.
pub fn validate_run_spawn_plan(plan: &RunSpawnPlan, task_id: &str) -> Result<(), &'static str> {
    match plan.task_id() {
        Some(id) if id == task_id => Ok(()),
        Some(_) => Err("run spawn plan task id mismatch"),
        None => Err("run spawn plan missing _run task id"),
    }
}

/// Match `launchTaskRunner` lease inheritance before work-sync pins (host must
/// still allocate a lease when neither `admitted_lease` nor env pins apply).
pub fn resolve_launch_admission_lease(
    base_env: &HashMap<String, String>,
    task_id: &str,
    admitted_lease: Option<&str>,
) -> Option<String> {
    if let Some(lease) = admitted_lease {
        return Some(lease.to_owned());
    }
    if base_env.get("PACER_ADMISSION_TASK").map(String::as_str) == Some(task_id) {
        return base_env.get("PACER_ADMISSION_LEASE").cloned();
    }
    None
}

/// Refuse effectful spawn when the plan owner disagrees with [`RUN_SPAWN_OWNER`].
pub fn guard_run_spawn_plan(plan: &RunSpawnPlan) -> Result<(), AdmissionError> {
    let task_id = plan
        .task_id()
        .ok_or_else(|| AdmissionError("run spawn plan missing _run task id".into()))?;
    validate_run_spawn_plan(plan, task_id).map_err(|message| AdmissionError(message.into()))?;
    if plan.owner != RUN_SPAWN_OWNER {
        return Err(AdmissionError("run spawn effect owner mismatch".into()));
    }
    Ok(())
}

/// [`AdmissionState::drain`] launch hooks call this before invoking an injected spawner.
pub fn drain_launch_run_spawn_plan(
    plan: RunSpawnPlan,
    task_id: &str,
) -> Result<RunSpawnPlan, AdmissionError> {
    validate_run_spawn_plan(&plan, task_id)
        .map_err(|message| AdmissionError(message.into()))?;
    guard_run_spawn_plan(&plan)?;
    Ok(plan)
}

pub struct RunSpawnLaunchInput<'a> {
    pub exec_path: &'a str,
    pub argv1: Option<&'a str>,
    pub home: &'a Path,
    pub pacer_home: &'a Path,
    pub base_env: &'a HashMap<String, String>,
    pub task_id: &'a str,
    pub admitted_lease: Option<&'a str>,
}

/// Build and guard a plan using the same lease resolution as `launchTaskRunner`.
pub fn build_run_spawn_plan_for_launch(
    input: RunSpawnLaunchInput<'_>,
) -> Result<RunSpawnPlan, AdmissionError> {
    let lease = resolve_launch_admission_lease(
        input.base_env,
        input.task_id,
        input.admitted_lease,
    )
    .ok_or_else(|| AdmissionError("run spawn missing admission lease".into()))?;
    let plan = build_run_spawn_plan(
        input.exec_path,
        input.argv1,
        input.home,
        input.pacer_home,
        input.base_env,
        input.task_id,
        &lease,
    );
    guard_run_spawn_plan(&plan)?;
    Ok(plan)
}

/// Map a guarded plan into ProcessOwner spawn fields. Returns an error while
/// [`RUN_SPAWN_OWNER`] remains [`RunSpawnOwner::TypeScriptCore`].
pub fn supervisor_run_spawn_spec(plan: &RunSpawnPlan) -> Result<SupervisorRunSpawnSpec, AdmissionError> {
    guard_run_spawn_plan(plan)?;
    if plan.owner == RunSpawnOwner::NativeSupervisor {
        return Ok(SupervisorRunSpawnSpec {
            argv: plan.argv.clone(),
            env: plan.env.clone(),
            log_path: plan.log_path.clone(),
            detached: plan.detached,
            stdio: RunSpawnStdio::DetachedRunnerLog,
        });
    }
    Err(AdmissionError(
        "native supervisor run spawn not activated".into(),
    ))
}

/// Build the launch plan after admission lease/task env pins are known.
/// Does not touch the filesystem or spawn a process.
pub fn build_run_spawn_plan(
    exec_path: &str,
    argv1: Option<&str>,
    home: &Path,
    pacer_home: &Path,
    base_env: &HashMap<String, String>,
    task_id: &str,
    admission_lease: &str,
) -> RunSpawnPlan {
    let mut argv = self_command(exec_path, argv1);
    argv.push("_run".into());
    argv.push(task_id.into());
    let mut env = base_env.clone();
    env.insert("HOME".into(), home.to_string_lossy().into_owned());
    env.insert(
        "PACER_HOME".into(),
        pacer_home.to_string_lossy().into_owned(),
    );
    env.insert("PACER_ADMISSION_LEASE".into(), admission_lease.into());
    env.insert("PACER_ADMISSION_TASK".into(), task_id.into());
    RunSpawnPlan {
        argv,
        env,
        log_path: runner_log_path(pacer_home),
        detached: true,
        owner: RUN_SPAWN_OWNER,
    }
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use std::path::Path;

    #[test]
    fn self_command_matches_typescript_script_detection() {
        assert_eq!(
            self_command("/bun", Some("/repo/src/cli.ts")),
            vec!["/bun", "/repo/src/cli.ts"]
        );
        assert_eq!(
            self_command("/usr/local/bin/pacer", Some("status")),
            vec!["/usr/local/bin/pacer"]
        );
    }

    #[test]
    fn plan_pins_admission_and_run_argv() {
        let home = Path::new("/home/user");
        let pacer = Path::new("/home/user/.pacer");
        let mut base = HashMap::new();
        base.insert("PATH".into(), "/bin".into());
        let plan = build_run_spawn_plan(
            "/bun",
            Some("/app/src/cli.ts"),
            home,
            pacer,
            &base,
            "t-20261106-000000-abcd",
            "lease-1",
        );
        assert_eq!(
            plan.argv,
            vec!["/bun", "/app/src/cli.ts", "_run", "t-20261106-000000-abcd"]
        );
        assert_eq!(
            plan.env.get("PACER_ADMISSION_TASK").unwrap(),
            "t-20261106-000000-abcd"
        );
        assert_eq!(plan.env.get("PACER_ADMISSION_LEASE").unwrap(), "lease-1");
        assert_eq!(plan.log_path, pacer.join("logs").join("runner.log"));
        assert!(plan.detached);
        assert_eq!(plan.owner, RunSpawnOwner::TypeScriptCore);
        validate_run_spawn_plan(&plan, "t-20261106-000000-abcd").unwrap();
        assert!(validate_run_spawn_plan(&plan, "other").is_err());
    }

    #[test]
    fn launch_lease_resolution_matches_typescript() {
        let mut env = HashMap::from([
            ("PACER_ADMISSION_TASK".into(), "t-a".into()),
            ("PACER_ADMISSION_LEASE".into(), "inherited".into()),
        ]);
        assert_eq!(
            resolve_launch_admission_lease(&env, "t-a", None).as_deref(),
            Some("inherited")
        );
        assert_eq!(
            resolve_launch_admission_lease(&env, "t-b", None),
            None
        );
        assert_eq!(
            resolve_launch_admission_lease(&env, "t-a", Some("explicit")).as_deref(),
            Some("explicit")
        );
        env.insert("PACER_ADMISSION_TASK".into(), "other".into());
        assert_eq!(
            resolve_launch_admission_lease(&env, "t-a", None),
            None
        );
    }

    #[test]
    fn supervisor_spec_stays_gated() {
        let plan = build_run_spawn_plan(
            "/bin/pacer",
            None,
            Path::new("/home"),
            Path::new("/home/.pacer"),
            &HashMap::new(),
            "t-20261106-000000-abcd",
            "lease-1",
        );
        assert!(supervisor_run_spawn_spec(&plan).is_err());
    }
}
