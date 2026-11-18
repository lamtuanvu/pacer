//! Native `dispatch.preview` and `dispatch.explain` for ladder engines (`previewDispatch` in
//! `src/core/dispatch.ts`, `explainDispatch` in `src/core/dispatch-explain.ts` and
//! `explainRankedDispatch`). Core keeps three reads, which the [`Bridge`] fetches: the
//! cache-only usage-broker status parts, the local guardrails with the classifier check
//! (`dispatch.executor-guards`), and native-control enforcement
//! (`dispatch.enforcement-exclusions`), whose version probes and certificate fingerprints
//! only TypeScript computes. Inputs only TypeScript answers forward ([`stays_forwarded`]).
#![allow(clippy::result_large_err)]
use pacer_config::{
    strategy::{default_dispatch_config, display_name, load_strategy},
    strategy_write::{DraftPreview, preview_draft},
};
use pacer_dispatch::{
    Explain, LadderPreview, Ranked, ReadOnlyStore, apply_learned_fit, build_candidates,
    build_explanation, decision_hash, exclusion_reason, explain_ranked, model_inventory, reason,
    run_ladder, status_observations, stored_observations,
};
use pacer_engine::{balance::balance_by_load, pause::read_pause, rank_executors, usage_broker};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::{
    TASK_KINDS, files_search::executor_session, project_selection, read_project_strategies,
    resolve_runner, slot_limit, slot_use,
};
use pacer_store::TaskFilter;
use serde_json::{Map, Value, json};
use std::time::Instant;

use crate::dispatch_ops::authorize;
use crate::planning_ops::{now, open};
use crate::policy::{
    agent_sessions_may_hold_slots, internal, policy_error, policy_repo, policy_repo_read_only,
    repo_needs_core,
};

type Object = Map<String, Value>;

/// Core's reads for a preview. Replies are checked here; transport errors pass through.
pub trait Bridge: Send {
    /// Usage-broker parts (`src/api/status-broker-bridge.ts`).
    fn status(&mut self, params: Value) -> OpFuture<'_>;
    /// Dispatch parts (`src/api/dispatch-parts-bridge.ts`).
    fn parts(&mut self, params: Value) -> OpFuture<'_>;
}

pub fn needs_dispatch_parts(op: &str) -> bool {
    matches!(op, "dispatch.preview" | "dispatch.explain")
}

pub fn preview_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async {
        Err(CoreError::new(
            Code::Unavailable,
            "dispatch previews require the dispatch parts bridge",
        ))
    })
}

const MAX_SAFE: u64 = 9_007_199_254_740_991;

fn chars(value: &Value, min: usize, max: usize) -> bool {
    value
        .as_str()
        .is_some_and(|s| (min..=max).contains(&s.chars().count()))
}

fn one_of(value: &Value, options: &[&str]) -> bool {
    value.as_str().is_some_and(|s| options.contains(&s))
}

fn names(value: &Value, max: usize) -> bool {
    value
        .as_array()
        .is_some_and(|items| items.len() <= max && items.iter().all(|n| chars(n, 1, 256)))
}

/// `requirementsSchema`, in its key order.
fn requirements(value: &Value) -> Option<Value> {
    let given = value.as_object()?;
    let out: Object = ["minTier", "tools", "context"]
        .iter()
        .filter_map(|k| Some(((*k).to_owned(), given.get(*k)?.clone())))
        .collect();
    let valid = out.len() == given.len()
        && out
            .get("minTier")
            .is_none_or(|t| one_of(t, &["small", "medium", "frontier"]))
        && out.get("tools").is_none_or(Value::is_boolean)
        && out
            .get("context")
            .is_none_or(|c| c.as_u64().is_some_and(|c| (1..=MAX_SAFE).contains(&c)));
    valid.then_some(Value::Object(out))
}

/// `preferencesSchema` with its defaults.
fn preferences(value: &Value) -> Option<Value> {
    let given = value.as_object()?;
    let models = given.get("models").cloned().unwrap_or(json!([]));
    let strengths = given.get("strengths").cloned().unwrap_or(json!([]));
    let valid = given.keys().all(|k| k == "models" || k == "strengths")
        && names(&models, 256)
        && names(&strengths, 64);
    valid.then(|| json!({"models": models, "strengths": strengths}))
}

