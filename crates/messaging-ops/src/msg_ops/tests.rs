#![allow(clippy::unwrap_used)]
use super::*;
use std::collections::HashMap;

fn ctx(env: &[(&str, &str)]) -> Ctx {
    Ctx::with(
        "/home/u".into(),
        "/home/u/.pacer".into(),
        env.iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect::<HashMap<_, _>>(),
        1.0,
    )
}

fn id(env: &[(&str, &str)], cwd: &str) -> Caller {
    caller(&ctx(env), Some(cwd)).unwrap()
}

#[test]
fn caller_follows_typescript_precedence() {
    let local = Caller::Id("external:local".into());
    let human = Caller::Id("human".into());
    assert_eq!(id(&[], "/tmp"), local);
    assert_eq!(
        id(&[("PACER_WORK_GRANT", "pwg_x")], "/tmp"),
        Caller::Forward
    );
    assert_eq!(
        id(&[("PACER_ENFORCEMENT_TOKEN", "pet_x")], "/tmp"),
        Caller::Forward
    );
    assert_eq!(
        id(
            &[("PACER_ROLE", "executor"), ("PACER_TASK_ID", "t-1")],
            "/tmp"
        ),
        Caller::Id("task:t-1".into())
    );
    let error = caller(&ctx(&[("PACER_ROLE", "executor")]), Some("/tmp")).unwrap_err();
    assert_eq!(error.code, Code::NotAllowed);
    assert_eq!(error.message, "Executor identity is unknown");
    assert_eq!(error.data.unwrap()["layer"], "identity");
    assert_eq!(id(&[(CALLER_AUTH_ENV, "app")], "/tmp"), human);
    assert_eq!(
        id(&[(CALLER_AUTH_ENV, "app"), ("CLAUDECODE", "1")], "/tmp"),
        human
    );
    assert_eq!(
        id(&[(CALLER_AUTH_ENV, "session"), ("CLAUDECODE", "1")], "/tmp"),
        Caller::Id("external:claude-code".into())
    );
    assert_eq!(id(&[(CALLER_AUTH_ENV, "session")], "/tmp"), human);
    assert_eq!(
        id(
            &[
                (CALLER_AUTH_ENV, "app"),
                ("PACER_ROLE", "executor"),
                ("PACER_TASK_ID", "t")
            ],
            "/tmp"
        ),
        Caller::Id("task:t".into())
    );
}

#[test]
fn executor_and_orca_worktrees_follow_cwd_rules() {
    let task = "t-20260101-000000-abcd";
    assert_eq!(
        id(
            &[("PACER_TASK_ID", task)],
            &format!("/home/u/.pacer/worktrees/repo/{task}/src")
        ),
        Caller::Id(format!("task:{task}"))
    );
    assert_eq!(
        id(&[], &format!("/home/u/.pacer/worktrees/{task}")),
        Caller::Id("external:local".into())
    );
    assert_eq!(
        id(&[], &format!("/x/orca/workspaces/ws/pacer-{task}-codex/a")),
        Caller::Forward
    );
    assert_eq!(
        id(&[], &format!("/x/orca/workspaces/ws/pacer-{task}-")),
        Caller::Id("external:local".into())
    );
    assert_eq!(
        id(&[], "/x/orca/workspaces/pacer/pinfish"),
        Caller::Id("external:local".into())
    );
}

#[test]
fn planner_identity_matches_typescript_cleaning() {
    let planner = |env: &[(&str, &str)]| planner_participant(&ctx(env));
    assert_eq!(
        planner(&[("PACER_PLANNER_SESSION", "codex:a b/😀")]),
        Some("external:codex:a-b---".into())
    );
    assert_eq!(
        planner(&[("PACER_PLANNER_SESSION", "claude-code:")]),
        Some("external:claude-code".into())
    );
    assert_eq!(
        planner(&[("PACER_PLANNER_SESSION", "codex:a\nb")]),
        Some("external:codex:a-b".into())
    );
    assert_eq!(
        planner(&[("PACER_PLANNER_SESSION", "x y")]),
        Some("external:x-y".into())
    );
    let long = "a".repeat(200);
    assert_eq!(
        planner(&[("PACER_PLANNER_SESSION", &format!("codex:{long}"))]),
        Some(format!("external:codex:{}", &long[..96]))
    );
    assert_eq!(
        planner(&[("CLAUDECODE", "1")]),
        Some("external:claude-code".into())
    );
    assert_eq!(
        planner(&[("CODEX_SANDBOX", "seatbelt")]),
        Some("external:codex".into())
    );
    assert_eq!(
        planner(&[("CODEX_THREAD_ID", "abc")]),
        Some("external:codex:abc".into())
    );
    assert_eq!(planner(&[("CODEX_HOME", "/x")]), None);
}

#[test]
fn params_match_zod_issue_order() {
    let issues = |op: fn(&Value) -> Result<(), CoreError>, v: Value| op(&v).unwrap_err().message;
    fn inbox(v: &Value) -> Result<(), CoreError> {
        let mut p = Params::new(v)?;
        p.optional_bool("unread_only");
        p.optional_limit("limit");
        p.finish(&["unread_only", "limit"])
    }
    fn read(v: &Value) -> Result<(), CoreError> {
        let mut p = Params::new(v)?;
        p.ids("ids");
        p.finish(&["ids"])
    }
    assert!(inbox(&Value::Null).is_ok());
    assert_eq!(
        issues(inbox, json!({"limit": -0.5, "unread_only": 1})),
        "unread_only: Invalid input: expected boolean, received number; limit: Invalid input: expected int, received number"
    );
    assert_eq!(
        issues(inbox, json!({"limit": 1e300})),
        "limit: Too big: expected int to be <=9007199254740991; limit: Too big: expected number to be <=1000"
    );
    assert_eq!(
        issues(inbox, json!({"bogus": 1, "other": 2, "limit": 0})),
        "limit: Too small: expected number to be >=1; params: Unrecognized keys: \"bogus\", \"other\""
    );
    assert_eq!(
        issues(inbox, json!([])),
        "params: Invalid input: expected object, received array"
    );
    assert_eq!(
        issues(read, json!({"ids": [1, "x".repeat(65)]})),
        "ids.0: Invalid input: expected string, received number; ids.1: Too big: expected string to have <=64 characters"
    );
    assert_eq!(
        issues(read, json!({"ids": [], "z": 1})),
        "ids: Too small: expected array to have >=1 items; params: Unrecognized key: \"z\""
    );
    assert!(read(&json!({"ids": ["😀".repeat(64)]})).is_ok());
}

#[test]
fn human_receipts_and_grants_stay_forwarded() {
    assert!(msg_stays_forwarded(
        "msg.read",
        &ctx(&[(CALLER_AUTH_ENV, "app")])
    ));
    assert!(!msg_stays_forwarded(
        "msg.inbox",
        &ctx(&[(CALLER_AUTH_ENV, "app")])
    ));
    assert!(msg_stays_forwarded(
        "msg.log",
        &ctx(&[("PACER_WORK_GRANT", "pwg_x")])
    ));
    assert!(!msg_stays_forwarded(
        "msg.send",
        &ctx(&[(CALLER_AUTH_ENV, "app")])
    ));
}
