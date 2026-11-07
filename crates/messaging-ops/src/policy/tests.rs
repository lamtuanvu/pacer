#![allow(clippy::unwrap_used)]
use super::*;
use std::fs;

const TOP: &str = "t-20260101-000000-0001";
const A: &str = "t-20260101-000000-0002";
const B: &str = "t-20260101-000000-0003";
const USER: &str = "t-20260101-000000-0004";

fn task(id: &str, origin: &str) -> Value {
    json!({"id":id,"rev":1,"state":"done","createdAt":1,"updatedAt":1,"brief":{"goal":"g","repo":"/r"},
        "repo":{"key":"github.com/a/b"},"attempts":[],"origin":origin,"source":"cli"})
}

fn setup(yaml: &str) -> (tempfile::TempDir, TaskStore) {
    let dir = tempfile::tempdir().unwrap();
    fs::write(
        dir.path().join("strategy.yaml"),
        format!("planner: claude-code\nproviders: {{claude-code: {{}}, codex: {{}}}}\n{yaml}"),
    )
    .unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    store
        .insert(&task(TOP, "external:claude-code"), 1.0)
        .unwrap();
    store.insert(&task(A, "human"), 1.0).unwrap();
    store.insert(&task(B, "human"), 1.0).unwrap();
    store.insert(&task(USER, "human"), 1.0).unwrap();
    store.connection().unwrap().execute_batch(&format!(
        "CREATE TABLE work_nodes(task_id TEXT PRIMARY KEY, parent_id TEXT, root_id TEXT NOT NULL, depth INTEGER NOT NULL, options TEXT NOT NULL);
         INSERT INTO work_nodes VALUES('{A}','{TOP}','{TOP}',1,'{{}}'),('{B}','{TOP}','{TOP}',1,'{{}}');
         CREATE TABLE messages(id TEXT PRIMARY KEY, task_id TEXT NULL, root_id TEXT NOT NULL, sender TEXT NOT NULL, recipient TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, reply_to TEXT NULL, request_id TEXT NULL, status TEXT NOT NULL, created_at REAL NOT NULL, delivered_at REAL NULL, read_at REAL NULL, turn_id TEXT NULL, fingerprint TEXT NULL);"
    )).unwrap();
    (dir, store)
}

fn run(dir: &tempfile::TempDir, store: &mut TaskStore, from: &str, to: &str, grant: bool) -> Value {
    let send = Send {
        from,
        to,
        kind: "message",
        grant,
    };
    check(dir.path(), store, 100.0, &send).unwrap()
}

fn t(id: &str) -> String {
    format!("task:{id}")
}

#[test]
fn defaults_apply_without_a_strategy() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = TaskStore::open(dir.path()).unwrap();
    let policy = effective(dir.path(), &mut store, None).unwrap();
    assert_eq!(policy["config"], strategy::default_messaging_config());
    let layers: Vec<_> = policy["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["layer"].clone())
        .collect();
    assert_eq!(layers, vec![json!("default"); 6]);
    assert_eq!(
        serde_json::to_string(&policy["rules"][4]).unwrap(),
        r#"{"effect":"allow","from_position":"child","relation":["sibling","child"],"grant":"required","layer":"default"}"#
    );
}

#[test]
fn default_guardrail_relations() {
    let (dir, mut store) = setup("");
    let decide = |store: &mut TaskStore, from: &str, to: &str, grant: bool| {
        let r = run(&dir, store, from, to, grant);
        r["decision"].as_str().unwrap().to_owned() + "/" + r["rule"].to_string().as_str()
    };
    assert_eq!(
        decide(&mut store, "external:claude-code", &t(TOP), false),
        "allow/2"
    );
    assert_eq!(decide(&mut store, &t(A), &t(TOP), false), "allow/3");
    assert_eq!(decide(&mut store, &t(A), &t(B), true), "allow/4");
    assert_eq!(
        decide(&mut store, "external:claude-code", &t(USER), false),
        "allow/2"
    );
    assert_eq!(decide(&mut store, "human", &t(A), false), "allow/0");
    assert_eq!(decide(&mut store, &t(A), "human", false), "allow/1");
    let sibling = run(&dir, &mut store, &t(A), &t(B), false);
    assert_eq!(
        sibling["error"]["message"],
        format!(
            "Messaging from task:{A} to task:{B} (sibling) is not allowed: no rule matched; rule 4 (default) allows it with a work grant"
        )
    );
    assert_eq!(
        serde_json::to_string(&sibling["error"]["data"]).unwrap(),
        r#"{"reason":"msg_forbidden","layer":"none","relation":"sibling","closest":{"rule":4,"layer":"default","grant":"required"}}"#
    );
    let unrelated = run(&dir, &mut store, &t(A), &t(USER), false);
    assert!(unrelated["error"]["data"].get("closest").is_none());
    let missing = run(
        &dir,
        &mut store,
        "human",
        "task:t-20990101-000000-ffff",
        false,
    );
    assert_eq!(
        missing,
        json!({"decision":"deny","error":{"code":"not_found","message":"Unknown participant task:t-20990101-000000-ffff"}})
    );
}

#[test]
fn layers_merge_strategy_project_and_tree() {
    let (dir, mut store) = setup(
        "messaging:\n  defaults: false\n  rules:\n    - {relation: [top_peer], effect: deny}\n",
    );
    fs::write(
        dir.path().join("project-messaging.json"),
        r#"{"version":1,"projects":{"github.com/a/b":{"rev":1,"rules":[{"effect":"allow","kinds":["report"]}],"max_turns":7,"liveness":{"max_nudges":1}}}}"#,
    )
    .unwrap();
    store
        .update(TOP, 1, 2.0, |top| {
            top["messaging"] = json!({"rules":[{"effect":"allow","from_position":"child","relation":["parent"],"limits":{"confirm":true,"per_minute":1}}],"max_turns":9.0});
        })
        .unwrap();
    let policy = effective(dir.path(), &mut store, Some(&t(TOP))).unwrap();
    let layers: Vec<_> = policy["rules"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["layer"].clone())
        .collect();
    assert_eq!(layers, [json!("tree"), json!("project"), json!("global")]);
    assert_eq!(
        serde_json::to_string(&policy["rules"][2]).unwrap(),
        r#"{"effect":"deny","relation":["top_peer"],"layer":"global"}"#
    );
    assert_eq!(policy["config"]["tree"]["max_turns"], json!(9));
    assert_eq!(policy["config"]["liveness"]["max_nudges"], json!(1));
    assert_eq!(
        policy["config"]["rules"][0],
        json!({"effect":"deny","relation":["top_peer"]})
    );
    let held = run(&dir, &mut store, &t(A), &t(TOP), false);
    assert_eq!(
        held,
        json!({"decision":"allow","hold":true,"rule":0,"layer":"tree"})
    );
    let denied = run(
        &dir,
        &mut store,
        "external:claude-code",
        "external:other",
        false,
    );
    assert_eq!(
        denied["error"]["data"],
        json!({"reason":"msg_forbidden","layer":"global","rule":0,"relation":"top_peer"})
    );
    store.connection().unwrap().execute(
        "INSERT INTO messages(id,root_id,sender,recipient,kind,body,status,created_at) VALUES('m','r',?,'x','message','b','pending',50)",
        [t(A)],
    ).unwrap();
    let capped = run(&dir, &mut store, &t(A), &t(TOP), false);
    assert_eq!(
        capped,
        json!({"decision":"deny","error":{"code":"conflict","message":"Message rate limit reached","data":{"reason":"msg_cap_reached","limit":"per_minute"}}})
    );
}
