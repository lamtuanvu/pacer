#![allow(clippy::unwrap_used)]
use super::*;
use std::collections::HashMap;

const STRATEGY: &str = "planner: claude-code\naccounts: {claude: {kind: claude}, codex: {kind: codex}, cursor: {kind: cursor}}\nrunners: {claude-code: {}, codex: {}, cursor: {}}\n";

fn ctx(home: &std::path::Path, strategy: &str) -> Ctx {
    let ctx = Ctx::with(
        home.into(),
        home.join(".pacer"),
        HashMap::new(),
        1_700_000_000.123_4,
    );
    std::fs::create_dir_all(ctx.pacer_home.join("state")).unwrap();
    std::fs::write(ctx.pacer_home.join("strategy.yaml"), strategy).unwrap();
    ctx
}

fn provider(id: &str, account: &str) -> Value {
    json!({"id": id, "account": account, "usage": "quota", "windows": [], "binding": null,
        "verdict": "AHEAD", "installed": true, "stale": false,
        "eligibility": {"state": "eligible", "reasons": [], "evaluatedAt": 100, "validUntil": null,
            "evidenceAgeS": null, "availability": "ready", "budget": "permitted", "spendingRisk": "unknown"}})
}

/// Records each request and answers from `guards` and `enforcement` by runner.
#[derive(Default)]
struct Fake {
    calls: Vec<(&'static str, Value)>,
    guards: HashMap<String, String>,
    enforcement: HashMap<String, (Value, Value)>,
    broken: bool,
}

impl Bridge for Fake {
    fn status(&mut self, params: Value) -> OpFuture<'_> {
        self.calls.push(("status", params.clone()));
        let parts = json!({"accounts": [], "providers": [provider("claude-code", "claude"),
            provider("codex", "codex"), provider("cursor", "cursor")]});
        Box::pin(async move {
            Ok(match params.get("draft") {
                Some(_) => json!({"current": parts, "draft": parts}),
                None => parts,
            })
        })
    }
    fn parts(&mut self, params: Value) -> OpFuture<'_> {
        self.calls.push(("parts", params.clone()));
        let runners: Vec<String> = serde_json::from_value(params["runners"].clone()).unwrap();
        let reply = if self.broken {
            json!([])
        } else if params["kind"] == "dispatch.executor-guards" {
            let guards: Vec<Value> = runners
                .iter()
                .map(|r| json!({"runner": r, "reason": self.guards.get(r)}))
                .collect();
            json!({"guards": guards, "admissionHooks": false})
        } else {
            let rows: Vec<Value> = runners
                .iter()
                .map(|r| {
                    let (reason, unverified) = self
                        .enforcement
                        .get(r)
                        .cloned()
                        .unwrap_or((Value::Null, Value::Null));
                    json!({"runner": r, "reason": reason, "unverified": unverified})
                })
                .collect();
            json!(rows)
        };
        Box::pin(async move { Ok(reply) })
    }
}

fn repo(dir: &std::path::Path) -> String {
    let repo = dir.join("repo");
    std::fs::create_dir_all(&repo).unwrap();
    repo.to_str().unwrap().to_owned()
}

fn excluded_ids(preview: &Value) -> Vec<String> {
    ids(&preview["excluded"])
}

