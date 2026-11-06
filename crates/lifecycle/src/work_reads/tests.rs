#![allow(clippy::unwrap_used)]
use super::*;
use crate::AdmissionState;
use serde_json::json;

const ROOT: &str = "t-20261110-190000-aaaa";
const CHILD: &str = "t-20261110-190000-bbbb";
const GRANDCHILD: &str = "t-20261110-190000-cccc";
const OTHER: &str = "t-20261110-190000-dddd";

fn insert_task(db: &Connection, record: &Value) {
    db.execute(
        "INSERT INTO tasks(id,rev,state,created_at,updated_at,settled_at,repo,record,archived) VALUES(?,?,?,?,?,?,?,?,0)",
        params![
            record["id"].as_str().unwrap(),
            record["rev"].as_i64().unwrap_or(1),
            record["state"].as_str().unwrap(),
            record["createdAt"].as_f64().unwrap_or(1.0),
            record["createdAt"].as_f64().unwrap_or(1.0),
            Option::<f64>::None,
            Option::<String>::None,
            record.to_string(),
        ],
    )
    .unwrap();
}

fn insert_node(
    db: &Connection,
    id: &str,
    parent: Option<&str>,
    root: &str,
    depth: i64,
    options: &Value,
) {
    db.execute(
        "INSERT INTO work_nodes(task_id,parent_id,root_id,depth,options,dependencies) VALUES(?,?,?,?,?,'[]')",
        params![id, parent, root, depth, options.to_string()],
    )
    .unwrap();
}

fn task(id: &str, state: &str, extra: Value) -> Value {
    let mut record = json!({"id": id, "rev": 2, "state": state, "createdAt": 10, "attempts": [],
        "brief": {"goal": format!("goal {id}"), "repo": "/repo"}, "requestedExecutor": "codex"});
    if let (Some(base), Value::Object(extra)) = (record.as_object_mut(), extra) {
        base.extend(extra);
    }
    record
}

