//! Differential driver for `test/dispatch-decision-parity.test.ts`: one JSON request
//! per stdin line, one `JSON.stringify` reply per stdout line.
#![allow(clippy::result_large_err)]
use pacer_dispatch::{
    Object, ReadOnlyStore, SelectOptions, build_candidates, decision_hash, evaluate_ladder,
    model_inventory, parse_observation, select_model, status_observations, target_tier,
    tier_buckets,
};
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
    read().unwrap_or_else(|e| json!({"error": {"code": e.code, "message": e.message}}))
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