#[test]
fn parse_applies_zod_defaults_and_refuses_what_rust_might_misjudge() {
    let input = parse(
        "dispatch.preview",
        &json!({"repo": "/r", "goal": "g",
        "requirements": {"context": 5, "minTier": "small"}}),
    )
    .unwrap();
    assert_eq!(
        Value::Object(input),
        json!({"repo": "/r", "goal": "g", "requirements": {"minTier": "small", "context": 5},
            "preferences": {"models": [], "strengths": []}})
    );
    let explain = parse("dispatch.explain", &json!({"repo": "/r", "goal": "g"})).unwrap();
    assert_eq!(explain["via"], "delegate");
    for params in [
        json!([]),
        json!({"goal": "g"}),
        json!({"repo": "/r", "goal": ""}),
        json!({"repo": "/r", "goal": "g", "extra": 1}),
        json!({"repo": "/r", "goal": "g", "via": "dispatch"}),
        json!({"repo": "/r", "goal": "x".repeat(8001)}),
        json!({"repo": "/r", "goal": "g", "kind": null}),
        json!({"repo": "/r", "goal": "g", "requirements": {"context": 5.0}}),
        json!({"repo": "/r", "goal": "g", "requirements": {"context": 0}}),
        json!({"repo": "/r", "goal": "g", "preferences": {"models": [""]}}),
        json!({"repo": "/r", "goal": "g", "delegationEnforcement": "loose"}),
    ] {
        assert!(parse("dispatch.preview", &params).is_none(), "{params}");
    }
    assert!(
        parse(
            "dispatch.preview",
            &json!({"repo": "/r", "goal": "😀".repeat(8000)})
        )
        .is_some()
    );
    assert!(
        parse(
            "dispatch.explain",
            &json!({"repo": "/r", "goal": "g", "strategyDraft": {"from": "default", "extra": 1}})
        )
        .is_none()
    );
    let big = json!({"from": "default", "description": "x", "set": {"a": "x".repeat(61_000)}});
    assert!(
        parse(
            "dispatch.explain",
            &json!({"repo": "/r", "goal": "g", "strategyDraft": big})
        )
        .is_none()
    );
}

#[test]
fn forwards_inputs_only_typescript_answers() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), STRATEGY);
    let repo = repo(dir.path());
    let explain = |extra: Value| {
        let mut params = json!({"repo": repo, "goal": "g", "kind": "tests"});
        params
            .as_object_mut()
            .unwrap()
            .extend(extra.as_object().unwrap().clone());
        stays_forwarded(&ctx, "dispatch.explain", &params)
    };
    assert!(!explain(json!({})));
    assert!(!explain(
        json!({"via": "dispatch", "interactionMode": "conversation"})
    ));
    assert!(explain(json!({"interactionMode": "conversation"})));
    assert!(explain(json!({"kind": null})));
    assert!(explain(json!({"repo": "not/registered"})));
    assert!(!explain(json!({"strategyDraft": {"from": "missing"}})));
    let preview = json!({"repo": repo, "goal": "g"});
    assert!(!stays_forwarded(&ctx, "dispatch.preview", &preview));
    assert!(stays_forwarded(
        &ctx,
        "dispatch.explain",
        &json!({"repo": repo, "goal": "g"})
    ));
    let mut grant = ctx.clone();
    grant.env.insert("PACER_WORK_GRANT".into(), "g".into());
    assert!(stays_forwarded(
        &grant,
        "dispatch.explain",
        &json!({"repo": repo, "goal": "g", "kind": "tests"})
    ));

    let plugin = format!("{STRATEGY}dispatch: {{engine: 'plugin:demo'}}\n");
    std::fs::write(ctx.pacer_home.join("strategy.yaml"), plugin).unwrap();
    assert!(stays_forwarded(&ctx, "dispatch.preview", &preview));
    assert!(explain(json!({"via": "dispatch"})));
    assert!(!explain(json!({})));

    let hosted = "planner: claude-code\naccounts: {claude: {kind: claude}, codex: {kind: codex}}\nrunners: {claude-code: {}, codex@devbox: {}}\nhosts:\n  devbox: {ssh: devbox, repos: {}}\n";
    std::fs::write(ctx.pacer_home.join("strategy.yaml"), hosted).unwrap();
    assert!(load_strategy(&ctx.pacer_home).is_ok());
    assert!(stays_forwarded(&ctx, "dispatch.preview", &preview));
    std::fs::write(ctx.pacer_home.join("strategy.yaml"), "not: [valid").unwrap();
    assert!(stays_forwarded(&ctx, "dispatch.preview", &preview));
}