/// `strategyDraft`, without the keys zod would strip. Rust's serialization may differ from
/// `JSON.stringify` in length, so drafts near the 64 KiB limit forward.
fn draft(value: &Value) -> bool {
    let Some(draft) = value.as_object() else {
        return false;
    };
    let fields = draft.iter().all(|(key, v)| match key.as_str() {
        "from" => chars(v, 1, 128),
        "set" => v
            .as_object()
            .is_some_and(|set| set.keys().all(|k| k.chars().count() <= 256)),
        "unset" => v
            .as_array()
            .is_some_and(|keys| keys.len() <= 256 && keys.iter().all(|k| chars(k, 0, 256))),
        "description" => chars(v, 0, 1000),
        _ => false,
    });
    fields
        && draft.contains_key("from")
        && serde_json::to_string(value).is_ok_and(|text| text.encode_utf16().count() <= 60_000)
}

/// The input as zod parses it, with its defaults, or `None` where Rust might not agree with
/// zod: such input forwards, so TypeScript reports the issues.
fn parse(op: &str, params: &Value) -> Option<Object> {
    let explain = op == "dispatch.explain";
    let mut input = match params {
        Value::Null => Object::new(),
        Value::Object(map) => map.clone(),
        _ => return None,
    };
    let goal = if explain { 20_000 } else { 8_000 };
    let fields = input.iter().all(|(key, v)| match key.as_str() {
        "repo" => chars(v, 1, 4096),
        "goal" => chars(v, 1, goal),
        "kind" | "model" => chars(v, 1, 256),
        "requirements" | "preferences" => true,
        "delegationEnforcement" => one_of(v, &["strict", "cooperative"]),
        "executor" if explain => chars(v, 1, 128),
        "difficulty" if explain => one_of(v, &["simple", "standard", "complex"]),
        "via" if explain => one_of(v, &["dispatch", "delegate"]),
        "interactionMode" if explain => one_of(v, &["delegated", "conversation"]),
        "allowDelegation" if explain => v.is_boolean(),
        "strategyDraft" if explain => draft(v),
        _ => false,
    });
    if !fields || !input.contains_key("repo") || !input.contains_key("goal") {
        return None;
    }
    let requirements = input
        .get("requirements")
        .map_or(Some(json!({})), requirements)?;
    let preferences = input
        .get("preferences")
        .map_or(Some(json!({"models": [], "strengths": []})), preferences)?;
    input.insert("requirements".into(), requirements);
    input.insert("preferences".into(), preferences);
    if explain && !input.contains_key("via") {
        input.insert("via".into(), json!("delegate"));
    }
    Some(input)
}

fn text<'a>(input: &'a Object, key: &str) -> Option<&'a str> {
    input.get(key).and_then(Value::as_str)
}

/// The strategy the request reads: the validated draft, or the active strategy.
/// `Err` carries the native draft error.
fn strategy_of(ctx: &Ctx, input: &Object) -> Option<Result<Value, CoreError>> {
    let Some(draft) = input.get("strategyDraft") else {
        return load_strategy(&ctx.pacer_home).ok().map(Ok);
    };
    match preview_draft(&ctx.pacer_home, draft) {
        DraftPreview::Valid { strategy, .. } => Some(Ok(strategy)),
        DraftPreview::Invalid { problems, .. } => Some(Err(CoreError::new(
            Code::InvalidInput,
            "Invalid strategy draft",
        )
        .hint(problems.join("; ")))),
        DraftPreview::Unreadable => None,
    }
}

