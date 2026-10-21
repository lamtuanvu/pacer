use serde_json::{Value, json};

fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(value) => *value,
        Value::Number(value) => value.as_f64().is_some_and(|value| value != 0.0),
        Value::String(value) => !value.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

// Port actionableItems/needsYou from src/view-model/selectors.ts. The status
// line consumes only running and attention, not the other derived counters.
pub fn counts(snapshot: &Value) -> Value {
    let mut counts = snapshot["counts"].clone();
    if !counts.is_object() || snapshot.get("attention").is_none() {
        return counts;
    }
    let now = snapshot["at"].as_f64().unwrap_or(f64::NAN);
    let tasks = snapshot["tasks"].as_array();
    let attention = snapshot["attention"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| {
            if item["snoozedUntil"]
                .as_f64()
                .is_some_and(|until| until != 0.0 && until > now)
            {
                return false;
            }
            if item["kind"] != "review" {
                return true;
            }
            let task = tasks
                .into_iter()
                .flatten()
                .find(|task| task["id"] == item["taskId"]);
            let Some(task) = task else {
                // The referenced result can be outside the current snapshot.
                return true;
            };
            if ["review", "resolved", "dismissed", "retriedBy"]
                .iter()
                .any(|key| truthy(&task[*key]))
            {
                return false;
            }
            task["state"] == "partial"
                || task["acceptanceState"] == "failed"
                || task["state"] != "done"
                || truthy(&task["reviewRequest"])
        })
        .count();
    counts["attention"] = json!(attention);
    counts
}

pub fn planner_meter(snapshot: &Value) -> &Value {
    &snapshot["planner"]
}

#[cfg(test)]
mod tests;
