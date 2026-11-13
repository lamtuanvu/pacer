//! Route explanations: `build` in `src/core/dispatch-explain.ts` (ladder
//! previews) and the reply half of `explainRankedDispatch`
//! (`src/core/dispatch-explain-ranked.ts`). The caller gathers what TypeScript
//! reads from Core state (the read-only preview and its exclusions, the ranking
//! and its guards, status, pause and classifier configuration) and passes it in.
#![allow(clippy::result_large_err)]
use pacer_foundation::api::{Code, CoreError};
use serde_json::{Value, json};

use crate::hash::decision_hash;
use crate::js::{Object, js_min, js_string, num, object, strict_eq, to_number, truthy};
use crate::ladder::evaluate_ladder;
use crate::readonly::ReadOnlyStore;
use crate::reasons::{exclusion_reason, reason};

/// The inputs both explanation modes share.
pub struct Explain<'a> {
    /// The strategy, or the validated draft.
    pub strategy: &'a Value,
    /// `{value, source}`.
    pub kind: &'a Value,
    /// The runner id an `executor` input resolved to.
    pub requested: Option<&'a str>,
    /// The cache-only status (`accounts`, `mode`).
    pub status: &'a Value,
    /// The read-only task store the explanation opened.
    pub store: &'a ReadOnlyStore,
    /// `readPause(ctx)`.
    pub pause: Option<&'a Value>,
    /// `classifierConfig(strategy).configured`; false when it throws.
    pub admission_hooks: bool,
    /// `!!input.strategyDraft`.
    pub draft: bool,
    pub now: f64,
}

/// What the read-only `previewDispatch` returns and leaves in its
/// `ReadOnlyDispatch`.
pub struct LadderPreview<'a> {
    /// The `DispatchPreview` (`request`, `proposal`, `engine`, `validation`,
    /// `recommendedAction`, `fallback`).
    pub preview: &'a Value,
    /// `ro.exclusions` in push order: `(runner, reason)`.
    pub exclusions: &'a [(String, Value)],
    pub uncertainty: &'a [Value],
    pub engine_not_running: Option<&'a str>,
}

/// What `explainRankedDispatch` gathers before it composes the reply.
pub struct Ranked<'a> {
    /// The parsed explain input (`requirements`, `preferences`, `model`, `difficulty`).
    pub input: &'a Value,
    /// `rankExecutors` after `conversationFallback`: `{ranked, excluded}`.
    pub ranking: &'a Value,
    /// `(runner, guard text)` for each ranked runner a guard left out, in ranking order.
    pub guards: &'a [(String, String)],
    /// The other ranked entries, in the order `balanceByLoad` leaves them.
    pub eligible: &'a [Value],
    /// `projectSnapshot(...).selection`.
    pub selection: Option<&'a Value>,
}

fn info(code: &str, facts: Value, subject: Option<&str>) -> Value {
    reason(code, "info", facts, subject, None)
}

fn str_of<'a>(object: &'a Object, key: &str) -> Option<&'a str> {
    object.get(key).and_then(Value::as_str)
}

fn list(value: &Value) -> &[Value] {
    value.as_array().map_or(&[], Vec::as_slice)
}

/// `status.accounts?.find(a => a.name === name)`.
fn account<'a>(status: &'a Value, name: Option<&Value>) -> Option<&'a Value> {
    list(&status["accounts"])
        .iter()
        .find(|a| strict_eq(a.get("name"), name))
}

/// The planner usage window, when the planner account's usage is measured.
fn planner_window(strategy: &Value, status: &Value) -> Value {
    let planner = strategy["planner"].get("account");
    match account(status, planner) {
        Some(a) if a.get("usedPct") != Some(&Value::Null) => object([
            ("account", planner.cloned()),
            ("usedPct", a.get("usedPct").cloned()),
            ("pacePct", a.get("pacePct").cloned()),
            ("mode", status.get("mode").cloned()),
        ]),
        _ => Value::Null,
    }
}

