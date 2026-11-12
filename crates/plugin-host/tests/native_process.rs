#![allow(clippy::unwrap_used)]
use pacer_plugin_host::{BrokerError, CommandResource, NativeProcess};
use serde_json::json;
use std::{
    collections::HashMap,
    time::{Duration, Instant},
};
fn command(name: &str, args: &[&str]) -> CommandResource {
    CommandResource {
        argv: std::iter::once(name)
            .chain(args.iter().copied())
            .map(str::to_owned)
            .collect(),
        timeout_ms: 1000,
        stdin: None,
        cwd: None,
        env: None,
        ..Default::default()
    }
}
#[tokio::test]
async fn exact_argv_and_no_ambient_environment_or_shell_expansion() {
    let commands = [
        command("printf", &["%s", "$(touch /never-create);界"]),
        command("env", &[]),
    ];
    let selected = HashMap::from([
        ("printf".into(), "/usr/bin/printf".into()),
        ("env".into(), "/usr/bin/env".into()),
    ]);
    let mut process = NativeProcess::prepare(
        &commands,
        &selected,
        &HashMap::from([
            ("HOME".into(), "/synthetic-home".into()),
            ("SYNTHETIC_SECRET".into(), "hidden".into()),
        ]),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    let result = process
        .spawn(&json!({"argv":commands[0].argv,"timeoutMs":1000}), deadline)
        .await
        .unwrap();
    assert_eq!(result["stdout"], "$(touch /never-create);界");
    let result = process
        .spawn(&json!({"argv":["env"],"timeoutMs":1000}), deadline)
        .await
        .unwrap();
    assert_eq!(result["stdout"], "HOME=/synthetic-home\n");
    assert!(
        process
            .spawn(
                &json!({"argv":["printf","changed"],"timeoutMs":1000}),
                deadline
            )
            .await
            .is_err()
    );
}
#[tokio::test]
async fn missing_binary_and_timeout_are_structured_and_owned_child_is_reaped() {
    let mut process = NativeProcess::prepare(
        &[command("absent", &[]), command("sleep", &["10"])],
        &HashMap::from([("sleep".into(), "/bin/sleep".into())]),
        &HashMap::new(),
    )
    .unwrap();
    let deadline = Instant::now() + Duration::from_secs(3);
    let missing = process
        .spawn(&json!({"argv":["absent"],"timeoutMs":1000}), deadline)
        .await
        .unwrap();
    assert_eq!(missing["code"], 127);
    let result = process
        .spawn(&json!({"argv":["sleep","10"],"timeoutMs":10.0}), deadline)
        .await
        .unwrap();
    assert_eq!(result["timedOut"], true);
}

#[tokio::test]
async fn deadline_timeout_preserves_partial_output_and_rejects_retained_descendant_pipes() {
    let cmd = command("sh", &["-c", "printf before; sleep 10"]);
    let mut process = NativeProcess::prepare(
        std::slice::from_ref(&cmd),
        &HashMap::from([("sh".into(), "/bin/sh".into())]),
        &HashMap::new(),
    )
    .unwrap();
    let result = process
        .spawn(
            &json!({"argv":cmd.argv,"timeoutMs":500}),
            Instant::now() + Duration::from_secs(3),
        )
        .await
        .unwrap();
    assert_eq!(result["stdout"], "before");
    let cmd = command("sh", &["-c", "sleep 0.5 & exit 0"]);
    let mut process = NativeProcess::prepare(
        std::slice::from_ref(&cmd),
        &HashMap::from([("sh".into(), "/bin/sh".into())]),
        &HashMap::new(),
    )
    .unwrap();
    assert!(
        process
            .spawn(
                &json!({"argv":cmd.argv,"timeoutMs":1000}),
                Instant::now() + Duration::from_secs(3)
            )
            .await
            .is_err()
    );
}

#[tokio::test]
async fn stdout_and_stderr_each_enforce_the_incremental_one_mib_limit() {
    let python = std::env::split_paths(&std::env::var_os("PATH").unwrap())
        .map(|p| p.join("python3"))
        .find(|p| p.is_file())
        .unwrap();
    for stream in ["stdout", "stderr"] {
        let script = format!("import sys;sys.{stream}.buffer.write(b'x'*(1048576+1))");
        let command = command("python3", &["-c", &script]);
        let mut process = NativeProcess::prepare(
            std::slice::from_ref(&command),
            &HashMap::from([("python3".into(), python.to_string_lossy().into_owned())]),
            &HashMap::new(),
        )
        .unwrap();
        let overflow = process
            .spawn(
                &json!({"argv":command.argv,"timeoutMs":1000}),
                Instant::now() + Duration::from_secs(5),
            )
            .await;
        assert!(
            matches!(
                overflow,
                Err(BrokerError::Invalid("provider output exceeds limit"))
            ),
            "{stream} overflow: {overflow:?}"
        );
    }
}

#[tokio::test]
async fn eof_on_both_owned_pipes_is_not_descendant_retention_before_status_collection() {
    let cmd = command("sh", &["-c", "printf ok; exit 0"]);
    let mut process = NativeProcess::prepare(
        std::slice::from_ref(&cmd),
        &HashMap::from([("sh".into(), "/bin/sh".into())]),
        &HashMap::new(),
    )
    .unwrap();
    for _ in 0..32 {
        let result = process
            .spawn(
                &json!({"argv":cmd.argv,"timeoutMs":1000}),
                Instant::now() + Duration::from_secs(3),
            )
            .await
            .unwrap();
        assert_eq!(result["code"], 0);
        assert_eq!(result["stdout"], "ok");
    }
}
