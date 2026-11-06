#![allow(clippy::unwrap_used)]
use pacer_foundation::{Ctx, fsutil::write_json_atomic};
use pacer_read_model::{
    ActiveCounts,
    task_detail::{executor_cost, task_detail_by_id, timeline_store},
};
use pacer_store::TaskStore;
use serde_json::{Value, json};
use std::{collections::HashMap, fs};

fn alive(_: i64) -> bool {
    true
}

fn home() -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().unwrap();
    let home = dir.path().to_path_buf();
    fs::create_dir_all(home.join("state")).unwrap();
    fs::create_dir_all(home.join("tasks")).unwrap();
    write_json_atomic(&home.join("state/repos.json"), &json!({})).unwrap();
    let ctx = Ctx::with(home.clone(), home.clone(), HashMap::new(), 100.0);
    (dir, ctx)
}

fn write_task(ctx: &Ctx, task: &Value) {
    write_json_atomic(
        &ctx.pacer_home
            .join("tasks")
            .join(format!("{}.json", task["id"].as_str().unwrap())),
        task,
    )
    .unwrap();
}

#[test]
fn executor_cost_matches_shared_and_comparable_readings() {
    let usage = |pct: f64| json!({"account": "team", "usedPct": pct, "window": "week", "at": 1.0});
    let done = json!({
        "id": "t-done",
        "state": "done",
        "createdAt": 0.0,
        "attempts": [{
            "startedAt": 10.0,
            "endedAt": 20.0,
            "usageAtStart": usage(3.0),
            "usageAtEnd": usage(4.2),
        }],
    });
    let overlap = json!({
        "id": "t-overlap",
        "state": "done",
        "createdAt": 0.0,
        "attempts": [{
            "startedAt": 11.0,
            "endedAt": 15.0,
            "usageAtStart": usage(1.0),
            "usageAtEnd": usage(2.0),
        }],
    });
    let cost = executor_cost(&done, &[overlap], 100.0);
    assert_eq!(cost["executor"]["deltaPct"], Value::Null);
    assert_eq!(cost["executor"]["reason"], "shared");

    let disjoint = json!({
        "id": "t-disjoint",
        "state": "done",
        "createdAt": 0.0,
        "attempts": [{
            "startedAt": 21.0,
            "endedAt": 30.0,
            "usageAtStart": usage(1.0),
            "usageAtEnd": usage(2.0),
        }],
    });
    let cost = executor_cost(&done, &[disjoint], 100.0);
    assert_eq!(cost["executor"]["deltaPct"], json!(1.2));
}

#[test]
fn timeline_store_orders_routing_and_terminal_state() {
    let task = json!({
        "id": "t-1",
        "state": "done",
        "createdAt": 1.0,
        "baseBranch": "main",
        "worktree": "/tmp/wt",
        "attempts": [{
            "startedAt": 2.0,
            "endedAt": 8.0,
            "routing": {"chosen": "codex", "why": "on pace"},
        }],
        "progress": {"phase": "testing", "updatedAt": 6.0, "commits": 2.0, "lastChangeAt": 5.0},
    });
    let timeline = timeline_store(&task);
    assert!(
        timeline.first().unwrap()["text"]
            .as_str()
            .unwrap()
            .starts_with("Routed to Codex")
    );
    assert_eq!(timeline.last().unwrap()["text"], "done");
}

#[test]
fn task_detail_by_id_composes_api_slice_and_derived_markers() {
    let (_dir, ctx) = home();
    let task = json!({
        "id": "t-20260101-000001-aaaa",
        "rev": 2,
        "state": "done",
        "createdAt": 1.0,
        "title": "Title",
        "brief": {"goal": "Add tests", "repo": "/repo", "acceptance": "bun test"},
        "attempts": [{
            "executor": "codex",
            "startedAt": 2.0,
            "endedAt": 8.0,
            "log": "output",
            "routing": {"chosen": "codex", "why": "on pace"},
            "usageAtStart": {"account": "team", "usedPct": 1.0, "window": "week", "at": 2.0},
            "usageAtEnd": {"account": "team", "usedPct": 2.0, "window": "week", "at": 8.0},
        }],
        "baseBranch": "main",
        "run": {"mode": "new"},
        "result": {
            "report": "Added tests",
            "acceptance": {"cmd": "bun test", "passed": true, "tail": "ok", "summary": "ok", "durationS": 1.0},
        },
    });
    write_task(&ctx, &task);
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let detail = task_detail_by_id(
        &ctx,
        &ActiveCounts::default(),
        &mut store,
        "t-20260101-000001-aaaa",
        &alive,
        false,
    )
    .unwrap();
    assert_eq!(detail["id"], task["id"]);
    assert_eq!(detail["summary"], "Added tests");
    assert_eq!(detail["acceptance"]["state"], "passed");
    assert_eq!(detail["branch"], "pacer/t-20260101-000001-aaaa");
    assert_eq!(detail["derived"]["files"], "unavailable");
    assert_eq!(detail["derived"]["timeline"], "partial");
    assert!(detail["retryOptions"].as_array().unwrap().is_empty());
}
