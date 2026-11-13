//! Differential driver for `test/dispatch-decision-parity.test.ts`: one JSON request
//! per stdin line, one `JSON.stringify` reply per stdout line.
#![allow(clippy::result_large_err)]
use pacer_dispatch::{
    Explain, LadderPreview, Object, Ranked, ReadOnlyStore, SelectOptions, apply_learned_fit,
    build_candidates, build_explanation, decision_hash, evaluate_ladder, exclusion_reason,
    explain_ranked, model_inventory, parse_observation, reason, select_model, status_observations,
    target_tier, tier_buckets,
};
use pacer_foundation::api::CoreError;
use pacer_js_json::stringify;
use serde_json::{Value, json};
use std::io::{self, BufRead, Write};

fn objects(value: &Value) -> Vec<Object> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|v| v.as_object().cloned())
        .collect()
}

fn observations(value: &Value) -> Vec<Object> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(parse_observation)
        .collect()
}

fn now(input: &Value) -> f64 {
    input["now"].as_f64().unwrap_or(f64::INFINITY)
}

fn readonly(input: &Value) -> Value {
    let home = input["pacerHome"].as_str().unwrap_or_default();
    let read = || {
        let store = ReadOnlyStore::open(home.as_ref(), input["strict"] == true)?;
        let reservations: Vec<Value> = store
            .reservations()?
            .into_iter()
            .map(|r| json!({"poolIds": r.pool_ids, "estimate": r.estimate}))
            .collect();
        Ok::<_, pacer_foundation::api::CoreError>(json!({
            "available": store.available(),
            "immutable": store.immutable(),
            "running": store.running_tasks()?,
            "slots": store.slot_tasks()?,
            "observations": store.stored_observations(now(input))?,
            "reservations": reservations,
        }))
    };
    read().unwrap_or_else(failure)
}

fn failure(e: CoreError) -> Value {
    json!({"error": {"code": e.code, "message": e.message}})
}

fn store(input: &Value) -> Result<ReadOnlyStore, CoreError> {
    let home = input["pacerHome"].as_str().unwrap_or_default();
    ReadOnlyStore::open(home.as_ref(), input["strict"] == true)
}

fn learned(input: &Value) -> Result<Value, CoreError> {
    let candidates = objects(&input["candidates"]);
    let task = &input["task"];
    let fitted = apply_learned_fit(
        &input["strategy"],
        candidates,
        task,
        now(input),
        &store(input)?,
    )?;
    Ok(json!(fitted))
}

/// Explanations: `{runner, reason}` exclusions and `[id, text]` guards, as TypeScript keeps them.
fn explain(input: &Value, ranked: bool) -> Result<Value, CoreError> {
    let store = store(input)?;
    let e = Explain {
        strategy: &input["strategy"],
        kind: &input["kind"],
        requested: input["requested"].as_str(),
        status: &input["status"],
        store: &store,
        pause: input.get("pause").filter(|p| !p.is_null()),
        admission_hooks: input["admissionHooks"] == true,
        draft: input["draft"] == true,
        now: now(input),
    };
    let pairs = |key: &str, first: &str, second: &str| -> Vec<(String, Value)> {
        let items = input[key].as_array().into_iter().flatten();
        let pair = |v: &Value| {
            (
                v[first].as_str().unwrap_or_default().to_owned(),
                v[second].clone(),
            )
        };
        items.map(pair).collect()
    };
    if ranked {
        let guards: Vec<(String, String)> = pairs("guards", "id", "text")
            .into_iter()
            .map(|(id, text)| (id, text.as_str().unwrap_or_default().to_owned()))
            .collect();
        let eligible = input["eligible"].as_array().cloned().unwrap_or_default();
        let r = Ranked {
            input: &input["input"],
            ranking: &input["ranking"],
            guards: &guards,
            eligible: &eligible,
            selection: input.get("selection").filter(|s| !s.is_null()),
        };
        return Ok(explain_ranked(&e, &r));
    }
    let exclusions = pairs("exclusions", "runner", "reason");
    let uncertainty = input["uncertainty"].as_array().cloned().unwrap_or_default();
    let p = LadderPreview {
        preview: &input["preview"],
        exclusions: &exclusions,
        uncertainty: &uncertainty,
        engine_not_running: input["engineNotRunning"].as_str(),
    };
    build_explanation(&e, &p)
}

fn select(input: &Value) -> Value {
    let records = objects(&input["records"]);
    let o = &input["options"];
    let usable = o.get("usable").and_then(Value::as_array);
    let is_usable = |r: &Object| usable.is_some_and(|u| u.contains(&r["runner"]));
    let options = SelectOptions {
        difficulty: o["difficulty"].as_str().unwrap_or_default(),
        targets: &o["targets"],
        min_tier: o["minTier"].as_str(),
        pin: o["pin"].as_str(),
        fixed_executor: o["fixedExecutor"] == true,
        default_model: o["defaultModel"].as_str(),
        is_usable: usable.map(|_| &is_usable as &dyn Fn(&Object) -> bool),
    };
    select_model(&records, &options).to_json()
}

fn run(input: &Value) -> Value {
    match input["fn"].as_str().unwrap_or_default() {
        "hash" => json!(decision_hash(&input["value"])),
        "parse" => parse_observation(&input["value"]).map_or(Value::Null, Value::Object),
        "inventory" => json!(model_inventory(
            &input["strategy"],
            &observations(&input["observations"]),
            now(input),
        )),
        "candidates" => {
            let built = build_candidates(
                &input["strategy"],
                &input["task"],
                &objects(&input["inventory"]),
                &observations(&input["observations"]),
                now(input),
            );
            json!({"candidates": built.candidates, "excluded": built.excluded})
        }
        "ladder" => evaluate_ladder(&input["request"], &input["config"]),
        "targetTier" => {
            let target = target_tier(
                input["difficulty"].as_str().unwrap_or_default(),
                &input["targets"],
                input["minTier"].as_str(),
            );
            target.map_or(json!({}), |t| json!({"target": t}))
        }
        "tierBuckets" => {
            let items = objects(&input["items"]);
            json!(tier_buckets(&items, input["target"].as_str()))
        }
        "select" => select(input),
        "status" => {
            let scopes = input["scopes"].as_array().cloned().unwrap_or_default();
            json!(status_observations(&input["status"], &scopes, now(input)))
        }
        "readonly" => readonly(input),
        "reason" => reason(
            input["code"].as_str().unwrap_or_default(),
            input["outcome"].as_str().unwrap_or_default(),
            input["facts"].clone(),
            input["subject"].as_str(),
            input["text"].as_str(),
        ),
        "exclusion" => exclusion_reason(
            input["subject"].as_str().unwrap_or_default(),
            input["text"].as_str().unwrap_or_default(),
            input.get("eligibility"),
        ),
        "learnedFit" => learned(input).unwrap_or_else(failure),
        "explain" => explain(input, false).unwrap_or_else(failure),
        "explainRanked" => explain(input, true).unwrap_or_else(failure),
        other => json!({"error": format!("unknown fn {other}")}),
    }
}

fn main() -> io::Result<()> {
    let mut stdout = io::BufWriter::new(io::stdout().lock());
    for line in io::stdin().lock().lines() {
        let input: Value = serde_json::from_str(&line?).map_err(io::Error::other)?;
        stdout.write_all(stringify(&run(&input)).as_bytes())?;
        stdout.write_all(b"\n")?;
    }
    stdout.flush()
}
