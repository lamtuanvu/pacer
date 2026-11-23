#![allow(clippy::unwrap_used, clippy::expect_used)]
use pacer_foundation::Ctx;
use pacer_read_model::{attention, events::to_v2_event, js::*, v2_compat};
use serde_json::{Value, json};
use std::collections::HashMap;

fn ctx() -> (tempfile::TempDir, Ctx) {
    let dir = tempfile::tempdir().expect("tempdir");
    let home = dir.path().join("home");
    let pacer = dir.path().join("pacer");
    std::fs::create_dir_all(pacer.join("state")).expect("state");
    let ctx = Ctx::with(home, pacer, HashMap::new(), 1_700_000_000.0);
    (dir, ctx)
}

fn seed_question(ctx: &Ctx, run_id: &str, q_id: &str, blocks: &str, created_at: f64, text: &str) {
    seed_question_for_asker(ctx, run_id, q_id, blocks, created_at, text, "t-ask");
}

fn seed_question_for_asker(
    ctx: &Ctx,
    run_id: &str,
    q_id: &str,
    blocks: &str,
    created_at: f64,
    text: &str,
    asker_task_id: &str,
) {
    let path = ctx.pacer_home.join("state/tasks.db");
    let db = rusqlite::Connection::open(&path).expect("open db");
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS workflow_runs(
           id TEXT PRIMARY KEY, workflow TEXT, version INTEGER, repo TEXT, brief TEXT, title TEXT,
           status TEXT, reason TEXT, loops TEXT, rev INTEGER, created_at REAL, updated_at REAL
         );
         CREATE TABLE IF NOT EXISTS workflow_questions(
           id TEXT PRIMARY KEY, run_id TEXT, step_id TEXT, attempt INTEGER, branch TEXT,
           asker_task_id TEXT, asker_kind TEXT, text TEXT, answer_type TEXT, options TEXT,
           recommended TEXT, blocks TEXT, artifact TEXT, answerer TEXT, chain TEXT,
           suggested TEXT, answer TEXT, answered_by TEXT, status TEXT, rev INTEGER,
           created_at REAL, answered_at REAL
         );",
    )
    .expect("ddl");
    db.execute(
        "INSERT OR IGNORE INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at)
         VALUES (?1, 't/attn', 1, '/tmp', 'B', 'Ship?', 'running', NULL, '{}', 1, ?2, ?2)",
        rusqlite::params![run_id, created_at],
    )
    .expect("run");
    db.execute(
        "INSERT INTO workflow_questions(
           id, run_id, step_id, attempt, branch, asker_task_id, asker_kind, text, answer_type,
           options, recommended, blocks, artifact, answerer, chain, suggested, answer, answered_by,
           status, rev, created_at, answered_at
         ) VALUES (?1, ?2, 'ask', 1, NULL, ?7, 'executor', ?3, 'single',
           ?4, 'a', ?5, NULL, 'person', '[]', NULL, NULL, NULL, 'open', 1, ?6, NULL)",
        rusqlite::params![
            q_id,
            run_id,
            text,
            r#"[{"value":"a"},{"value":"b"}]"#,
            blocks,
            created_at,
            asker_task_id
        ],
    )
    .expect("question");
}

#[test]
fn missing_tables_yield_no_run_question_items() {
    let (_dir, ctx) = ctx();
    assert!(attention::run_question_items(&ctx).is_empty());
}

