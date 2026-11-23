#![allow(clippy::unwrap_used)]
use super::*;
use rusqlite::params;
use std::collections::HashMap;

/// A valid `pet_` envelope identity: `pet_` + 64 hex chars, so
/// `authorize_enforcement_token` reaches the store lookup.
fn token() -> String {
    format!("pet_{}", "a".repeat(64))
}

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

/// A writable absolute repo path (registers, so `repo_needs_core` is false).
fn repo_path(dir: &std::path::Path) -> String {
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    repo.to_str().unwrap().to_owned()
}

/// Opens the store and seeds a runnable task: a `running` record with an empty
/// `attempts` array, a strict `work_nodes` entry, and a live enforcement
/// token. `task_extra` augments the record (e.g. an `executor`); `strict`
/// controls the node's `delegationEnforcement`. Returns the task id.
fn seed_enforced(
    dir: &std::path::Path,
    id: &str,
    task_extra: Value,
    strict: bool,
) -> (Ctx, String) {
    let valid = token();
    let env = [("PACER_ENFORCEMENT_TOKEN", valid.as_str())];
    let ctx = ctx(dir, &env);
    std::fs::create_dir_all(dir.join(".pacer/state")).unwrap();
    let mut state = open(&ctx).unwrap();
    let db = state.tasks.connection().unwrap();
    let mut record = json!({"id": id, "rev": 2, "state": "running", "createdAt": 10,
        "attempts": [], "brief": {"goal": format!("goal {id}"), "repo": "/repo"}});
    if let (Some(base), Value::Object(extra)) = (record.as_object_mut(), task_extra) {
        base.extend(extra);
    }
    db.execute(
        "INSERT INTO tasks(id,rev,state,created_at,updated_at,settled_at,repo,record,archived) VALUES(?,?,?,?,?,?,?,?,0)",
        params![id, record["rev"].as_i64().unwrap(), "running", 10.0, 10.0,
            Option::<f64>::None, Option::<String>::None, record.to_string()],
    )
    .unwrap();
    let options = json!({"delegationEnforcement": if strict { "strict" } else { "cooperative" }});
    db.execute(
        "INSERT INTO work_nodes(task_id,parent_id,root_id,depth,options,dependencies) VALUES(?,?,?,?,?,?)",
        params![id, Option::<String>::None, id, 0, options.to_string(), "[]"],
    )
    .unwrap();
    db.execute(
        "INSERT INTO enforcement_tokens(hash,task_id,attempt,expires,revoked) VALUES(?,?,?,?,0)",
        params![sha256_hex(&token()), id, 1, 1_700_000_001.0],
    )
    .unwrap();
    drop(state);
    (ctx, id.to_owned())
}

/// Records each `dispatch-parts` request and answers `dispatch.enforcement-
/// exclusions` (and a default diagnostics payload) from `exclusions` by runner.
#[derive(Default)]
struct Fake {
    calls: Vec<(&'static str, Value)>,
    exclusions: HashMap<String, Value>,
}

impl Bridge for Fake {
    fn parts(&mut self, params: Value) -> OpFuture<'_> {
        self.calls.push(("parts", params.clone()));
        let reply = if params["kind"] == "dispatch.enforcement-exclusions" {
            let rows: Vec<Value> = params["runners"]
                .as_array()
                .unwrap_or(&vec![])
                .iter()
                .map(|r| {
                    let reason = self.exclusions.get(r.as_str().unwrap_or_default()).cloned();
                    json!({"runner": r, "reason": reason})
                })
                .collect();
            json!(rows)
        } else {
            json!({"scheduled": null, "runners": []})
        };
        Box::pin(async move { Ok(reply) })
    }
}

#[test]
fn denied_requires_an_identity_before_params() {
    let dir = tempfile::tempdir().unwrap();
    // No token: the caller gate fires before any param check.
    let ctx = ctx(dir.path(), &[]);
    let mut fake = Fake::default();
    let err = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(dispatch_enforcement_denied(&ctx, json!({}), &mut fake))
        .unwrap_err();
    assert_eq!(err.code, Code::NotAllowed);
    assert_eq!(err.message, "An enforcement identity is required");
    assert_eq!(fake.calls.len(), 0);
}

