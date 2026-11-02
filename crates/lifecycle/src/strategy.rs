use crate::{AdmissionError, ExecutorResolution, ValidationContext, validate_input};
use serde_json::{Value, json};

/// Resolve configured runner IDs, aliases, endpoint shorthand and default-account
/// spellings exactly as src/config/runner-id.ts does, from a validated strategy.
pub fn resolve_runner<'a>(s: &'a Value, id: &str) -> Option<&'a Value> {
    let runners = s["runners"].as_object()?;
    if let Some(runner) = runners.get(id) {
        return Some(runner);
    }
    if let Some(alias) = s["runnerAliases"][id].as_str().filter(|s| !s.is_empty())
        && let Some(runner) = runners.get(alias)
    {
        return Some(runner);
    }
    let (agent, account, host) = if s["accounts"][id]["kind"] == "endpoint"
        && !["claude-code", "codex", "cursor", "agy", "opencode"].contains(&id)
    {
        ("opencode", Some(id), None)
    } else {
        let mut hosted = id.split('@');
        let left = hosted.next()?;
        let host = hosted.next();
        if hosted.next().is_some() {
            return None;
        }
        let mut accounts = left.split('#');
        let agent = accounts.next()?;
        let account = accounts.next();
        if accounts.next().is_some() {
            return None;
        }
        if !["claude-code", "codex", "cursor", "agy", "opencode"].contains(&agent)
            || !segment(agent)
            || account.is_some_and(|a| !segment(a))
            || host.is_some_and(|h| !segment(h))
        {
            return None;
        }
        (agent, account, host.filter(|h| *h != "local"))
    };
    let kind = match agent {
        "claude-code" => "claude",
        "codex" => "codex",
        "cursor" => "cursor",
        "agy" => "agy",
        _ => "endpoint",
    };
    let defaults: Vec<_> = s["accounts"]
        .as_object()
        .into_iter()
        .flat_map(|a| a.values())
        .filter(|a| a["kind"] == kind && !truthy(&a["home"]) && !truthy(&a["orcaAccount"]))
        .collect();
    let default = if agent != "opencode" && defaults.len() == 1 {
        defaults[0]["name"].as_str()
    } else {
        None
    };
    let mut canonical = agent.to_owned();
    if let Some(account) = account.filter(|a| Some(*a) != default) {
        canonical.push('#');
        canonical.push_str(account);
    }
    if let Some(host) = host {
        canonical.push('@');
        canonical.push_str(host);
    }
    runners.get(&canonical)
}
fn segment(s: &str) -> bool {
    s.as_bytes()
        .first()
        .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
        && s.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
}
pub(crate) fn truthy(v: &Value) -> bool {
    match v {
        Value::Null | Value::Bool(false) => false,
        Value::Number(n) => n.as_f64().is_some_and(|n| n != 0.0),
        Value::String(s) => !s.is_empty(),
        _ => true,
    }
}

