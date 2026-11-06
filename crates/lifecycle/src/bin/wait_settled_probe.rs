//! Cross-runtime driver for `task_wait_settled`.
use pacer_lifecycle::task_wait_settled;
use serde_json::json;
use std::env;

fn main() {
    let mut args = env::args().skip(1);
    let state = args.next().unwrap_or_else(|| "running".into());
    let agent_checks = args.next().is_some_and(|v| v == "1");
    let agent_session = args.next().is_some_and(|v| v == "1");
    let settled = task_wait_settled(&json!({"state": state}), agent_checks, agent_session);
    println!("{settled}");
}
