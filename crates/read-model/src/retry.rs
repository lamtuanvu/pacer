//! `task.retry_options` (TS `optionsFor` in `src/core/task-detail.ts`) from
//! usage-broker provider readings. It covers tasks without a project policy file
//! or remote runners; callers forward those inputs to TypeScript.
use crate::{Error, capacity, js::*, tasks::task_data};
use pacer_config::strategy::load_strategy;
use pacer_engine::{executors_for, status};
use pacer_foundation::Ctx;
use pacer_store::{StoreError, TaskFilter, TaskStore};
use serde_json::{Value, json};

/// The task the options are for; read before any usage reading, like TS `get`.
pub fn retry_task(store: &mut TaskStore, id: &str) -> Result<Value, Error> {
    Ok(store
        .read(id)?
        .ok_or_else(|| StoreError::UnknownTask(id.to_owned()))?)
}

/// Options for `task` once `parts` carries the broker `providers`. A strategy
/// that cannot be loaded yields no options.
pub fn retry_options(
    ctx: &Ctx,
    store: &mut TaskStore,
    task: &Value,
    parts: &Value,
) -> Result<Value, Error> {
    let Ok(strategy) = load_strategy(&ctx.pacer_home) else {
        return Ok(json!([]));
    };
    let tasks: Vec<Value> = store
        .list(&TaskFilter::default())?
        .iter()
        .map(slot_row)
        .collect();
    Ok(options(
        &strategy,
        task,
        &parts["providers"],
        &tasks,
        ctx.now,
    ))
}

/// The `apiTasks` fields `buildExecutors` reads.
fn slot_row(task: &Value) -> Value {
    let mut row = task_data(task, &|_| false);
    row["host"] = task["run"]["host"].clone();
    row
}

/// Candidates of the task's routing rule other than the executor that ran it,
/// with executor-row state and the row, ranking or fallback reason.
pub fn options(
    strategy: &Value,
    task: &Value,
    providers: &Value,
    tasks: &[Value],
    now: f64,
) -> Value {
    let providers = if providers.is_array() {
        providers.clone()
    } else {
        json!([])
    };
    let st = json!({"planner": status::planner_runner_id(strategy), "providers": providers});
    let rows = capacity::executors_without_ctx(&st, strategy, tasks, now);
    let kind = task.get("kind").cloned().unwrap_or(Value::Null);
    let routing = status::rank_route(&json!({
        "strategy": strategy,
        "providers": st["providers"],
        "kind": kind,
        "includePlanner": false,
    }));
    let last = array(&task["attempts"]).last().unwrap_or(&Value::Null);
    let ran = [
        &task["result"]["executor"],
        &task["executor"],
        &last["executor"],
    ]
    .into_iter()
    .find(|v| !v.is_null());
    let mut ids: Vec<String> = Vec::new();
    for id in executors_for(strategy, &kind) {
        if !ids.contains(&id) {
            ids.push(id);
        }
    }
    ids.into_iter()
        .filter(|id| ran.is_none_or(|ran| ran != id))
        .map(|id| {
            let row = rows.iter().find(|r| r["id"] == id.as_str());
            let excluded = array(&routing["excluded"])
                .iter()
                .find(|r| r["id"] == id.as_str());
            let state = row.map_or("down", |r| text(&r["state"]));
            let reason = if matches!(state, "busy" | "full") {
                json!("busy")
            } else {
                given_reason(row)
                    .or_else(|| given_reason(excluded))
                    .cloned()
                    .unwrap_or_else(|| match row {
                        Some(r) if r["state"] == "ready" => json!("available"),
                        Some(r) => r["state"].clone(),
                        None => json!("not configured"),
                    })
            };
            json!({"id": id, "state": state, "reason": reason})
        })
        .collect()
}

fn given_reason(row: Option<&Value>) -> Option<&Value> {
    row.and_then(|r| r.get("reason")).filter(|v| !v.is_null())
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;

    fn strategy() -> Value {
        json!({
            "name": "default",
            "planner": {"agent": "claude-code", "account": "claude"},
            "accounts": {
                "claude": {"name": "claude", "kind": "claude"},
                "codex": {"name": "codex", "kind": "codex"},
                "cursor": {"name": "cursor", "kind": "cursor"},
            },
            "runners": {
                "claude-code": {"id": "claude-code", "agent": "claude-code", "account": "claude", "host": null, "enabled": true},
                "codex": {"id": "codex", "agent": "codex", "account": "codex", "host": null, "enabled": true},
                "cursor": {"id": "cursor", "agent": "cursor", "account": "cursor", "host": null, "enabled": false},
            },
            "runnerAliases": {},
            "hosts": {},
            "routing": [{"kinds": null, "executors": ["codex", "codex", "cursor", "claude-code", "agy"]}],
            "pacing": {"policy": "priority", "order": ["codex", "cursor"], "accounts": "spread", "fillThreshold": 80},
        })
    }

    fn provider(id: &str, account: &str, installed: bool) -> Value {
        json!({"id": id, "account": account, "usage": "quota", "windows": [], "binding": null,
            "verdict": "ON_PACE", "installed": installed, "stale": false})
    }

    fn reasons(value: &Value) -> Vec<(String, String, String)> {
        array(value)
            .iter()
            .map(|r| {
                (
                    text(&r["id"]).into(),
                    text(&r["state"]).into(),
                    text(&r["reason"]).into(),
                )
            })
            .collect()
    }

    #[test]
    fn skips_the_executor_that_ran_and_explains_the_rest() {
        let providers = json!([
            provider("claude-code", "claude", true),
            provider("codex", "codex", true),
            provider("cursor", "cursor", false),
        ]);
        let task =
            json!({"id": "t-1", "state": "failed", "executor": "claude-code", "attempts": []});
        assert_eq!(
            reasons(&options(&strategy(), &task, &providers, &[], 100.0)),
            [
                ("codex".into(), "ready".into(), "available".into()),
                ("cursor".into(), "disabled".into(), "disabled".into()),
                ("agy".into(), "down".into(), "not configured".into()),
            ]
        );
    }

    #[test]
    fn running_work_marks_executors_busy_and_missing_binaries_down() {
        let providers = json!([
            provider("codex", "codex", false),
            provider("claude-code", "claude", true)
        ]);
        let running = json!({"id": "t-2", "state": "running", "executor": "claude-code", "updatedAt": 90.0, "host": null});
        let task = json!({"id": "t-1", "state": "failed", "result": {"executor": "cursor"}, "attempts": []});
        assert_eq!(
            reasons(&options(&strategy(), &task, &providers, &[running], 100.0)),
            [
                ("codex".into(), "down".into(), "not installed".into()),
                ("claude-code".into(), "full".into(), "busy".into()),
                ("agy".into(), "down".into(), "not configured".into()),
            ]
        );
    }
}
