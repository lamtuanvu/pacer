//! JSONL adapter used only by the TS/Rust parity tests. Never registered as an op.
use pacer_lifecycle::{attention, hosts, runner_check};
use serde::Serialize;
use serde_json::{Value, json, value::RawValue};
use std::io::{self, BufRead};
#[path = "decisions/scenarios.rs"]
mod scenarios;
fn encoded(v: impl Serialize) -> Result<String, serde_json::Error> {
    serde_json::to_string(&v)
}
pub fn run(c: &Value) -> Result<String, serde_json::Error> {
    let time = c["now"].as_f64().unwrap_or(100.0);
    match c["op"].as_str().unwrap_or("") {
        "clients" => encoded(scenarios::clients(c)),
        "attention" => encoded(attention::derive(&c["input"], time)),
        "attention.tasks" => encoded(attention::derive_tasks(&c["input"], time)),
        "attention.store" => {
            let mut state = c.get("store").cloned().unwrap_or(json!({}));
            let mut time = time;
            let mut results: Vec<Box<RawValue>> = vec![];
            for action in c["actions"].as_array().into_iter().flatten() {
                if let Some(t) = action["now"].as_f64() {
                    time = t;
                }
                let items = action["items"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .map(attention::Item::from_value)
                    .collect::<Vec<_>>();
                let id = action["id"].as_str().unwrap_or("");
                let result = match action["type"].as_str().unwrap_or("") {
                    "apply" => encoded(attention::apply(&mut state, items, time)),
                    "dismiss" => encoded(
                        attention::dismiss(&mut state, id, &items, time)
                            .unwrap_or_else(|e| e.value()),
                    ),
                    _ => encoded(
                        attention::snooze(
                            &mut state,
                            id,
                            action["duration"].as_str().unwrap_or(""),
                            &items,
                            time,
                        )
                        .unwrap_or_else(|e| e.value()),
                    ),
                }?;
                results.push(RawValue::from_string(result)?);
            }
            #[derive(Serialize)]
            struct StoreResult {
                results: Vec<Box<RawValue>>,
                state: Value,
            }
            encoded(StoreResult { results, state })
        }
        "notify" => encoded(scenarios::notify(c)),
        "host.setupPlan" => {
            let candidates=c.get("candidates").cloned().unwrap_or_else(||json!([{"path":"/fixture/repo","origin":c["local"]["origin"].as_str().unwrap_or("https://github.com/acme/api.git")} ]));
            encoded(
                hosts::setup_plan(
                    c["alias"].as_str().unwrap_or(""),
                    c["key"].as_str().unwrap_or(""),
                    c["options"]["consent"] == true,
                    &c["host"]["repos"],
                    candidates.as_array().map(Vec::as_slice).unwrap_or(&[]),
                )
                .unwrap_or_else(|e| e.value()),
            )
        }
        "host.check" => encoded(hosts::check(c)),
        "host.setup" => encoded(hosts::setup(c)),
        "host.clean" => encoded(hosts::clean(c)),
        "host.summary" => encoded(hosts::summary(c)),
        "host.list" => encoded(hosts::list(c)),
        "runner.check" => encoded(runner_check::check(c)),
        op if op.starts_with("job.") => encoded(scenarios::jobs(c)),
        _ => encoded(json!({"error":"unknown fixture operation"})),
    }
}
fn main() -> Result<(), Box<dyn std::error::Error>> {
    for line in io::stdin().lock().lines() {
        let line = line?;
        let c: Value = serde_json::from_str(&line)?;
        println!("{}", run(&c)?);
    }
    Ok(())
}