/// Inputs only TypeScript answers: input Rust does not validate exactly like zod; an
/// explain without `kind` (the rules classifier), a conversation's ranking, or from an
/// executor session; a plugin engine; a host runner (remote eligibility); a repository,
/// policy or registry only TypeScript reads; live agent sessions holding slots. The caller
/// checks that Rust loads the strategy Bun loads and reads a `strategyDraft` alike.
pub fn stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    let Some(input) = parse(op, params) else {
        return true;
    };
    let explain = op == "dispatch.explain";
    let ranked = explain && text(&input, "via") == Some("delegate");
    if explain {
        let providers = || {
            load_strategy(&ctx.pacer_home)
                .ok()
                .and_then(|s| {
                    s["providers"]
                        .as_object()
                        .map(|p| p.keys().cloned().collect())
                })
                .unwrap_or_default()
        };
        if !input.contains_key("kind")
            || ranked && text(&input, "interactionMode") == Some("conversation")
            || ctx.env.contains_key("PACER_WORK_GRANT")
            || std::env::current_dir().map_or(true, |cwd| executor_session(ctx, &cwd, providers))
        {
            return true;
        }
    }
    let strategy = match strategy_of(ctx, &input) {
        None => return true,
        Some(Err(_)) => return false,
        Some(Ok(strategy)) => strategy,
    };
    let plugin = strategy["dispatch"]["engine"]
        .as_str()
        .is_some_and(|engine| engine.starts_with("plugin:"));
    let hosted = strategy["runners"]
        .as_object()
        .is_some_and(|runners| runners.values().any(|r| truthy(&r["host"])));
    plugin && !ranked
        || hosted
        || repo_needs_core(ctx, text(&input, "repo").unwrap_or_default(), !explain)
        || agent_sessions_may_hold_slots(ctx)
}

fn truthy(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(false)) && value != "" && value != 0
}

/// Status providers by id.
fn by_id(status: &Value) -> Object {
    let providers = status["providers"].as_array().into_iter().flatten();
    providers
        .map(|p| (p["id"].as_str().unwrap_or_default().to_owned(), p.clone()))
        .collect()
}

fn invalid_reply(what: &str) -> CoreError {
    CoreError::new(Code::Unavailable, format!("invalid {what} response"))
}

fn info(code: &str, facts: Value, subject: Option<&str>) -> Value {
    reason(code, "info", facts, subject, None)
}

fn ids(entries: &Value) -> Vec<String> {
    entries
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|e| e["id"].as_str().map(str::to_owned))
        .collect()
}

/// What the request shares across both modes.
struct Request<'a> {
    input: &'a Object,
    strategy: &'a Value,
    /// The `strategyDraft` the bridge reads the strategy from.
    draft: Option<&'a Value>,
    now: f64,
}

impl Request<'_> {
    fn with_draft(&self, mut params: Value) -> Value {
        if let Some(draft) = self.draft {
            params["draft"] = draft.clone();
        }
        params
    }

    /// `computeStatus({...ctx, readOnly: true}, strategy, {cacheOnly: true})`.
    async fn status(&self, ctx: &Ctx, bridge: &mut dyn Bridge) -> Result<Value, CoreError> {
        let parts = bridge
            .status(self.with_draft(json!({"cacheOnly": true})))
            .await?;
        let parts = match self.draft {
            Some(_) => parts
                .get("draft")
                .cloned()
                .ok_or_else(|| invalid_reply("usage broker"))?,
            None => parts,
        };
        Ok(usage_broker::routing_status(ctx, self.strategy, &parts))
    }

    /// `executorExclusion` for each runner, and whether the classifier is configured.
    async fn guards(
        &self,
        runners: &[String],
        bridge: &mut dyn Bridge,
    ) -> Result<(Vec<Option<String>>, bool), CoreError> {
        let params = json!({"kind": "dispatch.executor-guards", "runners": runners});
        let reply = bridge.parts(self.with_draft(params)).await?;
        let guards = reply["guards"]
            .as_array()
            .filter(|g| g.len() == runners.len());
        let hooks = reply["admissionHooks"].as_bool();
        let (Some(guards), Some(hooks)) = (guards, hooks) else {
            return Err(invalid_reply("dispatch parts"));
        };
        let guards = guards
            .iter()
            .zip(runners)
            .map(|(guard, runner)| match &guard["reason"] {
                _ if guard["runner"] != runner.as_str() => None,
                Value::Null => Some(None),
                Value::String(text) => Some(Some(text.clone())),
                _ => None,
            })
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| invalid_reply("dispatch parts"))?;
        Ok((guards, hooks))
    }

    /// `enforcementExclusion` (`cached: false`) or `enforcementExclusionCached` for each
    /// runner: `(reason, unverified agent)`.
    async fn enforcement(
        &self,
        repo: &str,
        runners: &[String],
        cached: bool,
        bridge: &mut dyn Bridge,
    ) -> Result<Vec<(Option<String>, Option<String>)>, CoreError> {
        if runners.is_empty() {
            return Ok(Vec::new());
        }
        let params = json!({"kind": "dispatch.enforcement-exclusions", "repo": repo,
            "runners": runners, "cached": cached});
        let reply = bridge.parts(self.with_draft(params)).await?;
        let text = |value: &Value| match value {
            Value::Null => Some(None),
            Value::String(text) => Some(Some(text.clone())),
            _ => None,
        };
        reply
            .as_array()
            .filter(|rows| rows.len() == runners.len())
            .and_then(|rows| {
                rows.iter()
                    .zip(runners)
                    .map(|(row, runner)| {
                        let pair = (text(&row["reason"])?, text(&row["unverified"])?);
                        (row["runner"] == runner.as_str()).then_some(pair)
                    })
                    .collect::<Option<Vec<_>>>()
            })
            .ok_or_else(|| invalid_reply("dispatch parts"))
    }

    /// `rankExecutors(kind, strategy, byId, selection && {...}, {includePlanner})`.
    fn rank(&self, status: &Value, selection: Option<&Value>, include_planner: bool) -> Value {
        rank_executors(&json!({
            "strategy": self.strategy,
            "statuses": by_id(status),
            "selection": selection.map_or(Value::Null, |s| {
                json!({"executors": s["executors"], "order": "configured"})
            }),
            "kind": self.input.get("kind").cloned().unwrap_or(Value::Null),
            "includePlanner": include_planner,
        }))
    }
}

