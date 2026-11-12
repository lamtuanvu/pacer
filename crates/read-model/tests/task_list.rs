#![allow(clippy::unwrap_used)]
use pacer_foundation::{Ctx, fsutil::write_json_atomic};
use pacer_read_model::{
    ActiveCounts, ActiveSession,
    tasks::{
        TaskListOptions, api_task_page, api_tasks, select_task_list, task_list_page,
        visible_task_state,
    },
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
    // Empty registry: page-only repos expose the apiTasks vs apiTaskPage label scope.
    write_json_atomic(&home.join("state/repos.json"), &json!({})).unwrap();
    let ctx = Ctx::with(home.clone(), home.clone(), HashMap::new(), 1_000.0);
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

fn task(id: &str, state: &str, created: f64, repo_key: &str, path: &str) -> Value {
    json!({
        "id": id,
        "rev": 1,
        "state": state,
        "createdAt": created,
        "title": id,
        "brief": {"goal": format!("goal for {id}"), "repo": path},
        "repo": {"key": repo_key, "path": path, "label": "acme/api"},
        "attempts": [],
        "kind": null,
        "requestedExecutor": "codex"
    })
}

#[test]
fn select_task_list_applies_the_query_filter() {
    let (_dir, ctx) = home();
    let older = task("t-20261101-000000-d90f", "done", 10.0, "repo-a", "/repo-a");
    let newer = task("t-20261101-000001-e11f", "done", 20.0, "repo-a", "/repo-a");
    write_task(&ctx, &older);
    write_task(&ctx, &newer);
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let mut hits = |query: &str| -> Vec<String> {
        select_task_list(
            &ctx,
            &mut store,
            &TaskListOptions {
                query: Some(query),
                limit: Some(10),
                ..TaskListOptions::default()
            },
        )
        .unwrap()
        .iter()
        .map(|row| row["id"].as_str().unwrap().to_owned())
        .collect()
    };
    // The short suffix and full ids match, and newest first across a shared goal word.
    assert_eq!(hits("D90F"), vec!["t-20261101-000000-d90f"]);
    assert_eq!(
        hits("goal for"),
        vec!["t-20261101-000001-e11f", "t-20261101-000000-d90f"]
    );
    // Every word must appear, so no row satisfies both suffixes.
    assert_eq!(hits("d90f e11f"), Vec::<String>::new());
}

#[test]
fn visible_state_promotes_unanswered_running_question() {
    let running = json!({"state":"running","question":{"text":"q","at":1}});
    assert_eq!(visible_task_state(&running), "needs_input");
    let answered = json!({"state":"running","question":{"text":"q","at":1,"answer":"a"}});
    assert_eq!(visible_task_state(&answered), "running");
    let done = json!({"state":"done"});
    assert_eq!(visible_task_state(&done), "done");
}

#[test]
fn api_task_page_keeps_per_task_label_scope_unlike_api_tasks() {
    let (_dir, ctx) = home();
    // Unregistered page peers with the same short label collide only when batched together.
    let a = task(
        "t-20260101-000001-aaaa",
        "done",
        10.0,
        "github.com/acme/api",
        "/work/github/acme/api",
    );
    let b = task(
        "t-20260101-000002-bbbb",
        "done",
        20.0,
        "gitlab.com/acme/api",
        "/work/gitlab/acme/api",
    );
    write_task(&ctx, &a);
    write_task(&ctx, &b);
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let active = ActiveCounts::default();
    let page = api_task_page(&ctx, &active, &[a.clone(), b.clone()], &mut store, &alive).unwrap();
    // Each row only collides against registered repos + itself, so both keep the short label.
    assert_eq!(page[0]["repo"]["label"], "acme/api");
    assert_eq!(page[1]["repo"]["label"], "acme/api");
    let batched = api_tasks(&ctx, &active, &[a, b], &mut store, &alive).unwrap();
    assert_eq!(batched[0]["repo"]["label"], "github.com/acme/api");
    assert_eq!(batched[1]["repo"]["label"], "gitlab.com/acme/api");
}

#[test]
fn select_and_page_filter_before_limit_and_fold_sessions() {
    let (_dir, ctx) = home();
    let newer = task(
        "t-20260101-000003-cccc",
        "done",
        30.0,
        "github.com/acme/api",
        "/repo-a",
    );
    let asking = {
        let mut t = task(
            "t-20260101-000002-bbbb",
            "running",
            20.0,
            "github.com/acme/api",
            "/repo-a",
        );
        t["question"] = json!({"text":"need input","at":21});
        t["executor"] = json!("codex");
        t
    };
    let older = task(
        "t-20260101-000001-aaaa",
        "done",
        10.0,
        "gitlab.com/acme/api",
        "/repo-b",
    );
    for t in [&newer, &asking, &older] {
        write_task(&ctx, t);
    }
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    let needs = select_task_list(
        &ctx,
        &mut store,
        &TaskListOptions {
            states: Some(&["needs_input"]),
            limit: Some(10),
            ..TaskListOptions::default()
        },
    )
    .unwrap();
    assert_eq!(needs.len(), 1);
    assert_eq!(needs[0]["id"], "t-20260101-000002-bbbb");

    let active = ActiveCounts::from_sessions(&[
        ActiveSession {
            task_id: "t-20260101-000003-cccc".into(),
            executor: "codex".into(),
        },
        ActiveSession {
            task_id: "t-20260101-000003-cccc".into(),
            executor: "claude".into(),
        },
    ]);
    let page = task_list_page(
        &ctx,
        &active,
        &mut store,
        &TaskListOptions {
            limit: Some(2),
            ..TaskListOptions::default()
        },
        &alive,
    )
    .unwrap();
    assert_eq!(page["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(page["next"], "t-20260101-000002-bbbb");
    assert_eq!(page["tasks"][0]["id"], "t-20260101-000003-cccc");
    assert_eq!(page["tasks"][0]["activeAgentSessions"], 2);
    assert_eq!(page["tasks"][1]["state"], "needs_input");
    assert!(page["tasks"][1].get("activeAgentSessions").is_none());

    let filtered = task_list_page(
        &ctx,
        &ActiveCounts::default(),
        &mut store,
        &TaskListOptions {
            repo: Some("gitlab.com/acme/api"),
            limit: Some(5),
            ..TaskListOptions::default()
        },
        &alive,
    )
    .unwrap();
    assert_eq!(filtered["tasks"].as_array().unwrap().len(), 1);
    assert_eq!(filtered["tasks"][0]["id"], "t-20260101-000001-aaaa");
    assert!(filtered["next"].is_null());
}

#[test]
fn history_page_decodes_only_limit_plus_one_rows() {
    let (_dir, ctx) = home();
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    for n in 0..1000 {
        let t = task(
            &format!("t-20261101-000000-{n:04x}"),
            "done",
            n as f64,
            "repo-a",
            "/repo-a",
        );
        store.insert(&t, 2000.0).unwrap();
    }
    // A corrupt older record must not be decoded when selecting the first page.
    store
        .connection()
        .unwrap()
        .execute(
            "UPDATE tasks SET record='{' WHERE id='t-20261101-000000-0000'",
            [],
        )
        .unwrap();
    let page = task_list_page(
        &ctx,
        &ActiveCounts::default(),
        &mut store,
        &TaskListOptions {
            limit: Some(2),
            ..TaskListOptions::default()
        },
        &alive,
    )
    .unwrap();
    assert_eq!(page["tasks"].as_array().unwrap().len(), 2);
    assert_eq!(page["next"], "t-20261101-000000-03e6");
}

#[test]
fn sql_history_resolves_legacy_registry_alias_and_local_repos() {
    let (_dir, ctx) = home();
    write_json_atomic(
        &ctx.pacer_home.join("state/repos.json"),
        &json!({
            "/checkout":{"key":"github.com/acme/api","path":"/checkout"},
            "/checkout/nested":{"key":"github.com/acme/nested","path":"/checkout/nested"}
        }),
    )
    .unwrap();
    write_json_atomic(
        &ctx.pacer_home.join("state/repo-paths.json"),
        &json!({"/alias":"/checkout"}),
    )
    .unwrap();
    let mut store = TaskStore::open(&ctx.pacer_home).unwrap();
    for (n, path) in [
        "/checkout/sub",
        "/checkout/nested/sub",
        "/alias/sub",
        "/unregistered",
    ]
    .iter()
    .enumerate()
    {
        let mut t = task(
            &format!("t-20261101-000000-{n:04x}"),
            "done",
            10.0,
            "unused",
            path,
        );
        t.as_object_mut().unwrap().remove("repo");
        store.insert(&t, 10.0).unwrap();
    }
    let options = TaskListOptions {
        repo: Some("github.com/acme/api"),
        limit: Some(1),
        ..TaskListOptions::default()
    };
    let page =
        task_list_page(&ctx, &ActiveCounts::default(), &mut store, &options, &alive).unwrap();
    assert_eq!(page["tasks"][0]["id"], "t-20261101-000000-0002");
    assert_eq!(page["next"], "t-20261101-000000-0002");
    let page = task_list_page(
        &ctx,
        &ActiveCounts::default(),
        &mut store,
        &TaskListOptions {
            before: Some("t-20261101-000000-0002"),
            ..options
        },
        &alive,
    )
    .unwrap();
    assert_eq!(page["tasks"][0]["id"], "t-20261101-000000-0000");
    assert!(page["next"].is_null());
    let unfiltered = task_list_page(
        &ctx,
        &ActiveCounts::default(),
        &mut store,
        &TaskListOptions::default(),
        &alive,
    )
    .unwrap();
    let key = unfiltered["tasks"][0]["repo"]["key"].as_str().unwrap();
    let local = select_task_list(
        &ctx,
        &mut store,
        &TaskListOptions {
            repo: Some(key),
            ..TaskListOptions::default()
        },
    )
    .unwrap();
    assert_eq!(local.len(), 1);
    assert_eq!(local[0]["brief"]["repo"], "/unregistered");
}
