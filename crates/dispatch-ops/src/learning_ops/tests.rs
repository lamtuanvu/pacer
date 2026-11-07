#![allow(clippy::unwrap_used)]
use super::*;
use std::collections::HashMap;

fn ctx(home: &std::path::Path, env: &[(&str, &str)]) -> Ctx {
    Ctx::with(
        home.into(),
        home.join(".pacer"),
        env.iter()
            .map(|(k, v)| ((*k).into(), (*v).into()))
            .collect::<HashMap<_, _>>(),
        1_700_000_000.123_4,
    )
}

async fn run(
    ctx: &Ctx,
    op: fn(&Ctx, Value) -> OpFuture<'_>,
    params: Value,
) -> Result<Value, CoreError> {
    op(ctx, params).await
}

fn seed(ctx: &Ctx, rows: &[Value]) {
    std::fs::create_dir_all(std::path::Path::new(&ctx.pacer_home).join("state")).unwrap();
    std::fs::write(
        std::path::Path::new(&ctx.pacer_home).join("strategy.yaml"),
        "planner: codex\nproviders: {codex: {}}\n",
    )
    .unwrap();
    let mut state = open(ctx).unwrap();
    let db = state.tasks.connection().unwrap();
    for (i, row) in rows.iter().enumerate() {
        db.execute(
            "INSERT INTO work_reviews(task_id,attempt,at,provenance,data) VALUES(?,?,?,?,?)",
            rusqlite::params![
                format!("t{i}"),
                1,
                row["at"].as_f64(),
                row["provenance"].as_str(),
                row.to_string()
            ],
        )
        .unwrap();
    }
    db.execute("INSERT INTO work_reviews(task_id,attempt,at,provenance,data) VALUES('bad',1,1,'human','{')", [])
        .unwrap();
}

fn review(repo: &str, runner: &str, accepted: bool, at: f64) -> Value {
    json!({"taskId":"t","attempt":1,"repo":repo,"kind":"code","difficulty":"medium","runner":runner,"model":null,
        "settings":"h","accepted":accepted,"durationS":10.0,"usagePct":null,"at":at,"provenance":"human"})
}

#[tokio::test]
async fn analytics_groups_by_sample_count_and_formats_numbers() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), &[]);
    let mut agent = review("r", "codex", true, 5.0);
    agent["provenance"] = json!("system");
    seed(
        &ctx,
        &[
            review("r", "claude-code", true, 3.0),
            review("r", "codex", false, 4.0),
            review("r", "codex", true, 6.0),
            review("other", "codex", true, 7.0),
            agent,
        ],
    );
    let out = run(&ctx, dispatch_analytics, json!({"repo": "r"}))
        .await
        .unwrap();
    assert_eq!(out["totalReviews"], 3);
    assert_eq!(out["minimumSamples"], 20);
    assert_eq!(out["learningRevision"], 0);
    let groups = out["groups"].as_array().unwrap();
    assert_eq!(groups[0]["runner"], "codex");
    assert_eq!(groups[0]["successRate"], json!(0.5));
    assert_eq!(groups[0]["averageDurationS"].to_string(), "10");
    assert_eq!(groups[0]["averageUsagePct"], Value::Null);
    assert_eq!(groups[0]["latestAt"].to_string(), "6");
    assert_eq!(groups[1]["confidenceUpper"], json!(1));
    let all = run(&ctx, dispatch_analytics, Value::Null).await.unwrap();
    assert_eq!(all["totalReviews"], 4);
    assert_eq!(all["learningRevision"], Value::Null);
}

#[tokio::test]
async fn reset_checks_the_revision_and_toggles_exclusion() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), &[]);
    seed(&ctx, &[review("r", "codex", true, 1_699_999_999.0)]);
    let stale = run(
        &ctx,
        dispatch_learning_reset,
        json!({"repo":"r","expect_rev":1}),
    )
    .await
    .unwrap_err();
    assert_eq!(stale.code, Code::Conflict);
    let out = run(
        &ctx,
        dispatch_learning_reset,
        json!({"repo":"r","excluded":true,"expect_rev":0}),
    )
    .await
    .unwrap();
    assert_eq!(
        out,
        json!({"reset":true,"excluded":true,"revision":1_700_000_000.123})
    );
    let analytics = run(&ctx, dispatch_analytics, json!({"repo":"r"}))
        .await
        .unwrap();
    assert_eq!(analytics["totalReviews"], 0);
    assert_eq!(analytics["learningRevision"], json!(1_700_000_000.123));
    let again = run(
        &ctx,
        dispatch_learning_reset,
        json!({"repo":"r","expect_rev":1_700_000_000.123}),
    )
    .await
    .unwrap();
    assert_eq!(again["revision"], json!(1_700_000_000.123_f64 + 0.001));
}

#[tokio::test]
async fn params_and_identities_match_zod_and_the_work_gate() {
    let dir = tempfile::tempdir().unwrap();
    let ctx_plain = ctx(dir.path(), &[]);
    let error = run(
        &ctx_plain,
        dispatch_learning_reset,
        json!({"repo":"","excluded":1,"expect_rev":-1}),
    )
    .await
    .unwrap_err();
    assert_eq!(
        error.message,
        "repo: Too small: expected string to have >=1 characters; excluded: Invalid input: expected boolean, received number; expect_rev: Too small: expected number to be >=0"
    );
    let error = run(&ctx_plain, dispatch_analytics, json!({"repo":5,"kind":""}))
        .await
        .unwrap_err();
    assert_eq!(
        error.message,
        "repo: Invalid input: expected string, received number; kind: Too small: expected string to have >=1 characters"
    );
    let executor = ctx(dir.path(), &[("PACER_ROLE", "executor")]);
    assert_eq!(
        run(&executor, dispatch_analytics, json!({}))
            .await
            .unwrap_err()
            .code,
        Code::NotAllowed
    );
}