/// `slotBlock(strategy, id, use)` for a local runner.
fn slot_block(strategy: &Value, id: &str, use_: &Value) -> Option<String> {
    let runner = resolve_runner(strategy, id);
    let id = runner.and_then(|r| r["id"].as_str()).unwrap_or(id);
    let limit = slot_limit(strategy, id);
    let used = use_["byExecutor"][id].as_u64().unwrap_or(0) as usize;
    if used >= limit.executor {
        return Some(format!(
            "{} busy ({used}/{})",
            display_name(id),
            limit.executor
        ));
    }
    let local = use_["local"].as_u64().unwrap_or(0) as usize;
    limit
        .local
        .filter(|max| local >= *max)
        .map(|max| format!("this machine busy ({local}/{max})"))
}

/// `previewDispatch`'s read-only outputs (`ReadOnlyDispatch`).
/// The store is owned: a borrowed connection would make the operation's future not `Send`.
struct ReadOnly {
    store: ReadOnlyStore,
    exclusions: Vec<(String, Value)>,
    uncertainty: Vec<Value>,
    admission_hooks: bool,
}

/// `previewDispatch(ctx, input, deps)` for the ladder engine; with `ro`, its read-only form.
/// Returns the preview and the status it ranked.
async fn preview(
    ctx: &Ctx,
    r: &Request<'_>,
    bridge: &mut dyn Bridge,
    mut ro: Option<&mut ReadOnly>,
    difficulty: &str,
    include_planner: bool,
) -> Result<(Value, Value), CoreError> {
    let (strategy, input, now) = (r.strategy, r.input, r.now);
    let config = match &strategy["dispatch"] {
        Value::Null => default_dispatch_config(),
        config => config.clone(),
    };
    let projects = read_project_strategies(&ctx.pacer_home).map_err(policy_error)?;
    let path = text(input, "repo").unwrap_or_default();
    let repo = match ro {
        Some(_) => policy_repo_read_only(ctx, path, &projects)?,
        None => policy_repo(ctx, path, &projects)?,
    };
    let key = repo["key"].as_str().unwrap_or_default();
    let selection = project_selection(strategy, key, &projects);
    let status = r.status(ctx, bridge).await?;
    let ranking = r.rank(&status, selection.as_ref(), include_planner);
    let mut excluded: Vec<Value> = ranking["excluded"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|e| json!({"id": e["id"], "reason": e["reason"]}))
        .collect();
    let mut ranked = ids(&ranking["ranked"]);
    if let Some(ro) = ro.as_deref_mut() {
        for e in ranking["excluded"].as_array().into_iter().flatten() {
            let id = e["id"].as_str().unwrap_or_default();
            let why = exclusion_reason(
                id,
                e["reason"].as_str().unwrap_or_default(),
                e.get("eligibility"),
            );
            ro.exclusions.push((id.to_owned(), why));
        }
        let (guards, hooks) = r.guards(&ranked, bridge).await?;
        ro.admission_hooks = hooks;
        let mut kept = Vec::new();
        for (id, guard) in ranked.into_iter().zip(guards) {
            match guard {
                Some(guard) => {
                    excluded.push(json!({"id": id, "reason": guard}));
                    ro.exclusions
                        .push((id.clone(), exclusion_reason(&id, &guard, None)));
                }
                None => kept.push(id),
            }
        }
        ranked = kept;
        if !ro.store.available() {
            ro.uncertainty
                .push(info("tasks_unavailable", json!({}), None));
        }
    }
    let strict = text(input, "delegationEnforcement") != Some("cooperative");
    let filter = TaskFilter {
        states: Some(&["running", "needs_input"]),
        all: true,
        ..Default::default()
    };
    let (tasks, stored) = match ro.as_deref() {
        Some(ro) => (ro.store.slot_tasks()?, ro.store.stored_observations(now)?),
        None => {
            let mut state = open(ctx)?;
            let tasks = state.tasks.list(&filter).map_err(internal)?;
            let db = state.tasks.connection().map_err(internal)?;
            (tasks, stored_observations(db, now).map_err(internal)?)
        }
    };
    let use_ = slot_use(&tasks);
    let enforced = match strict {
        true => {
            let path = repo["path"].as_str().unwrap_or_default();
            r.enforcement(path, &ranked, ro.is_some(), bridge).await?
        }
        false => vec![(None, None); ranked.len()],
    };
    let mut allowed: Vec<String> = Vec::new();
    for (id, (enforcement, unverified)) in ranked.into_iter().zip(enforced) {
        if let (Some(ro), Some(agent)) = (ro.as_deref_mut(), unverified) {
            let facts = json!({"agent": agent});
            ro.uncertainty
                .push(info("enforcement_unverified", facts, Some(&id)));
        }
        match enforcement.or_else(|| slot_block(strategy, &id, &use_)) {
            Some(why) => {
                excluded.push(json!({"id": id, "reason": why}));
                if let Some(ro) = ro.as_deref_mut() {
                    ro.exclusions
                        .push((id.clone(), exclusion_reason(&id, &why, None)));
                }
            }
            None => allowed.push(id),
        }
    }
    let allowed_runner = |m: &Object| {
        m.get("runner")
            .and_then(Value::as_str)
            .is_some_and(|id| allowed.iter().any(|a| a == id))
    };
    let declared: Vec<Object> = model_inventory(strategy, &[], now)
        .into_iter()
        .filter(allowed_runner)
        .collect();
    let scopes: Vec<Value> = allowed
        .iter()
        .map(|id| json!({"runner": id, "account": strategy["runners"][id]["account"]}))
        .chain(declared.iter().map(|m| {
            json!({"runner": m.get("runner"), "account": m.get("account"), "binding": m.get("binding")})
        }))
        .collect();
    let mut observations = stored;
    observations.extend(status_observations(&status, &scopes, now));
    let mut task = json!({"kind": input.get("kind").cloned().unwrap_or(Value::Null),
        "difficulty": difficulty, "requirements": input["requirements"], "preferences": input["preferences"]});
    if let Some(model) = input.get("model") {
        task["model"] = model.clone();
    }
    task["provenance"] = json!("request");
    let inventory: Vec<Object> = model_inventory(strategy, &observations, now)
        .into_iter()
        .filter(allowed_runner)
        .collect();
    let built = build_candidates(strategy, &task, &inventory, &observations, now);
    let observations: Vec<Value> = observations.into_iter().map(Value::Object).collect();
    let inventory_json: Vec<Value> = inventory.iter().cloned().map(Value::Object).collect();
    let project = selection
        .as_ref()
        .map_or(Value::Null, |s| s["references"].clone());
    let strategy_hash = decision_hash(
        &json!({"dispatch": config, "inventory": inventory_json, "project": project}),
    );
    let observation_revision = decision_hash(&json!(observations));
    let request_id = decision_hash(&json!({"task": task, "strategyHash": strategy_hash,
        "observationRevision": observation_revision, "now": now}));
    // F6: preview reads learned fit through the read-only view as explain does.
    let learning = match ro.as_deref() {
        Some(ro) => apply_learned_fit(strategy, built.candidates.clone(), &task, now, &ro.store)?,
        None => {
            let store = ReadOnlyStore::open(&ctx.pacer_home, false)?;
            apply_learned_fit(strategy, built.candidates.clone(), &task, now, &store)?
        }
    };
    let timeout = config["timeoutMs"].as_f64().unwrap_or(0.0);
    let request = json!({"schemaVersion": 1, "requestId": request_id, "now": now,
        "deadline": now + timeout / 1000.0, "task": task, "candidates": learning,
        "observations": observations, "observationRevision": observation_revision,
        "strategyHash": strategy_hash, "config": config});
    if let Some(ro) = ro {
        if config["learning"]["enabled"] == true && !ro.store.has("work_reviews") {
            ro.uncertainty
                .push(info("learning_unavailable", json!({}), None));
        }
        for e in &built.excluded {
            let id = e["id"].as_str().unwrap_or_default();
            let runner = serde_json::from_str::<Value>(id)
                .ok()
                .and_then(|v| v[0].as_str().map(str::to_owned));
            let why = exclusion_reason(id, e["reason"].as_str().unwrap_or_default(), None);
            ro.exclusions.push((runner.unwrap_or_default(), why));
        }
    }
    let started = Instant::now();
    let mut result = run_ladder(request, || now + started.elapsed().as_secs_f64())?;
    let mut uncertainty: Vec<Value> = built
        .candidates
        .iter()
        .filter(|c| c.get("capacityKnown") != Some(&json!(true)))
        .map(|c| {
            json!(format!(
                "{}: capacity unknown",
                c.get("id").and_then(Value::as_str).unwrap_or_default()
            ))
        })
        .collect();
    uncertainty.extend(
        inventory
            .iter()
            .filter(|m| {
                m.get("binding")
                    .is_some_and(|b| b["kind"] == "executor-default")
            })
            .map(|m| {
                json!(format!(
                    "{}: executor default model unresolved",
                    m.get("runner").and_then(Value::as_str).unwrap_or_default()
                ))
            }),
    );
    uncertainty.push(json!(
        "Preview uses cached observations and makes no reservation; dispatch may differ."
    ));
    excluded.extend(built.excluded);
    result["excluded"] = json!(excluded);
    result["uncertainty"] = json!(uncertainty);
    Ok((result, status))
}

