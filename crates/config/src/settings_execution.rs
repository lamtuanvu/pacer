//! Additional execution validation performed by config's effective-value read.
use crate::settings::SettingsError;
use crate::yaml_value::Value;

pub(crate) fn validate(raw: &Value) -> Result<(), SettingsError> {
    const KEYS: &[&str] = &[
        "auto_clean",
        "local_max_tasks",
        "local_memory_pressure_limit",
        "local_load_limit",
        "launch_mode",
        "session",
        "session_log_mb",
        "session_retention_days",
        "backend",
        "worktree",
        "base_branch",
        "registerRepos",
        "register_repos",
        "idle_after_min",
        "idle_fail_min",
    ];
    let mut problems = Vec::new();
    if let Some(map) = raw.as_object() {
        for key in map.keys().filter(|k| !KEYS.contains(&k.as_str())) {
            problems.push(format!(
                "execution: unknown key \"{key}\" (allowed: {})",
                KEYS.join(", ")
            ));
        }
    }
    let backend = raw
        .get("backend")
        .filter(|v| !v.is_null())
        .map(Value::string)
        .unwrap_or("auto".into());
    if !["auto", "orca", "direct"].contains(&backend.as_str()) {
        problems.push(format!(
            "execution.backend must be one of auto, orca, direct (got \"{backend}\")"
        ));
    }
    let base = raw.get("base_branch").filter(|v| !v.is_null());
    let worktree = raw
        .get("worktree")
        .filter(|v| !v.is_null())
        .map(Value::string)
        .unwrap_or(
            if base.is_some() {
                "new-child"
            } else {
                "child-of-current"
            }
            .into(),
        );
    if !["child-of-current", "new-child", "current"].contains(&worktree.as_str()) {
        problems.push(format!("execution.worktree must be one of child-of-current, new-child, current (got \"{worktree}\")"));
    }
    if base.is_some_and(|v| {
        v.as_str().is_none_or(|s| {
            s.is_empty()
                || s.starts_with('-')
                || s.chars()
                    .any(|c| super::settings::js_trim(&c.to_string()).is_empty())
        })
    }) {
        problems.push("execution.base_branch must be a branch or ref name without spaces that does not start with \"-\"".into());
    }
    if raw
        .get("registerRepos")
        .filter(|v| !v.is_null())
        .or_else(|| raw.get("register_repos"))
        .is_some_and(|v| !v.is_boolean())
    {
        problems.push("execution.registerRepos must be a boolean".into());
    }
    let mut mins = |key: &str, default: f64| {
        let Some(v) = raw.get(key).filter(|v| !v.is_null()) else {
            return default;
        };
        if let Some(n) = v
            .as_f64()
            .filter(|n| n.fract() == 0. && (1. ..=1440.).contains(n))
        {
            n
        } else {
            problems.push(format!(
                "execution.{key} must be a whole number of minutes between 1 and 1440"
            ));
            default
        }
    };
    let after = mins("idle_after_min", 10.);
    let fail = mins("idle_fail_min", 30.);
    if fail <= after {
        problems
            .push("execution.idle_fail_min must be greater than execution.idle_after_min".into());
    }
    if raw
        .get("session")
        .is_some_and(|v| v != "pty" && v != "pipe")
    {
        problems.push("execution.session must be pipe or pty".into());
    }
    for (key, max) in [("session_log_mb", 256.), ("session_retention_days", 3650.)] {
        if raw.get(key).is_some_and(|v| {
            v.as_f64()
                .is_none_or(|n| n.fract() != 0. || n < 1. || n > max)
        }) {
            problems.push(format!(
                "execution.{key} must be an integer between 1 and {max}"
            ));
        }
    }
    if problems.is_empty() {
        Ok(())
    } else {
        Err(SettingsError::invalid(format!(
            "invalid execution section in the strategy:\n{}",
            problems
                .iter()
                .map(|p| format!("  - {p}"))
                .collect::<Vec<_>>()
                .join("\n")
        )))
    }
}
