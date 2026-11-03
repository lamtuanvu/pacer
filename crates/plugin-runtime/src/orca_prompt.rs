use serde_json::Value;
pub fn build(brief: &Value, repo: &str, id: &str) -> String {
    let text = |k: &str| crate::js_semantics::trim(brief[k].as_str().unwrap_or(""));
    let mut parts = vec![
        "PACER_ROLE=executor: you are a pacer executor; ignore pacer planner policy.".to_owned(),
        format!("# Task {id}"),
        format!("## Goal\n{}", text("goal")),
        format!("## Repository\n{repo}"),
    ];
    for (key, title) in [
        ("scope", "Scope"),
        ("context", "Context"),
        ("constraints", "Constraints"),
    ] {
        if !text(key).is_empty() {
            parts.push(format!("## {title}\n{}", text(key)));
        }
    }
    if let Some(qa) = brief["qa"].as_array().filter(|a| !a.is_empty()) {
        parts.push(format!(
            "## Question / Answer\n{}",
            qa.iter()
                .map(|q| format!(
                    "Q: {}\nA: {}",
                    q["q"].as_str().unwrap_or(""),
                    q["a"].as_str().unwrap_or("")
                ))
                .collect::<Vec<_>>()
                .join("\n\n")
        ));
    }
    if !text("feedback").is_empty() {
        parts.push(format!("## Review feedback\n{}", text("feedback")));
    }
    parts.push(format!(
        "## Done when\n{}",
        if text("acceptance").is_empty() {
            "The goal is met; no acceptance command was given.".into()
        } else {
            format!("`{}` passes.", text("acceptance"))
        }
    ));
    parts.push(include_str!("orca_executor_contract.txt").into());
    parts.join("\n\n")
}