/// `dispatch.preview` and `dispatch.explain` once [`stays_forwarded`] keeps them native.
pub async fn dispatch_preview(
    ctx: &Ctx,
    op: &str,
    params: Value,
    bridge: &mut dyn Bridge,
) -> Result<Value, CoreError> {
    authorize(ctx)?;
    let ctx = &Ctx {
        now: now(ctx),
        ..ctx.clone()
    };
    let unavailable = || {
        CoreError::new(
            Code::Unavailable,
            "dispatch preview input needs the forwarded operation",
        )
    };
    let input = parse(op, &params).ok_or_else(unavailable)?;
    let explain = op == "dispatch.explain";
    let kind = text(&input, "kind");
    if explain && let Some(kind) = kind.filter(|k| !TASK_KINDS.contains(k)) {
        return Err(
            CoreError::new(Code::InvalidInput, format!("Unknown kind \"{kind}\""))
                .hint(format!("Allowed kinds: {}", TASK_KINDS.join(", "))),
        );
    }
    let strategy = strategy_of(ctx, &input).ok_or_else(unavailable)??;
    let r = Request {
        input: &input,
        strategy: &strategy,
        draft: input.get("strategyDraft"),
        now: ctx.now,
    };
    if !explain {
        let difficulty = "standard";
        return Ok(preview(ctx, &r, bridge, None, difficulty, false).await?.0);
    }
    let requested = match text(&input, "executor") {
        None => None,
        Some(executor) => Some(
            resolve_runner(&strategy, executor)
                .and_then(|runner| runner["id"].as_str())
                .ok_or_else(|| {
                    let runners = strategy["runners"].as_object().into_iter();
                    let configured: Vec<&str> =
                        runners.flat_map(|r| r.keys()).map(String::as_str).collect();
                    CoreError::new(
                        Code::UnknownExecutor,
                        format!("Unknown executor \"{executor}\""),
                    )
                    .hint(format!("Configured: {}", configured.join(", ")))
                })?
                .to_owned(),
        ),
    };
    let kind = json!({"value": kind, "source": "given"});
    let store = ReadOnlyStore::open(&ctx.pacer_home, false)?;
    let pause = read_pause(ctx);
    let mut ro = ReadOnly {
        store,
        exclusions: Vec::new(),
        uncertainty: Vec::new(),
        admission_hooks: false,
    };
    if text(&input, "via") == Some("delegate") {
        return explain_delegate(
            ctx,
            &r,
            bridge,
            &mut ro,
            &kind,
            requested.as_deref(),
            pause.as_ref(),
        )
        .await;
    }
    let difficulty = text(&input, "difficulty").unwrap_or("standard");
    let planner = input.get("allowDelegation") == Some(&json!(true));
    let (preview, status) = preview(ctx, &r, bridge, Some(&mut ro), difficulty, planner).await?;
    let explain = Explain {
        strategy: &strategy,
        kind: &kind,
        requested: requested.as_deref(),
        status: &status,
        store: &ro.store,
        pause: pause.as_ref(),
        admission_hooks: ro.admission_hooks,
        draft: r.draft.is_some(),
        now: ctx.now,
    };
    let ladder = LadderPreview {
        preview: &preview,
        exclusions: &ro.exclusions,
        uncertainty: &ro.uncertainty,
        engine_not_running: None,
    };
    build_explanation(&explain, &ladder)
}

