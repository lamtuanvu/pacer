#![allow(clippy::unwrap_used)]
use super::*;
use std::collections::HashMap;

const ROOT: &str = "t-20261107-000000-aaaa";
const A: &str = "t-20261107-000001-bbbb";
const B: &str = "t-20261107-000002-cccc";
const OTHER: &str = "t-20261107-000003-dddd";

fn ctx(dir: &tempfile::TempDir, env: &[(&str, &str)]) -> Ctx {
    let env = env
        .iter()
        .map(|(k, v)| ((*k).into(), (*v).into()))
        .collect::<HashMap<_, _>>();
    Ctx::with(dir.path().into(), dir.path().into(), env, 1000.0)
}

fn seed(dir: &tempfile::TempDir) {
    let mut state = AdmissionState::open(dir.path()).unwrap();
    for (id, state_name) in [
        (ROOT, "running"),
        (A, "queued"),
        (B, "done"),
        (OTHER, "queued"),
    ] {
        let task = json!({"id": id, "rev": 1, "brief": {"goal": id, "repo": "/repo"}, "state": state_name,
            "createdAt": 10.0, "attempts": [], "timeoutS": 60, "requestedExecutor": null});
        state.tasks.insert(&task, 10.0).unwrap();
    }
    let db = state.tasks.connection().unwrap();
    for (id, parent, root) in [
        (ROOT, None, ROOT),
        (A, Some(ROOT), ROOT),
        (B, Some(ROOT), ROOT),
        (OTHER, None, OTHER),
    ] {
        db.execute(
            "INSERT INTO work_nodes(task_id,parent_id,root_id,depth,options,dependencies) VALUES(?,?,?,?,'{}','[]')",
            params![id, parent, root, i64::from(parent.is_some())],
        )
        .unwrap();
    }
}

