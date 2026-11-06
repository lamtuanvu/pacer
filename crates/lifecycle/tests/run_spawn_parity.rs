#![allow(clippy::unwrap_used)]

use pacer_lifecycle::{RunSpawnOwner, build_run_spawn_plan};
use std::collections::HashMap;
use std::path::Path;

#[test]
fn run_spawn_plan_matches_typescript_goldens() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
    let output = std::process::Command::new("bun")
        .args(["run", "test", "test/run-spawn-parity.test.ts"])
        .current_dir(&root)
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    let bun_script = build_run_spawn_plan(
        "/bun",
        Some("/repo/src/cli.ts"),
        Path::new("/home/user"),
        Path::new("/home/user/.pacer"),
        &HashMap::from([("PATH".into(), "/bin".into())]),
        "t-20261106-000000-abcd",
        "lease-1",
    );
    assert_eq!(
        bun_script.argv,
        vec!["/bun", "/repo/src/cli.ts", "_run", "t-20261106-000000-abcd"]
    );
    assert_eq!(bun_script.task_id(), Some("t-20261106-000000-abcd"));
    assert_eq!(bun_script.owner, RunSpawnOwner::TypeScriptCore);
    let binary = build_run_spawn_plan(
        "/usr/local/bin/pacer",
        Some("status"),
        Path::new("/home/user"),
        Path::new("/home/user/.pacer"),
        &HashMap::new(),
        "t-20261106-000000-efgh",
        "lease-2",
    );
    assert_eq!(
        binary.argv,
        vec!["/usr/local/bin/pacer", "_run", "t-20261106-000000-efgh"]
    );
}