/// `explainRankedDispatch` for a delegated (not conversation) request.
async fn explain_delegate(
    ctx: &Ctx,
    r: &Request<'_>,
    bridge: &mut dyn Bridge,
    ro: &mut ReadOnly,
    kind: &Value,
    requested: Option<&str>,
    pause: Option<&Value>,
) -> Result<Value, CoreError> {
    let strategy = r.strategy;
    let projects = read_project_strategies(&ctx.pacer_home).map_err(policy_error)?;
    let repo = policy_repo_read_only(ctx, text(r.input, "repo").unwrap_or_default(), &projects)?;
    let selection = project_selection(
        strategy,
        repo["key"].as_str().unwrap_or_default(),
        &projects,
    );
    let status = r.status(ctx, bridge).await?;
    let ranking = r.rank(&status, selection.as_ref(), false);
    let use_ = slot_use(&ro.store.slot_tasks()?);
    let ranked: Vec<Value> = ranking["ranked"].as_array().cloned().unwrap_or_default();
    let (guards, hooks) = r.guards(&ids(&ranking["ranked"]), bridge).await?;
    let mut blocked: Vec<(String, String)> = Vec::new();
    let mut eligible: Vec<Value> = Vec::new();
    for (candidate, guard) in ranked.into_iter().zip(guards) {
        let id = candidate["id"].as_str().unwrap_or_default().to_owned();
        match guard.or_else(|| slot_block(strategy, &id, &use_)) {
            Some(guard) => blocked.push((id, guard)),
            None => eligible.push(candidate),
        }
    }
    let limit = |id: &str| slot_limit(strategy, id).executor;
    let eligible = balance_by_load(&eligible, strategy, &use_, &by_id(&status).into(), limit);
    let input = Value::Object(r.input.clone());
    let explain = Explain {
        strategy,
        kind,
        requested,
        status: &status,
        store: &ro.store,
        pause,
        admission_hooks: hooks,
        draft: r.draft.is_some(),
        now: ctx.now,
    };
    let ranked = Ranked {
        input: &input,
        ranking: &ranking,
        guards: &blocked,
        eligible: &eligible,
        selection: selection.as_ref(),
    };
    Ok(explain_ranked(&explain, &ranked))
}

#[cfg(test)]
mod tests;