fn planner(strategy: &Value, chosen: &Value, window: Value) -> Value {
    let executor = strict_eq(chosen.get("account"), strategy["planner"].get("account"));
    let why = if executor {
        "planner_is_executor"
    } else {
        "planner_not_measured"
    };
    json!({"state": "unknown", "reason": why, "window": window})
}

/// `{executor, account, runner, model, host}` for a chosen candidate.
/// `c.binding`, which TypeScript dereferences and so throws on when it is missing or null.
fn binding(c: &Object) -> Result<&Value, CoreError> {
    match c.get("binding") {
        Some(binding) if !binding.is_null() => Ok(binding),
        _ => Err(CoreError::new(Code::Internal, "A candidate has no binding")),
    }
}

fn chosen_of(c: &Object, strategy: &Value) -> Result<Value, CoreError> {
    let binding = binding(c)?;
    let model = if binding.get("kind") == Some(&json!("exact")) {
        object([
            ("kind", Some(json!("exact"))),
            ("id", binding.get("id").cloned()),
        ])
    } else {
        json!({"kind": "executor-default"})
    };
    let host = strategy["runners"][js_string(c.get("runner"))].get("host");
    Ok(object([
        ("executor", c.get("executor").cloned()),
        ("account", c.get("account").cloned()),
        ("runner", c.get("runner").cloned()),
        ("model", Some(model)),
        (
            "host",
            Some(
                host.filter(|h| !h.is_null())
                    .cloned()
                    .unwrap_or(Value::Null),
            ),
        ),
    ]))
}

fn skip_reason(step: Option<&Value>, kind: Option<&Value>) -> &'static str {
    match step.and_then(|s| s["match"].get("kind")) {
        Some(wanted) if !strict_eq(Some(wanted), kind) => "step_kind_mismatch",
        _ => "step_no_candidates",
    }
}

/// `new Map(entries)` keyed by a JSON value: first position, last value.
pub(crate) fn by_key<'a, T>(entries: impl IntoIterator<Item = (Option<&'a Value>, T)>) -> Vec<T> {
    let mut out: Vec<(Option<&Value>, T)> = Vec::new();
    for (key, value) in entries {
        match out.iter_mut().find(|(k, _)| strict_eq(*k, key)) {
            Some(slot) => slot.1 = value,
            None => out.push((key, value)),
        }
    }
    out.into_iter().map(|(_, value)| value).collect()
}

/// An observation without its clock-derived fields (`hoursLeft`, timestamps).
fn strip_clock(observation: &Value) -> Value {
    let mut o = observation.as_object().cloned().unwrap_or_default();
    if o.get("state") == Some(&json!("known"))
        && let Some(Value::Object(value)) = o.get_mut("value")
    {
        let windows = value.remove("windows").filter(|w| !w.is_null());
        if let Some(windows) = windows {
            let windows = list(&windows).iter().map(|w| {
                let mut w = w.as_object().cloned().unwrap_or_default();
                w.remove("hoursLeft");
                Value::Object(w)
            });
            value.insert("windows".into(), Value::Array(windows.collect()));
        }
    }
    o.insert("observedAt".into(), json!(0));
    o.insert("expiresAt".into(), json!(0));
    Value::Object(o)
}

fn paused(pause: &Value) -> Value {
    reason(
        "paused",
        "fail",
        object([("until", pause.get("until").cloned())]),
        None,
        None,
    )
}

fn pause_until(pause: Option<&Value>) -> Value {
    pause
        .and_then(|p| p.get("until"))
        .filter(|u| !u.is_null())
        .cloned()
        .unwrap_or(Value::Null)
}

