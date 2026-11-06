//! Poll exit predicate shared with `taskWait` in `src/tasks/api.ts`.
use serde_json::Value;

const TERMINAL_STATES: [&str; 6] = [
    "done", "partial", "failed", "limit", "stopped", "needs_input",
];

fn terminal(task: &Value) -> bool {
    task.get("state")
        .and_then(Value::as_str)
        .is_some_and(|state| TERMINAL_STATES.contains(&state))
}

/// Returns true when `taskWait` would return the current record (ignoring deadline
/// and missing-task cases). Agent-session inputs mirror `agentChecksPending` and
/// `activeAgentSessions(...).some(s => s.task_id === id)`.
pub fn task_wait_settled(task: &Value, agent_checks_pending: bool, agent_session_active: bool) -> bool {
    terminal(task) && !agent_checks_pending && !agent_session_active
}

#[cfg(test)]
mod tests {
    #![allow(clippy::unwrap_used)]
    use super::*;
    use serde_json::json;

    #[test]
    fn needs_terminal_without_agent_holds() {
        let running = json!({"state": "running"});
        assert!(!task_wait_settled(&running, false, false));
        let done = json!({"state": "done"});
        assert!(task_wait_settled(&done, false, false));
        assert!(!task_wait_settled(&done, true, false));
        assert!(!task_wait_settled(&done, false, true));
    }
}