pub fn validate_strategy_input(s: &Value, input: &Value, repo_validated: bool) -> Vec<String> {
    let providers: Vec<_> = s["providers"]
        .as_object()
        .into_iter()
        .flat_map(|p| p.keys().map(String::as_str))
        .collect();
    let runner = input["executor"]
        .as_str()
        .and_then(|id| resolve_runner(s, id));
    let executor = match runner {
        None => ExecutorResolution::Unknown,
        Some(r)
            if r["agent"] == s["planner"]["agent"] && r["account"] == s["planner"]["account"] =>
        {
            ExecutorResolution::Planner
        }
        _ => ExecutorResolution::Other,
    };
    validate_input(
        input,
        repo_validated,
        &ValidationContext {
            configured_providers: &providers,
            executor,
        },
    )
}
fn tier(value: &Value) -> i8 {
    match value.as_str() {
        Some("small") => 0,
        Some("medium") => 1,
        Some("frontier") => 2,
        _ => -1,
    }
}
fn compatible(s: &Value, r: &Value, dispatch: &Value) -> bool {
    let fallback = if let Some(model) = r.get("model").filter(|v| truthy(v)) {
        vec![json!({"id":model,"tier":"unknown"})]
    } else {
        vec![]
    };
    let declared = r["models"].as_array().unwrap_or(&fallback);
    let default = json!({"tier":"unknown"});
    let models: Vec<_> = if declared.is_empty() {
        vec![&default]
    } else {
        declared.iter().collect()
    };
    models.into_iter().any(|model| {
        let account = &s["accounts"][r["account"].as_str().unwrap_or("")];
        let technical = account["connection"]["models"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|m| {
                model["id"].as_str().is_some_and(|id| {
                    id == format!(
                        "pacer-{}/{}",
                        account["name"].as_str().unwrap_or(""),
                        m["id"].as_str().unwrap_or("")
                    )
                })
            });
        let capability = |key: &str| {
            model
                .get(key)
                .or_else(|| technical.and_then(|t| t.get(key)))
        };
        let req = &dispatch["requirements"];
        (req.get("minTier").is_none() || tier(&model["tier"]) >= tier(&req["minTier"]))
            && (req.get("tools").is_none() || capability("tools") == req.get("tools"))
            && (req.get("context").is_none()
                || capability("context").and_then(Value::as_f64).unwrap_or(0.0)
                    >= req["context"].as_f64().unwrap_or(0.0))
            && (!truthy(&dispatch["model"]) || model.get("id") == dispatch.get("model"))
    })
}
/// Full prepared-delegate validation, using current host guardrail observations.
/// Exclusions are supplied by the host's evidence evaluator (no provider I/O).
pub fn validate_current(
    s: &Value,
    input: &Value,
    projects: &Value,
    repo: Option<&Value>,
    exclusions: &Value,
) -> Result<(), AdmissionError> {
    let validated_projects = crate::validate_project_strategies(projects)?;
    let projects = &validated_projects;
    let mut problems = validate_strategy_input(s, input, true);
    if let Some(id) = input["executor"].as_str().filter(|id| !id.is_empty()) {
        if let Some(r) = resolve_runner(s, id) {
            if r["enabled"] == false {
                problems.push(format!("{id}: disabled"));
            }
            if let Some(dispatch) = input.get("dispatch")
                && !compatible(s, r, dispatch)
            {
                problems.push(format!("{id}: incompatible managed model policy"));
            }
        }
        if let Some(reason) = exclusions[id].as_str().filter(|s| !s.is_empty()) {
            problems.push(format!("{id}: {reason}"));
        }
    }
    if !problems.is_empty() {
        return Err(AdmissionError(problems.join("; ")));
    }
    let strict = projects["projects"]
        .as_object()
        .into_iter()
        .flat_map(|p| p.values())
        .any(|p| truthy(&p["executors"]));
    if repo.is_none() && strict {
        return Err(AdmissionError(
            "Resolve the repository before delegating with project policies".into(),
        ));
    }
    if let Some(repo) = repo {
        if strict
            && (repo["identityUnverified"] == true
                || repo["key"].as_str().is_none_or(str::is_empty))
        {
            return Err(AdmissionError(
                "Cannot establish repository identity for project routing".into(),
            ));
        }
        if let Some(selection) = project_selection(s, repo["key"].as_str().unwrap_or(""), projects)
            && let Some(executor) = input["executor"].as_str().filter(|s| !s.is_empty())
        {
            let canonical = resolve_runner(s, executor)
                .and_then(|r| r["id"].as_str())
                .unwrap_or(executor);
            if !selection["executors"]
                .as_array()
                .is_some_and(|ids| ids.iter().any(|id| id == canonical))
            {
                return Err(AdmissionError(format!(
                    "{canonical} is forbidden by project policy for {}",
                    repo["key"].as_str().unwrap_or("")
                )));
            }
        }
    }
    Ok(())
}
pub fn project_selection(s: &Value, key: &str, projects: &Value) -> Option<Value> {
    let entry = &projects["projects"][key];
    let references = entry["executors"].as_array()?;
    let runners = s["runners"].as_object()?;
    let ids: Vec<_> = references
        .iter()
        .map(|reference| {
            runners
                .values()
                .find(|r| {
                    reference.as_str()
                        == Some(
                            format!(
                                "{}#{}@{}",
                                r["agent"].as_str().unwrap_or(""),
                                r["account"].as_str().unwrap_or(""),
                                r["host"].as_str().unwrap_or("local")
                            )
                            .as_str(),
                        )
                })
                .map(|r| r["id"].clone())
                .unwrap_or_else(|| reference.clone())
        })
        .collect();
    Some(json!({"repoKey":key,"rev":entry["rev"],"references":references,"executors":ids}))
}