#[tokio::test]
async fn denied_orders_agent_param_after_the_identity_and_before_token() {
    let dir = tempfile::tempdir().unwrap();
    let (ctx, _) = seed_enforced(dir.path(), "t-20261110-190000-aaaa", json!({}), true);
    let mut fake = Fake::default();
    // A malformed token with valid params: the agent enum passes, the token is
    // refused before any store lookup.
    let mut no_agent = ctx.clone();
    no_agent
        .env
        .insert("PACER_ENFORCEMENT_TOKEN".into(), "not-a-token".into());
    let bad_token =
        dispatch_enforcement_denied(&no_agent, json!({"agent": "claude-code"}), &mut fake)
            .await
            .unwrap_err();
    assert_eq!(bad_token.message, "Invalid enforcement identity");
    // Invalid `agent` fires after the identity gate but before token checks.
    let bad_agent = dispatch_enforcement_denied(&ctx, json!({"agent": "zed"}), &mut fake)
        .await
        .unwrap_err();
    assert_eq!(
        bad_agent.message,
        "agent: Invalid option: expected one of \"claude-code\"|\"codex\"|\"cursor\""
    );
    assert_eq!(bad_agent.code, Code::InvalidInput);
}

#[tokio::test]
async fn denied_records_the_denial_and_lost_decision_for_an_executor() {
    let dir = tempfile::tempdir().unwrap();
    let (ctx, id) = seed_enforced(
        dir.path(),
        "t-20261110-190000-bbbb",
        json!({"executor": "codex"}),
        true,
    );
    // A decision must exist for `denied` to merge its loss into.
    let mut state = open(&ctx).unwrap();
    state
        .tasks
        .connection()
        .unwrap()
        .execute(
            "INSERT INTO work_decisions(task_id,attempt,data) VALUES(?,?,?)",
            params![id, 1, r#"{"approach":"a","enforcement":{"blocked":true}}"#],
        )
        .unwrap();
    drop(state);
    let mut fake = Fake::default();
    fake.exclusions
        .insert("codex".into(), json!("Native subagent is excluded"));
    let out = dispatch_enforcement_denied(&ctx, json!({"agent": "codex"}), &mut fake)
        .await
        .unwrap();
    assert_eq!(out, json!({"recorded": true}));
    assert_eq!(fake.calls.len(), 1);
    assert_eq!(fake.calls[0].1["kind"], "dispatch.enforcement-exclusions");
    let mut state = open(&ctx).unwrap();
    let db = state.tasks.connection().unwrap();
    let decision: String = db
        .query_row(
            "SELECT data FROM work_decisions WHERE task_id=? AND attempt=?",
            params![id, 1],
            |r| r.get(0),
        )
        .unwrap();
    let decision: Value = serde_json::from_str(&decision).unwrap();
    assert_eq!(decision["approach"], "a");
    assert_eq!(decision["enforcement"]["blocked"], true);
    assert_eq!(
        decision["enforcement"]["loss"]["reason"],
        "Native subagent is excluded"
    );
    let event: String = db
        .query_row(
            "SELECT data FROM work_events WHERE task_id=? AND kind=?",
            params![id, "enforcement.lost"],
            |r| r.get(0),
        )
        .unwrap();
    let event: Value = serde_json::from_str(&event).unwrap();
    assert_eq!(event["runner"], "codex");
    let denied: String = db
        .query_row(
            "SELECT data FROM work_events WHERE task_id=? AND kind=?",
            params![id, "native-child.denied"],
            |r| r.get(0),
        )
        .unwrap();
    let denied: Value = serde_json::from_str(&denied).unwrap();
    assert_eq!(denied["attempt"].as_f64(), Some(1.0));
    assert_eq!(denied["agent"], "codex");
}

#[tokio::test]
async fn denied_without_an_executor_records_only_the_denial() {
    let dir = tempfile::tempdir().unwrap();
    let (ctx, id) = seed_enforced(dir.path(), "t-20261110-190000-cccc", json!({}), true);
    let mut fake = Fake::default();
    let out = dispatch_enforcement_denied(&ctx, json!({"agent": "codex"}), &mut fake)
        .await
        .unwrap();
    assert_eq!(out, json!({"recorded": true}));
    assert_eq!(fake.calls.len(), 0);
    let mut state = open(&ctx).unwrap();
    let db = state.tasks.connection().unwrap();
    let n: i64 = db
        .query_row(
            "SELECT count(*) FROM work_decisions WHERE task_id=?",
            params![id],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(n, 0);
}

#[test]
fn authorize_token_rejects_malformed_identities() {
    let dir = tempfile::tempdir().unwrap();
    let (ctx, _) = seed_enforced(dir.path(), "t-20261110-190000-dddd", json!({}), true);
    for bad in [
        "plain".to_owned(),                // missing the pet_ prefix
        format!("pet_{}", "a".repeat(63)), // wrong length
        format!("pet_{}", "z".repeat(64)), // non-hex
    ] {
        let err = authorize_enforcement_token(&ctx, &bad).unwrap_err();
        assert_eq!(err.message, "Invalid enforcement identity", "{bad}");
        assert_eq!(err.code, Code::NotAllowed);
    }
}

#[test]
fn authorize_token_accepts_a_live_strict_token_and_refuses_stale_ones() {
    let dir = tempfile::tempdir().unwrap();
    let (ctx, id) = seed_enforced(dir.path(), "t-20261110-190000-eeee", json!({}), true);
    let ok = authorize_enforcement_token(&ctx, &token()).unwrap();
    assert_eq!(ok, (id.clone(), 1.0));

    // Absent row: well-formed token but nothing stored.
    let mut hmm = ctx.clone();
    hmm.env.insert(
        "PACER_ENFORCEMENT_TOKEN".into(),
        format!("pet_{}", "b".repeat(64)),
    );
    let absent = authorize_enforcement_token(&hmm, &format!("pet_{}", "b".repeat(64))).unwrap_err();
    assert_eq!(absent.message, "Expired or revoked enforcement identity");
    assert_eq!(absent.code, Code::NotAllowed);

    // Revoked row.
    let mut state = open(&ctx).unwrap();
    let db = state.tasks.connection().unwrap();
    db.execute(
        "UPDATE enforcement_tokens SET revoked=1 WHERE task_id=?",
        params![id],
    )
    .unwrap();
    drop(state);
    assert_eq!(
        authorize_enforcement_token(&ctx, &token())
            .unwrap_err()
            .message,
        "Expired or revoked enforcement identity"
    );

    // Cooperative node (separate store): not strict, so refused.
    let coop_dir = tempfile::tempdir().unwrap();
    let (coop_ctx, _) = seed_enforced(coop_dir.path(), "t-20261110-190000-ffff", json!({}), false);
    assert_eq!(
        authorize_enforcement_token(&coop_ctx, &token())
            .unwrap_err()
            .message,
        "Expired or revoked enforcement identity"
    );
}

#[test]
fn enforcement_stays_forwarded_follows_repo_need() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), &[]);
    let repo = repo_path(dir.path());
    // An absolute, resolvable repo stays native.
    assert!(!dispatch_enforcement_stays_forwarded(
        &ctx,
        "dispatch.enforcement",
        &json!({"repo": repo})
    ));
    // A relative, unregistered repo needs Core.
    assert!(dispatch_enforcement_stays_forwarded(
        &ctx,
        "dispatch.enforcement",
        &json!({"repo": "not/registered"})
    ));
    // denied never stays forwarded.
    assert!(!dispatch_enforcement_stays_forwarded(
        &ctx,
        "dispatch.enforcement.denied",
        &json!({"repo": "not/registered"})
    ));
    assert!(!dispatch_enforcement_stays_forwarded(
        &ctx,
        "dispatch.other",
        &json!({"repo": "not/registered"})
    ));
}