#[test]
fn run_question_item_shape_matches_typescript() {
    let (_dir, ctx) = ctx();
    seed_question(
        &ctx,
        "run_abcdefghij",
        "q_abcdefghij",
        "step",
        1_700_000_000.0 - 10.0,
        "Ship?",
    );
    let items = attention::run_question_items(&ctx);
    assert_eq!(items.len(), 1);
    let item = &items[0];
    assert_eq!(text(&item["id"]), "question:q_abcdefghij");
    assert_eq!(text(&item["kind"]), "question");
    assert_eq!(text(&item["severity"]), "blocked");
    assert_eq!(text(&item["unblocks"]), "run");
    assert_eq!(text(&item["run"]["id"]), "run_abcdefghij");
    assert_eq!(
        text(&item["run"]["letter"]),
        attention::run_attention_letter("run_abcdefghij")
    );
    assert_eq!(text(&item["run"]["priority"]), "normal");
    assert_eq!(text(&item["question"]["id"]), "q_abcdefghij");
    assert_eq!(text(&item["question"]["answerType"]), "single");
    assert_eq!(text(&item["actions"][0]["op"]), "question.answer");
    assert_eq!(text(&item["actions"][0]["label"]), "a");
    assert_eq!(text(&item["actions"][0]["params"]["answer"]), "a");
    // UI-1: title is the question; detail opens with the first-button cue + run title.
    assert_eq!(text(&item["title"]), "Ship?");
    assert!(text(&item["detail"]).starts_with("The first button answers \"a\"."));
    assert!(text(&item["detail"]).contains("Ship?."));
    assert!(text(&item["detail"]).contains("Asked by a step."));
    assert!(text(&item["detail"]).contains("Options: a / b."));
    assert!(v2_compat::is_workflow_attention_item(item));
}

#[test]
fn ranking_prefers_run_over_branch_over_nothing_then_age() {
    let (_dir, ctx) = ctx();
    seed_question(
        &ctx,
        "run_aaaaaaa1",
        "q_nothingxx1",
        "nothing",
        1_699_999_970.0,
        "Info",
    );
    seed_question(
        &ctx,
        "run_aaaaaaa2",
        "q_branchxxx2",
        "branch",
        1_699_999_990.0,
        "Branch",
    );
    seed_question(
        &ctx,
        "run_aaaaaaa3",
        "q_runxxxxxx3",
        "step",
        1_699_999_995.0,
        "Run",
    );
    seed_question(
        &ctx,
        "run_aaaaaaa4",
        "q_olderrunx4",
        "step",
        1_699_999_980.0,
        "Older",
    );
    let ids: Vec<String> = attention::run_question_items(&ctx)
        .into_iter()
        .map(|i| text(&i["id"]).to_string())
        .collect();
    assert_eq!(
        ids,
        vec![
            "question:q_olderrunx4",
            "question:q_runxxxxxx3",
            "question:q_branchxxx2",
            "question:q_nothingxx1",
        ]
    );
}

#[test]
fn question_entity_events_are_v3_only() {
    let event = json!({
        "seq": number(3_000_000_000_001.0),
        "at": 1791633600,
        "type": "question",
        "data": {"id":"q_abcdefghij","text":"Ship?","status":"open"}
    });
    assert_eq!(to_v2_event(&event), None);
    assert!(v2_compat::event(&event, None).is_null());
}

#[test]
fn letter_matches_resolve_run_letters() {
    // Lone letterless id → "A" (same as TS resolveRunLetters / attentionLetterForRun).
    assert_eq!(attention::run_attention_letter("run_abcdefghij"), "A");
}

#[test]
fn wire_json_is_stable() {
    let (_dir, ctx) = ctx();
    seed_question(
        &ctx,
        "run_abcdefghij",
        "q_abcdefghij",
        "step",
        1_699_999_990.0,
        "Ship?",
    );
    let item = &attention::run_question_items(&ctx)[0];
    let wire = stringify(item);
    let parsed: Value = serde_json::from_str(&wire).expect("parse");
    assert_eq!(&parsed, item);
}

#[test]
fn r2_i3_suppresses_ordinary_question_item_for_open_structured_asker() {
    let (_dir, ctx) = ctx();
    seed_question_for_asker(
        &ctx,
        "run_abcdefghij",
        "q_abcdefghij",
        "step",
        1_700_000_000.0 - 10.0,
        "Ship?",
        "t-ask",
    );
    let asker = json!({
        "id":"t-ask","title":"Asker","state":"needs_input","rev":1,"updatedAt":1_700_000_000.0,
        "executor":"codex","question":{"text":"Ship?","at":1_700_000_000.0 - 10.0}
    });
    let other = json!({
        "id":"t-other","title":"Other","state":"needs_input","rev":1,"updatedAt":1_700_000_000.0,
        "executor":"codex","question":{"text":"plain?","at":1_700_000_000.0 - 5.0}
    });
    let items = attention::raised(
        &ctx,
        &[asker, other],
        &[],
        &[],
        &json!({"items":[]}),
        &Value::Null,
        false,
    );
    let ids: Vec<&str> = items.iter().map(|i| text(&i["id"])).collect();
    assert!(
        ids.contains(&"question:q_abcdefghij"),
        "structured run question present: {ids:?}"
    );
    assert!(
        !ids.contains(&"question:t-ask"),
        "ordinary asker item suppressed: {ids:?}"
    );
    assert!(
        ids.contains(&"question:t-other"),
        "unrelated ordinary item kept: {ids:?}"
    );
}