fn seeded() -> (tempfile::TempDir, AdmissionState) {
    let dir = tempfile::tempdir().unwrap();
    let mut state = AdmissionState::open(dir.path()).unwrap();
    {
        let db = state.tasks.connection().unwrap();
        insert_task(db, &task(ROOT, "running", json!({"title": "Root"})));
        insert_task(
            db,
            &task(
                CHILD,
                "failed",
                json!({"attempts": [{"executor": "codex#team", "model": "m", "startedAt": 20, "endedAt": 30.5,
            "exitCode": 1, "timedOut": false, "limitHit": false, "log": "",
            "tokens": {"coverage": "measured", "input": 1, "cacheRead": 0, "cacheWrite": 0, "output": 2, "reasoning": null, "total": 3, "turns": 1,
                "source": "executor-json", "selfReported": false, "extractor": "x", "capturedAt": 31}}]}),
            ),
        );
        insert_task(
            db,
            &task(
                OTHER,
                "running",
                json!({"question": {"text": "?"}, "run": {"mode": "new"}}),
            ),
        );
        insert_node(
            db,
            ROOT,
            None,
            ROOT,
            0,
            &json!({"allowDelegation": true, "delegationEnforcement": "strict"}),
        );
        insert_node(db, CHILD, Some(ROOT), ROOT, 1, &json!({"maxAttempts": 1}));
        insert_node(db, GRANDCHILD, Some(CHILD), ROOT, 2, &json!({}));
        insert_node(db, OTHER, None, OTHER, 0, &json!({}));
        for (task_id, data) in [
            (ROOT, r#"{"a":2.0}"#),
            (CHILD, r#"{"b":1}"#),
            (GRANDCHILD, r#"{"c":[1.5]}"#),
        ] {
            db.execute(
                "INSERT INTO work_events(root_id,task_id,at,kind,data) VALUES(?,?,?,?,?)",
                params![ROOT, task_id, 5.25, "k", data],
            )
            .unwrap();
        }
    }
    (dir, state)
}

fn reads<'a>(db: &'a Connection, alive: &'a dyn Fn(&Value) -> bool) -> WorkReads<'a> {
    WorkReads {
        db,
        now: 100.0,
        pid_alive: alive,
    }
}

#[test]
fn tree_scopes_to_the_subtree_and_projects_archived_nodes() {
    let (_dir, mut state) = seeded();
    let db = state.tasks.connection().unwrap();
    let never = |_: &Value| false;
    let tree = reads(db, &never).scoped_tree(CHILD).unwrap();
    assert_eq!(tree["rootId"], ROOT);
    let ids: Vec<_> = tree["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .map(|n| n["taskId"].clone())
        .collect();
    assert_eq!(ids, [json!(CHILD), json!(GRANDCHILD)]);
    let child = &tree["nodes"][0];
    assert_eq!(child["options"]["delegationEnforcement"], "cooperative");
    assert_eq!(child["title"], format!("goal {CHILD}"));
    assert_eq!(child["executor"], "codex");
    assert_eq!(child["model"], "m");
    assert_eq!(
        child["retryEligibility"],
        json!({"allowed": false, "reason": "Managed work attempt limit reached"})
    );
    let archived = &tree["nodes"][1];
    assert_eq!(archived["state"], "archived");
    assert_eq!(
        archived["retryEligibility"],
        json!({"allowed": false, "reason": "Archived work"})
    );
    assert_eq!(tree["totals"]["tasks"], 2);
    assert_eq!(tree["totals"]["executionSeconds"], json!(10.5));
    assert_eq!(tree["totals"]["tokens"]["total"], 3);
    assert_eq!(tree["totals"]["waitAsOf"], 100);
    assert!(matches!(
        reads(db, &never).scoped_tree("missing"),
        Err(WorkReadError::UnknownWork)
    ));
}

#[test]
fn live_runner_blocks_restart() {
    let (_dir, mut state) = seeded();
    let db = state.tasks.connection().unwrap();
    db.execute(
        "UPDATE tasks SET record=json_set(record,'$.runnerPid',42,'$.attempts',json('[]')) WHERE id=?",
        [CHILD],
    )
    .unwrap();
    let alive = |pid: &Value| pid == &json!(42);
    let tree = reads(db, &alive).scoped_tree(CHILD).unwrap();
    assert_eq!(
        tree["nodes"][0]["retryEligibility"]["reason"],
        "Previous executor is still active"
    );
    let never = |_: &Value| false;
    let tree = reads(db, &never).scoped_tree(CHILD).unwrap();
    assert_eq!(
        tree["nodes"][0]["retryEligibility"],
        json!({"allowed": true})
    );
}

#[test]
fn events_filter_to_visible_nodes_and_advance_the_cursor() {
    let (_dir, mut state) = seeded();
    let db = state.tasks.connection().unwrap();
    let never = |_: &Value| false;
    let events = reads(db, &never).scoped_events(CHILD, 0).unwrap();
    let kinds: Vec<_> = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["task_id"].clone())
        .collect();
    assert_eq!(kinds, [json!(CHILD), json!(GRANDCHILD)]);
    assert_eq!(events["events"][1]["data"], json!({"c": [1.5]}));
    assert_eq!(events["hasMore"], false);
    let root = reads(db, &never).scoped_events(ROOT, 0).unwrap();
    assert_eq!(root["events"][0]["data"]["a"].to_string(), "2");
    assert_eq!(root["events"][0]["at"], json!(5.25));
    let next = root["next"].as_i64().unwrap();
    let after = reads(db, &never).scoped_events(ROOT, next).unwrap();
    assert_eq!(after, json!({"events": [], "next": next, "hasMore": false}));
}

#[test]
fn list_pages_by_relation_and_state() {
    let (_dir, mut state) = seeded();
    let db = state.tasks.connection().unwrap();
    let never = |_: &Value| false;
    let filter = |relation, state, before, limit| WorkListFilter {
        relation,
        state,
        repo: "",
        before,
        limit,
    };
    let roots = reads(db, &never).list(&filter("roots", "", "", 1)).unwrap();
    assert_eq!(roots["tasks"][0]["id"], OTHER);
    assert_eq!(roots["tasks"][0]["state"], "needs_input");
    assert_eq!(roots["tasks"][0]["branch"], format!("pacer/{OTHER}"));
    assert_eq!(roots["tasks"][0]["tokens"], Value::Null);
    assert_eq!(roots["next"], OTHER);
    let page = reads(db, &never)
        .list(&filter("roots", "", OTHER, 50))
        .unwrap();
    assert_eq!(page["tasks"][0]["id"], ROOT);
    assert_eq!(page["next"], Value::Null);
    let children = reads(db, &never)
        .list(&filter("children", "failed", "", 50))
        .unwrap();
    let ids: Vec<_> = children["tasks"]
        .as_array()
        .unwrap()
        .iter()
        .map(|t| t["id"].clone())
        .collect();
    assert_eq!(ids, [json!(CHILD)]);
    assert_eq!(
        children["tasks"][0]["tokens"],
        json!({"total": 3, "lowerBound": false, "measuredAttempts": 1, "partialAttempts": 0})
    );
    let asking = reads(db, &never)
        .list(&filter("all", "needs_input", "", 50))
        .unwrap();
    assert_eq!(asking["tasks"].as_array().unwrap().len(), 1);
}

#[test]
fn head_branch_follows_linked_worktrees() {
    let dir = tempfile::tempdir().unwrap();
    let linked = dir.path().join("linked");
    let git = dir.path().join("git");
    std::fs::create_dir_all(&linked).unwrap();
    std::fs::create_dir_all(&git).unwrap();
    std::fs::write(linked.join(".git"), "junk\ngitdir:   ../git  \n").unwrap();
    std::fs::write(git.join("HEAD"), "ref: refs/heads/topic/x \n").unwrap();
    let path = json!(linked.to_str().unwrap());
    assert_eq!(head_branch(Some(&path)).as_deref(), Some("topic/x"));
    std::fs::write(git.join("HEAD"), "abc123\n").unwrap();
    assert_eq!(head_branch(Some(&path)), None);
    assert_eq!(
        head_branch(Some(&json!(dir.path().join("gone").to_str().unwrap()))),
        None
    );
    assert_eq!(head_branch(None), None);
}

#[test]
fn line_capture_matches_multiline_regex_semantics() {
    assert_eq!(
        line_capture("x\nref: refs/heads/main\n", "ref:", "refs/heads/").as_deref(),
        Some("main")
    );
    assert_eq!(
        line_capture("ref:refs/heads/a\u{2028}b", "ref:", "refs/heads/").as_deref(),
        Some("a")
    );
    assert_eq!(
        line_capture("ref:  refs/heads/", "ref:", "refs/heads/"),
        None
    );
    assert_eq!(
        line_capture(" ref: refs/heads/main", "ref:", "refs/heads/"),
        None
    );
    assert_eq!(
        line_capture("gitdir:\u{00a0}../x", "gitdir:", "").as_deref(),
        Some("../x")
    );
}

#[test]
fn node_style_paths() {
    assert_eq!(path_normalize("/a/./b/../c//d"), "/a/c/d");
    assert_eq!(path_normalize("../x/../.."), "../..");
    assert_eq!(path_join(&["/a", "../b", ".git"]), "/b/.git");
    assert_eq!(path_dirname("/a/b/.git"), "/a/b");
    assert_eq!(path_dirname("/"), "/");
    assert_eq!(path_resolve("/a/b", "../c"), "/a/c");
    assert_eq!(path_resolve("/a/b", "/abs"), "/abs");
}

#[test]
fn numbers_take_javascript_shapes() {
    assert_eq!(js_value(2.0), json!(2));
    assert_eq!(js_value(-0.0).to_string(), "0");
    assert_eq!(js_value(f64::NAN), Value::Null);
    assert_eq!(js_value(1.5), json!(1.5));
    let mut nested = json!({"a": [2.0, {"b": 3.0}]});
    js_numbers(&mut nested);
    assert_eq!(nested.to_string(), r#"{"a":[2,{"b":3}]}"#);
    assert_eq!(stringify(&json!(["a", null, 1.0])), r#"["a",null,1]"#);
}

#[test]
fn runner_ids_and_rollup_order() {
    assert_eq!(parse_runner_id("codex#team"), Some(("codex", Some("team"))));
    assert_eq!(parse_runner_id("codex"), Some(("codex", None)));
    assert_eq!(parse_runner_id("unknown#x"), None);
    let tokens = |total: i64| {
        json!({"coverage": "measured", "input": total, "cacheRead": 0, "cacheWrite": 0, "output": 0,
        "reasoning": null, "total": total, "turns": 1, "source": "executor-json", "selfReported": false})
    };
    let items = vec![
        TokenItem {
            executor: json!("b"),
            account: Value::Null,
            model: Value::Null,
            tokens: tokens(5),
        },
        TokenItem {
            executor: json!("a"),
            account: Value::Null,
            model: Value::Null,
            tokens: tokens(5),
        },
        TokenItem {
            executor: json!("c"),
            account: Value::Null,
            model: Value::Null,
            tokens: tokens(9),
        },
    ];
    let rollup = rollup_tokens(&items);
    let order: Vec<_> = rollup["byExecutor"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["agent"].clone())
        .collect();
    assert_eq!(order, [json!("c"), json!("a"), json!("b")]);
    assert_eq!(rollup["total"], 19);
    assert_eq!(rollup["lowerBound"], false);
}