#[test]
fn probe_stays_forwarded_matches_repo_and_is_quiet_on_bad_params() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), &[]);
    let repo = repo_path(dir.path());
    // A valid, resolvable repo: the canary job runs in Core, so the probe
    // stays forwarded past the front door.
    assert!(probe_stays_forwarded(
        &ctx,
        &json!({"repo": repo, "runner": "codex"})
    ));
    // A relative-unregistered repo: the requested repo needs Core to resolve
    // it, so the probe does not stay forwarded as a native reply.
    assert!(!probe_stays_forwarded(
        &ctx,
        &json!({"repo": "not/registered", "runner": "codex"})
    ));
    // Invalid params: refuse to judge, so it stays native (false).
    assert!(!probe_stays_forwarded(
        &ctx,
        &json!({"repo": repo, "runner": "x".repeat(129)})
    ));
    assert!(!probe_stays_forwarded(&ctx, &json!({"runner": "codex"})));
    assert!(!probe_stays_forwarded(&ctx, &json!([])));
}

#[test]
fn update_work_decision_merges_and_conflicts() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), &[]);
    let id = "t-7";
    std::fs::create_dir_all(dir.path().join(".pacer/state")).unwrap();
    let mut state = open(&ctx).unwrap();
    let db = state.tasks.connection().unwrap();
    db.execute(
        "INSERT INTO work_decisions(task_id,attempt,data) VALUES(?,?,?)",
        params![id, 1, r#"{"approach":"a","enforcement":{"blocked":true}}"#],
    )
    .unwrap();
    drop(state);

    // Missing attempt: conflict.
    let err = update_work_decision_loss(&ctx, id, 9.0, &json!({"at": 2})).unwrap_err();
    assert_eq!(err.code, Code::Conflict);
    assert_eq!(err.message, "Dispatch decision is missing for this attempt");

    // Present attempt: the `enforcement` patch keeps prior keys and gains `loss`.
    update_work_decision_loss(
        &ctx,
        id,
        1.0,
        &json!({"at": 1_700_000_000.123_4, "reason": "excluded"}),
    )
    .unwrap();
    let mut state = open(&ctx).unwrap();
    let db = state.tasks.connection().unwrap();
    let row: String = db
        .query_row(
            "SELECT data FROM work_decisions WHERE task_id=? AND attempt=?",
            params![id, 1],
            |r| r.get(0),
        )
        .unwrap();
    drop(state);
    let row: Value = serde_json::from_str(&row).unwrap();
    assert_eq!(row["approach"], "a");
    assert_eq!(row["enforcement"]["blocked"], true);
    assert_eq!(row["enforcement"]["loss"]["reason"], "excluded");
}