#[tokio::test]
async fn preview_reads_strict_enforcement_from_core_without_the_cache() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), STRATEGY);
    let repo = repo(dir.path());
    let mut fake = Fake::default();
    fake.enforcement.insert(
        "codex".into(),
        (json!("Native subagent control is unverified"), Value::Null),
    );
    let params = json!({"repo": repo, "goal": "g", "kind": "tests"});
    let out = dispatch_preview(&ctx, "dispatch.preview", params, &mut fake)
        .await
        .unwrap();
    assert_eq!(fake.calls[0], ("status", json!({"cacheOnly": true})));
    let (_, parts) = &fake.calls[1];
    assert_eq!(parts["kind"], "dispatch.enforcement-exclusions");
    assert_eq!(parts["cached"], false);
    assert_eq!(parts["runners"], json!(["codex", "cursor"]));
    assert!(excluded_ids(&out).contains(&"codex".to_owned()));
    assert_eq!(out["engine"], json!({"id": "ladder", "version": "1"}));
    assert_eq!(out["request"]["now"], json!(1_700_000_000.123));
    let request = &out["request"];
    let task = request["task"].as_object().unwrap();
    assert_eq!(
        task.keys().collect::<Vec<_>>(),
        [
            "kind",
            "difficulty",
            "requirements",
            "preferences",
            "provenance"
        ]
    );
    let id = decision_hash(
        &json!({"task": request["task"], "strategyHash": request["strategyHash"],
        "observationRevision": request["observationRevision"], "now": request["now"]}),
    );
    assert_eq!(request["requestId"], json!(id));
    assert_eq!(
        out["uncertainty"].as_array().unwrap().last().unwrap(),
        "Preview uses cached observations and makes no reservation; dispatch may differ."
    );
}

#[tokio::test]
async fn cooperative_previews_skip_enforcement() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), STRATEGY);
    let params =
        json!({"repo": repo(dir.path()), "goal": "g", "delegationEnforcement": "cooperative"});
    let mut fake = Fake::default();
    let out = dispatch_preview(&ctx, "dispatch.preview", params, &mut fake)
        .await
        .unwrap();
    assert_eq!(fake.calls.len(), 1);
    assert!(!excluded_ids(&out).contains(&"codex".to_owned()));
    assert_eq!(out["validation"], "valid");
}

#[tokio::test]
async fn explain_reads_guards_and_cached_enforcement() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), STRATEGY);
    let mut fake = Fake::default();
    fake.guards.insert("cursor".into(), "Blocked by you".into());
    fake.enforcement
        .insert("codex".into(), (Value::Null, json!("codex")));
    let params = json!({"repo": repo(dir.path()), "goal": "g", "kind": "tests", "via": "dispatch"});
    let out = dispatch_preview(&ctx, "dispatch.explain", params, &mut fake)
        .await
        .unwrap();
    assert_eq!(out["mode"], "ladder");
    assert_eq!(fake.calls[1].1["kind"], "dispatch.executor-guards");
    assert_eq!(fake.calls[2].1["cached"], true);
    assert_eq!(fake.calls[2].1["runners"], json!(["codex"]));
    let codes: Vec<&Value> = out["uncertainty"]
        .as_array()
        .unwrap()
        .iter()
        .map(|u| &u["code"])
        .collect();
    assert!(codes.contains(&&json!("enforcement_unverified")));
    let cursor = out["fallbacks"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["runner"] == "cursor")
        .unwrap();
    assert_eq!(cursor["reason"]["code"], "blocked_by_user");
    assert!(!dir.path().join(".pacer/repos.json").exists());
}

