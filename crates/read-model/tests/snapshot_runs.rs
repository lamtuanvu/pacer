#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_foundation::Ctx;
use pacer_read_model::runs::{letter_at, snapshot_runs};
use serde_json::json;
use std::collections::HashMap;

fn ctx() -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().expect("tempdir");
    let home = dir.path().join("home");
    let pacer = dir.path().join("pacer");
    std::fs::create_dir_all(pacer.join("state")).expect("state");
    let ctx = Ctx::with(home, pacer, HashMap::new(), 1_700_000_000.0);
    (dir, ctx)
}

fn open(ctx: &Ctx) -> rusqlite::Connection {
    rusqlite::Connection::open(ctx.pacer_home.join("state/tasks.db")).expect("db")
}

#[test]
fn missing_tables_yield_empty_runs() {
    let (_dir, ctx) = ctx();
    assert!(snapshot_runs(&ctx).is_empty());
}

#[test]
fn letters_beyond_z_and_waits_on_cases() {
    let (_dir, ctx) = ctx();
    let db = open(&ctx);
    db.execute_batch(
        "CREATE TABLE workflow_runs(
           id TEXT PRIMARY KEY, workflow TEXT, version INTEGER, repo TEXT, brief TEXT, title TEXT,
           status TEXT, reason TEXT, loops TEXT, rev INTEGER, created_at REAL, updated_at REAL,
           priority TEXT, paused_reason TEXT, letter TEXT, orchestrator_state TEXT,
           planner TEXT, pending_planner TEXT, next_wake_at REAL
         );
         CREATE TABLE workflow_steps(
           run_id TEXT, step_id TEXT, attempt INTEGER, branch TEXT, task_id TEXT,
           status TEXT, result TEXT, error TEXT, started_at REAL, ended_at REAL,
           PRIMARY KEY(run_id, step_id, attempt, branch)
         );
         CREATE TABLE workflow_questions(
           id TEXT PRIMARY KEY, run_id TEXT, step_id TEXT, attempt INTEGER, branch TEXT,
           asker_task_id TEXT, asker_kind TEXT, text TEXT, answer_type TEXT, options TEXT,
           recommended TEXT, blocks TEXT, artifact TEXT, answerer TEXT, chain TEXT,
           suggested TEXT, answer TEXT, answered_by TEXT, status TEXT, rev INTEGER,
           created_at REAL, answered_at REAL
         );
         CREATE TABLE tasks(id TEXT PRIMARY KEY, record TEXT);",
    )
    .unwrap();

    for i in 0..27 {
        let letter = letter_at(i);
        let priority = if i == 1 {
            "urgent"
        } else if i == 2 {
            "background"
        } else {
            "normal"
        };
        let title = if i == 0 { "你好 🎉" } else { "Run" };
        db.execute(
            "INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at, priority, letter)
             VALUES (?1, 't/flow', 1, '/tmp', 'b', ?2, 'running', NULL, '{}', 1, ?3, ?3, ?4, ?5)",
            rusqlite::params![format!("run_{i:02}"), title, 1_700_000_000.0 + i as f64, priority, letter],
        )
        .unwrap();
    }
    // person question → you
    db.execute(
        "INSERT INTO workflow_questions(
           id, run_id, step_id, attempt, branch, asker_task_id, asker_kind, text, answer_type,
           options, recommended, blocks, artifact, answerer, chain, suggested, answer, answered_by,
           status, rev, created_at, answered_at
         ) VALUES ('q1', 'run_00', 'ask', 1, NULL, 't', 'executor', 'Pick?', 'text',
           NULL, NULL, 'step', NULL, 'person', '[]', NULL, NULL, NULL, 'open', 1, 1, NULL)",
        [],
    )
    .unwrap();
    // planner via blocked
    db.execute(
        "UPDATE workflow_runs SET orchestrator_state = 'blocked' WHERE id = 'run_03'",
        [],
    )
    .unwrap();
    // waiting step no task → planner
    db.execute(
        "INSERT INTO workflow_steps(run_id, step_id, attempt, branch, task_id, status, result, error, started_at, ended_at)
         VALUES ('run_04', 'gen', 1, '', NULL, 'waiting', NULL, NULL, 1, NULL)",
        [],
    )
    .unwrap();
    // executor work
    db.execute(
        "INSERT INTO tasks(id, record) VALUES ('t-code', '{\"kind\":\"code\"}')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO workflow_steps(run_id, step_id, attempt, branch, task_id, status, result, error, started_at, ended_at)
         VALUES ('run_05', 'code', 1, '', 't-code', 'running', NULL, NULL, 1, NULL)",
        [],
    )
    .unwrap();
    // hidden kinds
    db.execute(
        "INSERT INTO tasks(id, record) VALUES ('t-root', '{\"kind\":\"workflow-root\"}'), ('t-orch', '{\"kind\":\"orchestrate\"}')",
        [],
    )
    .unwrap();
    db.execute(
        "INSERT INTO workflow_steps(run_id, step_id, attempt, branch, task_id, status, result, error, started_at, ended_at)
         VALUES ('run_05', 'wfroot', 1, '', 't-root', 'running', NULL, NULL, 1, NULL),
                ('run_05', 'orch', 1, '', 't-orch', 'done', NULL, NULL, 1, NULL)",
        [],
    )
    .unwrap();
    db.execute(
        "UPDATE workflow_runs SET paused_reason = 'pacing: strict' WHERE id = 'run_06'",
        [],
    )
    .unwrap();

    let runs = snapshot_runs(&ctx);
    assert_eq!(runs.len(), 27);
    let by_id: HashMap<_, _> = runs
        .iter()
        .map(|r| (r["id"].as_str().unwrap().to_string(), r.clone()))
        .collect();
    assert_eq!(by_id["run_00"]["title"], json!("你好 🎉"));
    assert_eq!(by_id["run_00"]["waits_on"], json!("you"));
    assert_eq!(by_id["run_03"]["waits_on"], json!("planner"));
    assert_eq!(by_id["run_04"]["waits_on"], json!("planner"));
    assert_eq!(by_id["run_05"]["waits_on"], json!("executors"));
    assert_eq!(
        by_id["run_05"]["steps"],
        json!({"running":1,"waiting":0,"done":0,"failed":0})
    );
    assert_eq!(by_id["run_06"]["paused_reason"], json!("pacing: strict"));
    assert_eq!(by_id["run_07"]["waits_on"], json!("nothing"));

    let letters: Vec<_> = runs
        .iter()
        .map(|r| r["letter"].as_str().unwrap().to_string())
        .collect();
    let mut sorted = letters.clone();
    sorted.sort_by(|a, b| a.len().cmp(&b.len()).then(a.cmp(b)));
    let expected: Vec<_> = (0..27).map(letter_at).collect();
    assert_eq!(sorted, expected);

    // urgent before background in attention order
    let urgent = runs.iter().position(|r| r["id"] == "run_01").unwrap();
    let background = runs.iter().position(|r| r["id"] == "run_02").unwrap();
    assert!(urgent < background);
}

