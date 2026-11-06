//! Detached `_run` launcher plan shared by queue drain and delegate admission.
//! Effectful spawn remains on the TypeScript core until a reviewed native owner
//! wires the same plan through `AdmissionState::drain` launch hooks (P6c+).

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

/// Current effectful owner for production `_run` children.
pub const RUN_SPAWN_OWNER: RunSpawnOwner = RunSpawnOwner::TypeScriptCore;

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
    }
}