#[tokio::test]
async fn delegate_explains_rank_with_guards_and_slots() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), STRATEGY);
    let mut fake = Fake::default();
    fake.guards.insert("codex".into(), "exhausted".into());
    let params =
        json!({"repo": repo(dir.path()), "goal": "g", "kind": "tests", "executor": "codex"});
    let out = dispatch_preview(&ctx, "dispatch.explain", params, &mut fake)
        .await
        .unwrap();
    assert_eq!(out["mode"], "ranked");
    assert_eq!(out["outcome"], "fail");
    assert_eq!(fake.calls.len(), 2);
}

#[tokio::test]
async fn explain_errors_match_typescript() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), STRATEGY);
    let repo = repo(dir.path());
    let call = |params: Value| {
        let ctx = ctx.clone();
        async move {
            let mut fake = Fake::default();
            dispatch_preview(&ctx, "dispatch.explain", params, &mut fake)
                .await
                .unwrap_err()
        }
    };
    let kind = call(json!({"repo": repo, "goal": "g", "kind": "nope"})).await;
    assert_eq!(kind.message, "Unknown kind \"nope\"");
    assert!(
        kind.hint
            .unwrap()
            .starts_with("Allowed kinds: boilerplate, tests")
    );
    let executor =
        call(json!({"repo": repo, "goal": "g", "kind": "tests", "executor": "zed"})).await;
    assert_eq!(executor.code, Code::UnknownExecutor);
    assert_eq!(
        executor.hint.as_deref(),
        Some("Configured: claude-code, codex, cursor")
    );
    let draft = json!({"from": "default", "set": {"pacing.policy": "nope"}});
    let invalid =
        call(json!({"repo": repo, "goal": "g", "kind": "tests", "strategyDraft": draft})).await;
    assert_eq!(invalid.message, "Invalid strategy draft");
    let relative = call(json!({"repo": "not/registered", "goal": "g", "kind": "tests"})).await;
    assert_eq!(
        relative.message,
        "repo must be an absolute path or a registered repo key"
    );
    let mut enforced = ctx.clone();
    enforced
        .env
        .insert("PACER_ENFORCEMENT_TOKEN".into(), "t".into());
    let mut fake = Fake::default();
    let denied = dispatch_preview(&enforced, "dispatch.preview", json!({}), &mut fake)
        .await
        .unwrap_err();
    assert_eq!(denied.code, Code::NotAllowed);
}

#[tokio::test]
async fn malformed_bridge_replies_are_unavailable() {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), STRATEGY);
    let mut fake = Fake {
        broken: true,
        ..Fake::default()
    };
    let params = json!({"repo": repo(dir.path()), "goal": "g"});
    let error = dispatch_preview(&ctx, "dispatch.preview", params, &mut fake)
        .await
        .unwrap_err();
    assert_eq!(error.code, Code::Unavailable);
    assert_eq!(error.message, "invalid dispatch parts response");
}

#[test]
fn slot_blocks_name_the_executor_then_the_machine() {
    let strategy = load_strategy_from(&format!("{STRATEGY}execution: {{local_max_tasks: 2}}\n"));
    let busy = json!({"byExecutor": {"codex": 1}, "byHost": {}, "local": 1});
    assert_eq!(
        slot_block(&strategy, "codex", &busy).unwrap(),
        "Codex busy (1/1)"
    );
    let full = json!({"byExecutor": {}, "byHost": {}, "local": 2});
    assert_eq!(
        slot_block(&strategy, "codex", &full).unwrap(),
        "this machine busy (2/2)"
    );
    assert_eq!(slot_block(&strategy, "cursor", &busy), None);
}

fn load_strategy_from(yaml: &str) -> Value {
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), yaml);
    load_strategy(&ctx.pacer_home).unwrap()
}

#[test]
fn the_operation_future_is_send() {
    fn send<T: Send>(_: &T) {}
    let dir = tempfile::tempdir().unwrap();
    let ctx = ctx(dir.path(), STRATEGY);
    let mut fake = Fake::default();
    send(&dispatch_preview(
        &ctx,
        "dispatch.explain",
        json!({}),
        &mut fake,
    ));
}