#[test]
fn i4_blocks_nothing_orchestrator_does_not_suppress_ordinary_item() {
    let (_dir, ctx) = ctx();
    let path = ctx.pacer_home.join("state/tasks.db");
    let db = rusqlite::Connection::open(&path).expect("open db");
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS workflow_runs(
           id TEXT PRIMARY KEY, workflow TEXT, version INTEGER, repo TEXT, brief TEXT, title TEXT,
           status TEXT, reason TEXT, loops TEXT, rev INTEGER, created_at REAL, updated_at REAL
         );
         CREATE TABLE IF NOT EXISTS workflow_questions(
           id TEXT PRIMARY KEY, run_id TEXT, step_id TEXT, attempt INTEGER, branch TEXT,
           asker_task_id TEXT, asker_kind TEXT, text TEXT, answer_type TEXT, options TEXT,
           recommended TEXT, blocks TEXT, artifact TEXT, answerer TEXT, chain TEXT,
           suggested TEXT, answer TEXT, answered_by TEXT, status TEXT, rev INTEGER,
           created_at REAL, answered_at REAL
         );",
    )
    .expect("ddl");
    db.execute(
        "INSERT INTO workflow_runs(id, workflow, version, repo, brief, title, status, reason, loops, rev, created_at, updated_at)
         VALUES ('run_nothingxx', 't/attn', 1, '/tmp', 'B', 'Info', 'running', NULL, '{}', 1, 1.0, 1.0)",
        [],
    )
    .expect("run");
    db.execute(
        "INSERT INTO workflow_questions(
           id, run_id, step_id, attempt, branch, asker_task_id, asker_kind, text, answer_type,
           options, recommended, blocks, artifact, answerer, chain, suggested, answer, answered_by,
           status, rev, created_at, answered_at
         ) VALUES ('q_nothingxxx', 'run_nothingxx', 'info', 1, NULL, 't-ask', 'executor', 'FYI', 'text',
           NULL, NULL, 'nothing', NULL, 'orchestrator', '[]', NULL, NULL, NULL, 'open', 1, 1.0, NULL)",
        [],
    )
    .expect("question");
    let asker = json!({
        "id":"t-ask","title":"Asker","state":"needs_input","rev":1,"updatedAt":1_700_000_000.0,
        "executor":"codex","question":{"text":"which db?","at":1_700_000_000.0 - 5.0}
    });
    let items = attention::raised(
        &ctx,
        &[asker],
        &[],
        &[],
        &json!({"items":[]}),
        &Value::Null,
        false,
    );
    let ids: Vec<&str> = items.iter().map(|i| text(&i["id"])).collect();
    assert!(
        ids.contains(&"question:t-ask"),
        "ordinary item kept when only blocks:nothing orchestrator question: {ids:?}"
    );
    assert!(
        !ids.iter().any(|id| id.starts_with("question:q_")),
        "orchestrator question must not raise a person attention item: {ids:?}"
    );
}

#[test]
fn r2_i3_mixed_run_branch_ordinary_sort_is_total_order() {
    let mut items = vec![
        json!({
            "id":"question:run_a","kind":"question","severity":"blocked","since":10.0,
            "unblocks":"run","run":{"priority":"normal"}
        }),
        json!({
            "id":"question:run_b","kind":"question","severity":"blocked","since":1.0,
            "unblocks":"branch","run":{"priority":"normal"}
        }),
        json!({
            "id":"question:t-ordinary","kind":"question","severity":"blocked","since":5.0,
            "taskId":"t-ordinary"
        }),
    ];
    attention::sort(&mut items);
    let ids: Vec<&str> = items.iter().map(|i| text(&i["id"])).collect();
    assert_eq!(
        ids,
        vec!["question:run_a", "question:run_b", "question:t-ordinary",]
    );
    let mut again = items.clone();
    attention::sort(&mut again);
    assert_eq!(again, items);
}