#[test]
fn append_work_event_fills_root_from_the_node() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), &[]);
    let id = "t-8";
    std::fs::create_dir_all(dir.path().join(".pacer/state")).unwrap();
    let mut state = open(&ctx).unwrap();
    let db = state.tasks.connection().unwrap();
    db.execute(
        "INSERT INTO tasks(id,rev,state,created_at,updated_at,settled_at,repo,record,archived) VALUES(?,?,?,?,?,?,?,?,0)",
        params![id, 1, "running", 1.0, 1.0, Option::<f64>::None, Option::<String>::None,
            json!({"id": id, "state": "running"}).to_string()],
    )
    .unwrap();
    db.execute(
        "INSERT INTO work_nodes(task_id,parent_id,root_id,depth,options,dependencies) VALUES(?,?,?,?,?,?)",
        params![id, Option::<String>::None, "root-9", 0, "{}", "[]"],
    )
    .unwrap();
    drop(state);
    append_work_event(&ctx, id, "native-child.denied", &json!({"agent": "codex"})).unwrap();
    let mut state = open(&ctx).unwrap();
    let db = state.tasks.connection().unwrap();
    let row: (String, String, String) = db
        .query_row(
            "SELECT root_id,kind,data FROM work_events WHERE task_id=?",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    drop(state);
    assert_eq!(row.0, "root-9");
    assert_eq!(row.1, "native-child.denied");
    assert_eq!(row.2, r#"{"agent":"codex"}"#);
}