/// `build(...)`: the explanation of a read-only ladder preview.
pub fn build_explanation(e: &Explain, p: &LadderPreview) -> Result<Value, CoreError> {
    let strategy = e.strategy;
    let preview = p.preview;
    let request = &preview["request"];
    let config = &request["config"];
    let steps = list(&config["steps"]);
    let candidates: Vec<&Object> = list(&request["candidates"])
        .iter()
        .filter_map(Value::as_object)
        .collect();
    let find = |id: &Value| {
        candidates
            .iter()
            .copied()
            .find(|c| strict_eq(c.get("id"), Some(id)))
    };
    let runner = |c: &Object| c.get("runner").cloned().unwrap_or(Value::Null);
    let mut reasons: Vec<Value> = Vec::new();
    let mut uncertainty = vec![info("cached_preview", json!({}), None)];
    uncertainty.extend(p.uncertainty.iter().cloned());
    let proposal = &preview["proposal"];
    let ranked = proposal["state"] == "ranked";

    // Ranked runners, then those the ladder reaches in a later step.
    let mut eligible: Vec<(&Object, Option<Value>)> = Vec::new();
    let mut seen: Vec<Value> = Vec::new();
    for choice in list(&proposal["choices"]).iter().filter(|_| ranked) {
        if let Some(c) = find(&choice["id"])
            && !seen.contains(&runner(c))
        {
            seen.push(runner(c));
            eligible.push((c, None));
        }
    }
    let mut step = Value::Null;
    if ranked {
        let id = proposal.get("step");
        let index = steps
            .iter()
            .position(|s| strict_eq(s.get("id"), id))
            .map_or(-1, |i| i as i64);
        let kind = request["task"].get("kind");
        let skipped: Vec<Value> = list(&proposal["skipped"])
            .iter()
            .map(|s| {
                let step = steps.iter().find(|x| strict_eq(x.get("id"), Some(s)));
                json!({"id": s, "reason": skip_reason(step, kind)})
            })
            .collect();
        step = object([
            ("id", id.cloned()),
            ("index", Some(json!(index))),
            ("skipped", Some(Value::Array(skipped))),
        ]);
        if preview["engine"]["id"] == "ladder" {
            for i in (index + 1).max(0) as usize..steps.len() {
                let mut sliced = config.as_object().cloned().unwrap_or_default();
                sliced.insert("steps".into(), Value::Array(steps[i..].to_vec()));
                let later = evaluate_ladder(request, &Value::Object(sliced));
                if later["state"] != "ranked" {
                    break;
                }
                for choice in list(&later["choices"]) {
                    if let Some(c) = find(&choice["id"])
                        && !seen.contains(&runner(c))
                    {
                        seen.push(runner(c));
                        eligible.push((c, later.get("step").cloned()));
                    }
                }
            }
        }
    }

    let action = &preview["recommendedAction"];
    let mut top = eligible.first().map(|e| e.0);
    let mut outcome = match (top, action.as_str()) {
        (Some(_), _) => "select",
        (None, Some("fail")) => "fail",
        _ => "queue",
    };
    let mut excluded: Vec<(&str, &Value)> = Vec::new();
    for (r, why) in p.exclusions {
        if !excluded.iter().any(|(seen, _)| seen == r) {
            excluded.push((r, why));
        }
    }

    let mut refused = false;
    if let Some(requested) = e.requested {
        let facts = json!({"executor": requested});
        reasons.push(info("override", facts, Some(requested)));
        let hit = eligible
            .iter()
            .position(|(c, s)| str_of(c, "runner") == Some(requested) && s.is_none());
        let why = excluded.iter().find(|(r, _)| *r == requested).map(|e| e.1);
        let code = why.and_then(|w| w.get("code")).and_then(Value::as_str);
        if let Some(i) = hit {
            let hit = eligible.remove(i);
            top = Some(hit.0);
            outcome = "override";
            eligible.insert(0, hit);
        } else if let (Some(why), Some("blocked_by_user" | "quota_exhausted")) = (why, code) {
            reasons.push(why.clone());
            (top, outcome, refused) = (None, "fail", true);
        } else if let (Some(why), Some("executor_busy" | "machine_busy")) = (why, code) {
            // A full slot makes the runner queue the task for that executor rather than fall back.
            reasons.push(why.clone());
            (top, outcome, refused) = (None, "queue", true);
        } else {
            let code = why.and_then(|w| w.get("code")).filter(|c| !c.is_null());
            let facts = json!({"requested": requested,
                "reason": code.cloned().unwrap_or(json!("not_ranked"))});
            reasons.push(reason(
                "override_unavailable",
                "fail",
                facts,
                Some(requested),
                None,
            ));
            reasons.extend(why.cloned());
        }
    }

    let valid = preview["validation"] == "valid";
    let mut chosen = Value::Null;
    if let Some(pause) = e.pause {
        (outcome, top) = ("queue", None);
        reasons.push(paused(pause));
    } else if !valid {
        outcome = if action == "fail" { "fail" } else { "queue" };
        let facts = object([("validation", preview.get("validation").cloned())]);
        reasons.push(reason("engine_failed", "fail", facts, None, None));
    }
    if let Some(top) = top.filter(|_| outcome != "fail") {
        chosen = chosen_of(top, strategy)?;
        let step_id = step.get("id").filter(|id| !id.is_null()).cloned();
        let facts = object([
            ("stepId", Some(step_id.unwrap_or(json!("")))),
            ("kind", e.kind.get("value").cloned()),
        ]);
        reasons.push(reason("step_match", "pass", facts, None, None));
        let subject = str_of(top, "runner");
        let headroom = top.get("headroom");
        if headroom == Some(&Value::Null) {
            reasons.push(info("capacity_unknown", json!({}), subject));
        } else {
            let free = to_number(headroom) - to_number(config.get("reservePct"));
            let pace = account(e.status, top.get("account"))
                .and_then(|a| a.get("pacePct"))
                .filter(|p| !p.is_null());
            let facts = object([
                ("headroomPct", headroom.cloned()),
                ("pacePct", Some(pace.cloned().unwrap_or(Value::Null))),
            ]);
            let comfortable = free >= to_number(config.get("comfortablePct"));
            let code = if comfortable {
                "capacity_comfortable"
            } else {
                "capacity_usable"
            };
            reasons.push(reason(code, "pass", facts, subject, None));
        }
    } else if e.pause.is_none() && !refused && valid && top.is_none() {
        let skipped = list(&proposal["skipped"]).len();
        reasons.push(reason(
            "no_step_matched",
            "fail",
            json!({"skipped": skipped}),
            None,
            None,
        ));
    }

    let mut fallbacks: Vec<Value> = Vec::new();
    let mut listed: Vec<Value> = chosen.get("runner").cloned().into_iter().collect();
    for (c, later) in eligible.iter().filter(|_| e.pause.is_none()) {
        if listed.contains(&runner(c)) {
            continue;
        }
        listed.push(runner(c));
        let at = match later.as_ref().filter(|s| truthy(Some(s))) {
            Some(later) => Some(later.clone()),
            None => step.get("id").cloned(),
        };
        fallbacks.push(object([
            ("executor", c.get("executor").cloned()),
            ("runner", c.get("runner").cloned()),
            ("account", c.get("account").cloned()),
            ("state", Some(json!("eligible"))),
            ("step", at),
        ]));
    }
    for (r, why) in &excluded {
        let config = &strategy["runners"][*r];
        if listed.contains(&json!(r)) || !truthy(strategy["runners"].get(*r)) {
            continue;
        }
        listed.push(json!(r));
        fallbacks.push(object([
            ("executor", config.get("agent").cloned()),
            ("runner", Some(json!(r))),
            ("account", config.get("account").cloned()),
            ("state", Some(json!("excluded"))),
            ("reason", Some((*why).clone())),
        ]));
    }

    // With nothing chosen, unmeasured capacity is the likeliest reason, so every candidate counts.
    let mut in_play: Vec<&Object> = top.into_iter().collect();
    in_play.extend(eligible.iter().map(|e| e.0));
    if top.is_none() {
        in_play.extend(candidates.iter().copied());
    }
    for c in by_key(in_play.iter().map(|c| (c.get("runner"), *c))) {
        let subject = str_of(c, "runner");
        if !truthy(c.get("capacityKnown")) {
            uncertainty.push(info("capacity_unmeasured", json!({}), subject));
        }
        if binding(c)?["kind"] == "executor-default" {
            uncertainty.push(info("default_model_unresolved", json!({}), subject));
        }
    }
    let pools: Vec<&Value> = in_play
        .iter()
        .flat_map(|c| list(c.get("poolIds").unwrap_or(&Value::Null)))
        .collect();
    for reservation in e.store.reservations()? {
        // `poolIds.some` throws in TypeScript for anything but a list.
        let Some(ids) = reservation.pool_ids.as_array() else {
            let message = "A work reservation's pools are not a list";
            return Err(CoreError::new(Code::Internal, message));
        };
        if ids
            .iter()
            .any(|id| pools.iter().any(|p| strict_eq(Some(p), Some(id))))
        {
            uncertainty.push(info("reserved_capacity", json!({}), None));
            break;
        }
    }
    if e.admission_hooks {
        uncertainty.push(info("admission_hooks", json!({}), None));
    }

    let not_running = p.engine_not_running.filter(|engine| !engine.is_empty());
    let fallback = preview
        .get("fallback")
        .filter(|f| !f.is_null())
        .cloned()
        .or_else(|| not_running.map(|from| json!({"from": from, "reason": "engine_not_running"})));
    if let Some(engine) = not_running {
        uncertainty.push(info("engine_not_running", json!({"engine": engine}), None));
    }
    let window = planner_window(strategy, e.status);
    let planner = planner(strategy, &chosen, window);

    let observations = list(&request["observations"]);
    let observed: Vec<f64> = observations
        .iter()
        .filter(|o| o["state"] == "known")
        .map(|o| to_number(o.get("observedAt")))
        .collect();
    let candidates: Vec<Value> = candidates
        .iter()
        .map(|c| {
            let mut c = (*c).clone();
            c.remove("burn");
            Value::Object(c)
        })
        .collect();
    let exclusions: Vec<Value> = p
        .exclusions
        .iter()
        .map(|(r, why)| json!([r, why["code"], why["facts"]]))
        .collect();
    let revision = decision_hash(&object([
        ("task", request.get("task").cloned()),
        ("candidates", Some(Value::Array(candidates))),
        ("strategyHash", request.get("strategyHash").cloned()),
        (
            "observations",
            Some(observations.iter().map(strip_clock).collect()),
        ),
        ("exclusions", Some(Value::Array(exclusions))),
        ("paused", Some(pause_until(e.pause))),
        (
            "requested",
            Some(e.requested.map_or(Value::Null, |r| json!(r))),
        ),
    ]));
    let source = if truthy(strategy.get("dispatch")) {
        "strategy"
    } else {
        "built-in"
    };
    let mut engine = preview["engine"].as_object().cloned().unwrap_or_default();
    if let Some(fallback) = fallback {
        engine.insert("fallback".into(), fallback);
    }
    Ok(json!({
        "schemaVersion": 1, "mode": "ladder", "revision": revision, "at": num(e.now.floor()),
        "observedAt": if observed.is_empty() { Value::Null } else { num(js_min(observed)) },
        "outcome": outcome, "kind": e.kind,
        "strategy": object([("name", strategy.get("name").cloned()),
            ("draft", Some(json!(e.draft))), ("source", Some(json!(source)))]),
        "engine": engine, "chosen": chosen, "step": step, "reasons": reasons,
        "fallbacks": fallbacks, "planner": planner, "uncertainty": uncertainty,
    }))
}

