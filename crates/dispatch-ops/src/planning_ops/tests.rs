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

fn seed(ctx: &Ctx, strategy: &str, observations: &[Value]) {
    std::fs::create_dir_all(ctx.pacer_home.join("state")).unwrap();
    std::fs::write(ctx.pacer_home.join("strategy.yaml"), strategy).unwrap();
    let mut state = open(ctx).unwrap();
    let db = state.tasks.connection().unwrap();
    for (i, o) in observations.iter().enumerate() {
        db.execute(
            "INSERT INTO work_observations(id,at,data) VALUES(?,?,?)",
            rusqlite::params![format!("o{i}"), i as f64, o.to_string()],
        )
        .unwrap();
    }
}

fn observation(method: &str, value: Value) -> Value {
    json!({"value": value, "source": "s", "scope": {"account": "codex", "runner": "codex"},
        "method": method, "state": "known", "observedAt": 1.0, "expiresAt": 4e9})
}

#[test]
fn observations_parse_in_schema_order_with_defaults() {
    let parsed = parse_observation(&observation(
        "models",
        json!({"models": [{"strengths": ["a"], "id": "m"}]}),
    ))
    .unwrap();
    assert_eq!(
        Value::Object(parsed).to_string(),
        r#"{"source":"s","scope":{"runner":"codex","account":"codex"},"method":"models","state":"known","observedAt":1,"expiresAt":4000000000,"value":{"models":[{"id":"m","tier":"unknown","strengths":["a"]}]}}"#
    );
    for bad in [
        json!({"extra": 1}),
        json!({"context": 1.5}),
        json!({"windows": [{"pool": "p", "usedPct": 101}]}),
        json!({"model": ""}),
        json!({"models": [{"id": "m", "tier": "huge"}]}),
    ] {
        assert!(parse_observation(&observation("models", bad)).is_none());
    }
}

#[tokio::test]
async fn models_lists_declared_and_advertised_records() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), &[]);
    let models = json!({"models": [{"id": "gpt-5"}, {"id": "o9", "tier": "frontier"}]});
    let mut expired = observation("capabilities", json!({"tools": false}));
    expired["expiresAt"] = json!(1);
    seed(
        &ctx,
        "planner: codex\naccounts: {codex: {kind: codex}, claude: {kind: claude}}\nrunners: {codex: {models: [{id: gpt-5, tier: medium}]}, claude-code#claude: {}}\n",
        &[
            observation("models", models),
            observation("capabilities", json!({"tools": true})),
            expired,
        ],
    );
    let out = dispatch_models(&ctx, json!({})).await.unwrap();
    assert_eq!(out["models"].as_array().unwrap().len(), 2);
    assert_eq!(out["observedAt"], json!(1));
    let advertised: Vec<_> = out["advertised"]
        .as_array()
        .unwrap()
        .iter()
        .map(|a| (a["model"]["id"].clone(), a["authorized"].clone()))
        .collect();
    assert_eq!(
        advertised,
        [(json!("gpt-5"), json!(true)), (json!("o9"), json!(false))]
    );
    let enforced = ctx_with_token(dir.path());
    assert_eq!(
        dispatch_models(&enforced, json!({}))
            .await
            .unwrap_err()
            .code,
        Code::NotAllowed
    );
}

fn ctx_with_token(home: &std::path::Path) -> Ctx {
    ctx(home, &[("PACER_ENFORCEMENT_TOKEN", "pet_x")])
}

#[tokio::test]
async fn refresh_answers_backoff_and_forwards_a_due_refresh() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), &[]);
    seed(&ctx, "planner: codex\nproviders: {codex: {}}\n", &[]);
    assert!(planning_stays_forwarded(
        &ctx,
        "dispatch.refresh",
        &json!({})
    ));
    let err = dispatch_refresh(&ctx, json!({"runner": "nope"}))
        .await
        .unwrap_err();
    assert_eq!(
        (err.code, err.message.as_str()),
        (Code::InvalidInput, "Unknown runner")
    );
    let mut state = open(&ctx).unwrap();
    state
        .tasks
        .connection()
        .unwrap()
        .execute("INSERT INTO work_refresh(scope,attempted,retry_at,failures) VALUES('all',1,1800000000.5,0)", [])
        .unwrap();
    assert!(!planning_stays_forwarded(
        &ctx,
        "dispatch.refresh",
        &json!({})
    ));
    assert_eq!(
        dispatch_refresh(&ctx, json!({})).await.unwrap(),
        json!({"state": "backoff", "retryAt": 1_800_000_000.5, "observations": 0})
    );
    assert!(planning_stays_forwarded(
        &ctx,
        "dispatch.refresh",
        &json!({"force": true})
    ));
}

#[tokio::test]
async fn consent_rewrites_the_schedule_with_javascript_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), &[]);
    let path = schedule_path(&ctx);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(&path, r#"{"attempts":{"k":{"lastCostPct":1.0,"at":1e21}},"consent":{"b":"declined","7":"granted"},"x":1}"#).unwrap();
    let out = dispatch_enforcement_consent(&ctx, json!({"account": "a", "granted": true}))
        .await
        .unwrap();
    assert_eq!(out, json!({"account": "a", "consent": "granted"}));
    assert_eq!(
        std::fs::read_to_string(&path).unwrap(),
        r#"{"consent":{"7":"granted","b":"declined","a":"granted"},"attempts":{"k":{"lastCostPct":1,"at":1e+21}}}"#
    );
    std::fs::write(&path, r#"{"consent":"text"}"#).unwrap();
    assert!(planning_stays_forwarded(
        &ctx,
        "dispatch.enforcement.consent",
        &json!({})
    ));
    std::fs::write(&path, "[1]").unwrap();
    assert!(!planning_stays_forwarded(
        &ctx,
        "dispatch.enforcement.consent",
        &json!({})
    ));
}