#[test]
fn ranking_prefers_priority_then_unblocks() {
    let (_dir, ctx) = ctx();
    // Use attention module sort indirectly via run_question_items after seeding.
    let db = open(&ctx);
    db.execute_batch(
        "CREATE TABLE workflow_runs(
           id TEXT PRIMARY KEY, workflow TEXT, version INTEGER, repo TEXT, brief TEXT, title TEXT,
           status TEXT, reason TEXT, loops TEXT, rev INTEGER, created_at REAL, updated_at REAL,
           priority TEXT, letter TEXT
         );
         CREATE TABLE workflow_questions(
           id TEXT PRIMARY KEY, run_id TEXT, step_id TEXT, attempt INTEGER, branch TEXT,
           asker_task_id TEXT, asker_kind TEXT, text TEXT, answer_type TEXT, options TEXT,
           recommended TEXT, blocks TEXT, artifact TEXT, answerer TEXT, chain TEXT,
           suggested TEXT, answer TEXT, answered_by TEXT, status TEXT, rev INTEGER,
           created_at REAL, answered_at REAL
         );",
    )
    .unwrap();
    for (id, prio, letter, at) in [
        ("run_bg", "background", "B", 10.0),
        ("run_urgent", "urgent", "A", 10.0),
    ] {
        db.execute(
            "INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at, priority, letter)
             VALUES (?1, 't', 1, '/tmp', 'b', 'T', 'running', NULL, '{}', 1, ?2, ?2, ?3, ?4)",
            rusqlite::params![id, at, prio, letter],
        )
        .unwrap();
        db.execute(
            "INSERT INTO workflow_questions(
               id, run_id, step_id, attempt, branch, asker_task_id, asker_kind, text, answer_type,
               options, recommended, blocks, artifact, answerer, chain, suggested, answer, answered_by,
               status, rev, created_at, answered_at
             ) VALUES (?1, ?2, 'ask', 1, NULL, 't', 'executor', 'Q', 'text',
               NULL, NULL, 'step', NULL, 'person', '[]', NULL, NULL, NULL, 'open', 1, ?3, NULL)",
            rusqlite::params![format!("q_{id}"), id, at],
        )
        .unwrap();
    }
    let items = pacer_read_model::attention::run_question_items(&ctx);
    assert_eq!(items[0]["run"]["priority"], json!("urgent"));
    assert_eq!(items[1]["run"]["priority"], json!("background"));
}
