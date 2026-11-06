use crate::{
    AdmissionError, AdmissionLifetime, PreparedAdmission, parse_delegate_brief, resolve_runner,
    validate_current,
};
use serde_json::{Map, Value, json};
use std::path::PathBuf;

/// Policy amendment row from `policy.before` (`kind`, `requestedExecutor`, `placement`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PolicyAmendment {
    pub kind: Option<Value>,
    pub requested_executor: Option<Value>,
    pub placement: Option<Value>,
}

impl PolicyAmendment {
    pub fn from_value(amend: &Value) -> Self {
        Self {
            kind: amend.get("kind").cloned(),
            requested_executor: amend.get("requestedExecutor").cloned(),
            placement: amend.get("placement").cloned(),
        }
    }
}

fn policy_kind(input: &Value) -> Option<&Value> {
    input
        .pointer("/dispatch/kind")
        .or_else(|| input.get("kind"))
}

/// Mirrors `map()` inside `prepareDelegate` (`src/tasks/api.ts`).
pub fn map_policy_amendment(input: &Value, amend: &PolicyAmendment) -> Value {
    let baseline = policy_kind(input);
    let next_kind = amend.kind.as_ref().or(baseline);
    let changed = next_kind != baseline;
    let mut mapped = input.clone();
    if changed {
        if let Some(kind) = next_kind {
            mapped["kind"] = kind.clone();
        } else if mapped
            .as_object_mut()
            .is_some_and(|m| m.remove("kind").is_some())
        {
        } else {
            mapped["kind"] = Value::Null;
        }
    }
    if let Some(executor) = &amend.requested_executor {
        mapped["executor"] = executor.clone();
    }
    if let Some(placement) = &amend.placement {
        mapped["worktree"] = placement.clone();
    }
    if changed
        && let Some(dispatch) = mapped.get_mut("dispatch").and_then(Value::as_object_mut)
    {
        if let Some(kind) = next_kind.filter(|k| !k.is_null()) {
            dispatch.insert("kind".into(), kind.clone());
        } else {
            dispatch.remove("kind");
        }
    }
    mapped
}

/// ECMAScript snapshot equality for admission context (strategy order matters).
pub fn admission_context_same(a: &Value, b: &Value) -> Result<bool, AdmissionError> {
    Ok(
        crate::semantics::stringify(&crate::semantics::js_numbers(a))?
            == crate::semantics::stringify(&crate::semantics::js_numbers(b))?,
    )
}

/// Host-owned snapshot fields consumed by `PreparedAdmission::prepare_delegate`.
pub struct DelegateAdmissionSnapshot {
    pub strategy: Value,
    pub projects: Value,
    pub repo: Value,
    pub exclusions: Value,
    pub registered: Option<Value>,
    pub parent: Option<Value>,
    pub work: Option<Value>,
    pub root: Option<Value>,
    pub active: Option<Value>,
    pub candidates: Option<Value>,
    pub context: Option<Value>,
}

impl DelegateAdmissionSnapshot {
    pub fn admission_value(&self) -> Value {
        let mut fields = Map::new();
        fields.insert("strategy".into(), self.strategy.clone());
        fields.insert("projects".into(), self.projects.clone());
        fields.insert("repo".into(), self.repo.clone());
        fields.insert("exclusions".into(), self.exclusions.clone());
        if let Some(value) = &self.registered {
            fields.insert("registered".into(), value.clone());
        }
        if let Some(value) = &self.parent {
            fields.insert("parent".into(), value.clone());
        }
        if let Some(value) = &self.work {
            fields.insert("work".into(), value.clone());
        }
        if let Some(value) = &self.root {
            fields.insert("root".into(), value.clone());
        }
        if let Some(value) = &self.active {
            fields.insert("active".into(), value.clone());
        }
        if let Some(value) = &self.candidates {
            fields.insert("candidates".into(), value.clone());
        }
        if let Some(value) = &self.context {
            fields.insert("context".into(), value.clone());
        }
        Value::Object(fields)
    }

    pub fn validate_input(&self, input: &Value) -> Result<(), AdmissionError> {
        let repo = (!self.repo.is_null()).then_some(&self.repo);
        validate_current(
            &self.strategy,
            input,
            &self.projects,
            repo,
            &self.exclusions,
        )
    }
}

fn merge_delegate_input(parsed: &Value) -> Value {
    let mut merged = parsed["input"].clone();
    if let Some(map) = merged.as_object_mut() {
        if let Some(brief) = parsed.get("brief") {
            map.insert("brief".into(), brief.clone());
        }
        map.insert("repoValidated".into(), json!(true));
    }
    merged
}

fn normalize_executor(input: &mut Value, strategy: &Value) {
    if let Some(id) = input["executor"].as_str()
        && let Some(runner) = resolve_runner(strategy, id)
    {
        input["executor"] = runner["id"].clone();
    }
}

/// Parse a brief (or accept a full delegate input), run synchronous validation and
/// return a delegate `PreparedAdmission` receipt. Plugin policy remains injected.
pub fn prepare_delegate_admission(
    raw: &Value,
    default_repo: &str,
    extra_paths: &[PathBuf],
    lifetime: Option<AdmissionLifetime>,
    mut snapshot: impl FnMut() -> Result<DelegateAdmissionSnapshot, AdmissionError>,
    policy: impl FnOnce(&Value) -> Result<Value, AdmissionError>,
) -> Result<PreparedAdmission, AdmissionError> {
    let mut input = if raw.get("brief").is_some() {
        raw.clone()
    } else {
        merge_delegate_input(&parse_delegate_brief(raw, default_repo)?)
    };
    let initial = snapshot()?;
    initial.validate_input(&input)?;
    normalize_executor(&mut input, &initial.strategy);
    let paths = {
        let mut paths = extra_paths.to_vec();
        if let Some(repo) = input.pointer("/brief/repo").and_then(Value::as_str) {
            paths.push(PathBuf::from(repo));
        }
        if let Some(reuse) = input["reuseWorktree"].as_str() {
            paths.push(PathBuf::from(reuse));
        }
        paths
    };
    PreparedAdmission::prepare_delegate(
        input,
        &paths,
        lifetime,
        || Ok(snapshot()?.admission_value()),
        policy,
    )
}
