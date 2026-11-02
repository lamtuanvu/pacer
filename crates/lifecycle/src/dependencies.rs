use serde_json::Value;
use std::collections::HashSet;

/// Return unresolved work dependencies in their stored order. A missing task is
/// unresolved; only an explicit accepted review or waiver clears a dependency.
pub fn pending_dependencies<'a>(
    dependencies: &'a [String],
    tasks: &[(String, Value)],
    waivers: &[String],
) -> Vec<&'a str> {
    let waived: HashSet<&str> = waivers.iter().map(String::as_str).collect();
    dependencies
        .iter()
        .filter(|id| {
            !waived.contains(id.as_str())
                && !tasks.iter().any(|(task_id, task)| {
                    task_id == *id && task.pointer("/review/accepted") == Some(&Value::Bool(true))
                })
        })
        .map(String::as_str)
        .collect()
}