/// The reply of `explainRankedDispatch` for unmanaged work: executor ranking,
/// without model candidates or native-control enforcement.
pub fn explain_ranked(e: &Explain, r: &Ranked) -> Value {
    let strategy = e.strategy;
    let runners = &strategy["runners"];
    let input = r.input;
    let mut exclusions: Vec<(Value, Value)> = Vec::new();
    let mut set = |id: Value, why: Value| match exclusions
        .iter_mut()
        .find(|(k, _)| strict_eq(Some(k), Some(&id)))
    {
        Some(slot) => slot.1 = why,
        None => exclusions.push((id, why)),
    };
    for excluded in list(&r.ranking["excluded"]) {
        let id = js_string(excluded.get("id"));
        let text = js_string(excluded.get("reason"));
        let why = exclusion_reason(&id, &text, excluded.get("eligibility"));
        set(excluded.get("id").cloned().unwrap_or(Value::Null), why);
    }
    for (id, guard) in r.guards {
        set(json!(id), exclusion_reason(id, guard, None));
    }

    let mut reasons: Vec<Value> = Vec::new();
    let mut uncertainty = vec![info("cached_preview", json!({}), None)];
    let preferences = &input["preferences"];
    let ignored: Vec<&str> = [
        (
            "requirements",
            input["requirements"]
                .as_object()
                .is_some_and(|m| !m.is_empty()),
        ),
        (
            "preferences",
            [&preferences["models"], &preferences["strengths"]]
                .iter()
                .any(|l| !list(l).is_empty()),
        ),
        ("model", truthy(input.get("model"))),
        ("difficulty", truthy(input.get("difficulty"))),
    ]
    .into_iter()
    .filter_map(|(field, supplied)| supplied.then_some(field))
    .collect();
    if !ignored.is_empty() {
        let facts = json!({"fields": ignored.join(", ")});
        uncertainty.push(info("ranked_inputs_ignored", facts, None));
    }
    if !e.store.available() {
        uncertainty.push(info("tasks_unavailable", json!({}), None));
    }
    if e.admission_hooks {
        uncertainty.push(info("admission_hooks", json!({}), None));
    }
    let id_of = |entry: &Value| js_string(entry.get("id"));
    let mut top = r.eligible.first();
    let mut outcome = if top.is_some() { "select" } else { "queue" };
    if let Some(requested) = e.requested {
        let facts = json!({"executor": requested});
        reasons.push(info("override", facts, Some(requested)));
        let hit = r.eligible.iter().find(|x| x["id"] == requested);
        let why = exclusions
            .iter()
            .find(|(k, _)| *k == requested)
            .map(|e| &e.1);
        let code = why.and_then(|w| w["code"].as_str());
        let refusing = [
            "blocked_by_user",
            "quota_exhausted",
            "executor_busy",
            "machine_busy",
        ];
        if hit.is_some() {
            (top, outcome) = (hit, "override");
        } else if let Some(why) = why.filter(|_| code.is_some_and(|c| refusing.contains(&c))) {
            top = None;
            let fail = matches!(code, Some("blocked_by_user" | "quota_exhausted"));
            outcome = if fail { "fail" } else { "queue" };
            reasons.push(why.clone());
        } else {
            let code = why.and_then(|w| w.get("code")).filter(|c| !c.is_null());
            let facts = json!({"requested": requested,
                "reason": code.cloned().unwrap_or(json!("not_ranked"))});
            let text =
                format!("{requested} cannot take the task; the ranked pick is used instead.");
            let refusal = reason(
                "override_unavailable",
                "fail",
                facts,
                Some(requested),
                Some(&text),
            );
            reasons.push(refusal);
            reasons.extend(why.cloned());
        }
    }
    if let Some(pause) = e.pause {
        (top, outcome) = (None, "queue");
        reasons.push(paused(pause));
    }
    let choice = |id: &str| {
        let runner = &runners[id];
        object([
            ("executor", runner.get("agent").cloned()),
            ("runner", Some(json!(id))),
            ("account", runner.get("account").cloned()),
            ("model", Some(json!({"kind": "executor-default"}))),
            (
                "host",
                Some(
                    runner
                        .get("host")
                        .filter(|h| !h.is_null())
                        .cloned()
                        .unwrap_or(Value::Null),
                ),
            ),
        ])
    };
    let policy = strategy["pacing"].get("policy");
    let rank_match = |entry: &Value| {
        let facts = object([
            ("policy", policy.cloned()),
            ("score", entry.get("score").cloned()),
            ("reason", entry.get("reason").cloned()),
        ]);
        let text = entry
            .get("reason")
            .filter(|t| !t.is_null())
            .map(|t| js_string(Some(t)));
        reason(
            "rank_match",
            "pass",
            facts,
            Some(&id_of(entry)),
            text.as_deref(),
        )
    };
    let chosen = top.map_or(Value::Null, |t| choice(&id_of(t)));
    if let Some(top) = top {
        reasons.push(rank_match(top));
    } else if e.pause.is_none() && reasons.is_empty() {
        reasons.push(reason("no_executor_ranked", "fail", json!({}), None, None));
    }
    let fallback = |id: &str, state: &str, why: Value| {
        object([
            ("executor", runners[id].get("agent").cloned()),
            ("runner", Some(json!(id))),
            ("account", runners[id].get("account").cloned()),
            ("state", Some(json!(state))),
            ("reason", Some(why)),
        ])
    };
    let top_id = top.and_then(|t| t.get("id"));
    let mut fallbacks: Vec<Value> = r
        .eligible
        .iter()
        .filter(|x| e.pause.is_none() && !strict_eq(x.get("id"), top_id))
        .map(|x| fallback(&id_of(x), "eligible", rank_match(x)))
        .collect();
    for (id, why) in &exclusions {
        let id = js_string(Some(id));
        if truthy(runners.get(&id)) {
            fallbacks.push(fallback(&id, "excluded", why.clone()));
        }
    }
    for entry in r.eligible {
        uncertainty.push(info(
            "default_model_unresolved",
            json!({}),
            Some(&id_of(entry)),
        ));
    }
    let window = planner_window(strategy, e.status);
    let accounts = e.status.get("accounts").filter(|a| !a.is_null());
    let captured: Vec<f64> = accounts
        .map(list)
        .unwrap_or_default()
        .iter()
        .filter(|a| a.get("capturedAt") != Some(&Value::Null))
        .map(|a| to_number(a.get("capturedAt")))
        .collect();
    let ranked: Vec<Value> = list(&r.ranking["ranked"])
        .iter()
        .map(|entry| {
            let mut entry = entry.as_object().cloned().unwrap_or_default();
            entry.remove("eligibility");
            Value::Object(entry)
        })
        .collect();
    let hashed_exclusions: Vec<Value> = exclusions
        .iter()
        .map(|(id, why)| json!([id, why["code"], why["facts"]]))
        .collect();
    let references = r
        .selection
        .and_then(|s| s.get("references"))
        .filter(|v| !v.is_null());
    let revision = decision_hash(&object([
        ("mode", Some(json!("ranked"))),
        ("kind", Some(e.kind.clone())),
        ("ranked", Some(Value::Array(ranked))),
        ("exclusions", Some(Value::Array(hashed_exclusions))),
        (
            "requested",
            Some(e.requested.map_or(Value::Null, |r| json!(r))),
        ),
        ("paused", Some(pause_until(e.pause))),
        ("runners", strategy.get("runners").cloned()),
        ("pacing", strategy.get("pacing").cloned()),
        (
            "selection",
            Some(references.cloned().unwrap_or(Value::Null)),
        ),
        ("planner", Some(window.clone())),
        (
            "accounts",
            accounts.map(|a| {
                list(a)
                    .iter()
                    .map(|a| {
                        object([
                            ("name", a.get("name").cloned()),
                            ("usedPct", a.get("usedPct").cloned()),
                            ("pacePct", a.get("pacePct").cloned()),
                        ])
                    })
                    .collect()
            }),
        ),
    ]));
    let source = if truthy(r.selection) {
        "project"
    } else {
        "strategy"
    };
    json!({
        "schemaVersion": 1, "mode": "ranked", "revision": revision, "at": num(e.now.floor()),
        "observedAt": if captured.is_empty() { Value::Null } else { num(js_min(captured)) },
        "outcome": outcome, "kind": e.kind,
        "strategy": object([("name", strategy.get("name").cloned()),
            ("draft", Some(json!(e.draft))), ("source", Some(json!(source)))]),
        "engine": {"id": "rankExecutors", "version": "1"}, "chosen": chosen, "step": null,
        "reasons": reasons, "fallbacks": fallbacks,
        "planner": planner(strategy, &chosen, window), "uncertainty": uncertainty,
    })
}