fn rows(dir: &tempfile::TempDir, sql: &str) -> Vec<String> {
    let db = Connection::open(dir.path().join("state/tasks.db")).unwrap();
    let mut stmt = db.prepare(sql).unwrap();
    stmt.query_map([], |r| r.get::<_, String>(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

async fn error(result: Result<Value, CoreError>) -> (Code, String) {
    let error = result.unwrap_err();
    (error.code, error.message)
}

#[tokio::test]
async fn sets_dependencies_in_one_transaction_with_trigger_order() {
    let dir = tempfile::tempdir().unwrap();
    seed(&dir);
    let c = ctx(&dir, &[]);
    let tree = dispatch_dependencies(
        &c,
        json!({"id": A, "dependencies": [B, B], "expect_rev": 1}),
    )
    .await
    .unwrap();
    let node = tree["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["taskId"] == A)
        .unwrap();
    assert_eq!(node["dependencies"], json!([B]));
    assert_eq!(node["rev"], 2);
    assert_eq!(
        rows(
            &dir,
            "SELECT kind||' '||data FROM work_events WHERE task_id='t-20261107-000001-bbbb' ORDER BY seq"
        ),
        [
            r#"task.changed {"state":"queued","rev":2}"#.to_owned(),
            format!(r#"dependencies.changed {{"dependencies":["{B}","{B}"]}}"#),
        ]
    );
    assert_eq!(
        rows(
            &dir,
            "SELECT kind||' '||started_at||' '||refs FROM work_waits WHERE task_id='t-20261107-000001-bbbb' AND kind='dependency'"
        ),
        ["dependency 1000.0 1"]
    );
    assert_eq!(
        error(
            dispatch_dependencies(&c, json!({"id": A, "dependencies": [], "expect_rev": 1})).await
        )
        .await,
        (Code::Conflict, "Task changed".into())
    );
}

#[tokio::test]
async fn rejects_invalid_and_cyclic_dependencies_without_writing() {
    let dir = tempfile::tempdir().unwrap();
    seed(&dir);
    let c = ctx(&dir, &[]);
    for deps in [json!([A]), json!([OTHER]), json!(["missing"])] {
        assert_eq!(
            error(
                dispatch_dependencies(&c, json!({"id": A, "dependencies": deps, "expect_rev": 1}))
                    .await
            )
            .await,
            (Code::InvalidInput, "Invalid dependency".into())
        );
    }
    dispatch_dependencies(&c, json!({"id": B, "dependencies": [A], "expect_rev": 1}))
        .await
        .unwrap();
    assert_eq!(
        error(
            dispatch_dependencies(&c, json!({"id": A, "dependencies": [B], "expect_rev": 1})).await
        )
        .await,
        (Code::InvalidInput, "Dependency cycle".into())
    );
    assert_eq!(
        rows(
            &dir,
            "SELECT dependencies FROM work_nodes WHERE task_id='t-20261107-000001-bbbb'"
        ),
        ["[]"]
    );
    assert_eq!(
        error(
            dispatch_dependencies(
                &c,
                json!({"id": "t-20990101-000000-ffff", "dependencies": [], "expect_rev": 9})
            )
            .await
        )
        .await,
        (Code::UnknownTask, "Unknown work".into())
    );
}

#[tokio::test]
async fn waives_dependency_or_direct_child_and_closes_the_wait() {
    let dir = tempfile::tempdir().unwrap();
    seed(&dir);
    let c = ctx(&dir, &[]);
    dispatch_dependencies(&c, json!({"id": A, "dependencies": [B], "expect_rev": 1}))
        .await
        .unwrap();
    assert_eq!(
        error(
            dispatch_dependencies_waive(
                &c,
                json!({"id": A, "dependency": ROOT, "reason": "x", "expect_rev": 2})
            )
            .await
        )
        .await,
        (
            Code::InvalidInput,
            "Not a dependency or direct child of this work".into()
        )
    );
    dispatch_dependencies_waive(
        &c,
        json!({"id": A, "dependency": B, "reason": "\u{feff} skip \u{85}", "expect_rev": 2}),
    )
    .await
    .unwrap();
    assert_eq!(
        rows(&dir, "SELECT reason FROM work_dependency_waivers"),
        ["skip \u{85}"]
    );
    assert_eq!(
        rows(
            &dir,
            "SELECT ifnull(started_at,'')||' '||total_seconds||' '||refs FROM work_waits WHERE kind='dependency'"
        ),
        [" 0.0 0"]
    );
    let tree = dispatch_dependencies_waive(
        &c,
        json!({"id": ROOT, "dependency": A, "reason": "child", "expect_rev": 1}),
    )
    .await
    .unwrap();
    assert_eq!(tree["nodes"][0]["waivedChildren"], json!([A]));
}

#[tokio::test]
async fn params_report_zod_issues_in_schema_order() {
    let dir = tempfile::tempdir().unwrap();
    let c = ctx(&dir, &[]);
    assert_eq!(
        error(dispatch_dependencies(&c, json!({"dependencies": [1, ""], "expect_rev": 0})).await)
            .await
            .1,
        "id: Invalid input: expected string, received undefined; dependencies.0: Invalid input: expected string, received number; dependencies.1: Too small: expected string to have >=1 characters; expect_rev: Too small: expected number to be >0"
    );
    assert_eq!(
        error(
            dispatch_dependencies(
                &c,
                json!({"id": "x", "dependencies": vec!["a"; 101], "expect_rev": -1e300})
            )
            .await
        )
        .await
        .1,
        "dependencies: Too big: expected array to have <=100 items; expect_rev: Too small: expected int to be >=-9007199254740991; expect_rev: Too small: expected number to be >0"
    );
    assert_eq!(
        error(
            dispatch_dependencies_waive(
                &c,
                json!({"id": "x", "dependency": "y", "reason": " \u{3000} ", "expect_rev": 1.5})
            )
            .await
        )
        .await
        .1,
        "reason: Too small: expected string to have >=1 characters; expect_rev: Invalid input: expected int, received number"
    );
    assert_eq!(
        error(
            dispatch_dependencies_waive(&ctx(&dir, &[("PACER_ROLE", "executor")]), json!({})).await
        )
        .await,
        (Code::NotAllowed, "A scoped work grant is required".into())
    );
}

#[test]
fn reason_slices_utf16_units_and_forwards_split_pairs() {
    let even = "😀".repeat(2000);
    assert_eq!(reason_text(&even), Some("😀".repeat(1000).as_str()));
    let odd = format!("a{}", "😀".repeat(1500));
    assert_eq!(reason_text(&odd), None);
    assert!(dependencies_waive_stays_forwarded(
        "dispatch.dependencies.waive",
        &json!({"reason": odd})
    ));
    assert!(!dependencies_waive_stays_forwarded(
        "dispatch.dependencies.waive",
        &json!({"reason": even})
    ));
    assert!(!dependencies_waive_stays_forwarded(
        "dispatch.dependencies.waive",
        &json!({"reason": format!("a{}", "😀".repeat(2000))})
    ));
    assert!(!dependencies_waive_stays_forwarded(
        "dispatch.dependencies",
        &json!({"reason": odd})
    ));
    assert_eq!(
        js_trim("\u{feff}\u{2028} x \u{85}\u{180e}"),
        "x \u{85}\u{180e}"
    );
}
