//! Native `dispatch.*` reads over the shared work graph and active strategy.
//! Work-grant callers reach these handlers through `pacer_work::authorize_work_operation`.
#![allow(clippy::result_large_err)]
use pacer_config::strategy::{default_dispatch_config, load_strategy};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::{
    AdmissionState,
    work_reads::{WorkListFilter, WorkReadError, WorkReads},
};
use serde_json::{Map, Value, json};

pub(crate) fn invalid(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

pub(crate) fn type_name(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;
const RELATIONS: &[&str] = &["roots", "children", "all"];
const STATES: &[&str] = &[
    "queued",
    "running",
    "done",
    "partial",
    "failed",
    "limit",
    "stopped",
    "needs_input",
];

/// `authorizeWorkOperation` for the named operation and params.
pub(crate) fn authorize(ctx: &Ctx, name: &str, params: &Value) -> Result<(), CoreError> {
    let is_executor = ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor");
    pacer_work::authorize_work_operation(ctx, name, params, is_executor)
}

/// Transports pass absent params as `{}`.
pub(crate) fn params_object(params: &Value) -> Result<Map<String, Value>, CoreError> {
    match params {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map.clone()),
        other => Err(invalid(format!(
            "params: Invalid input: expected object, received {}",
            type_name(other)
        ))),
    }
}

pub(crate) fn finish(issues: Vec<String>) -> Result<(), CoreError> {
    if issues.is_empty() {
        Ok(())
    } else {
        Err(invalid(issues.join("; ")))
    }
}

/// `z.string().min(1).max(max)`; zod counts Unicode code points.
pub(crate) fn string_issues(
    name: &str,
    value: Option<&Value>,
    max: Option<usize>,
    issues: &mut Vec<String>,
) {
    match value {
        None => issues.push(format!(
            "{name}: Invalid input: expected string, received undefined"
        )),
        Some(Value::String(text)) => {
            let units = text.chars().count();
            if units < 1 {
                issues.push(format!(
                    "{name}: Too small: expected string to have >=1 characters"
                ));
            } else if let Some(max) = max.filter(|max| units > *max) {
                issues.push(format!(
                    "{name}: Too big: expected string to have <={max} characters"
                ));
            }
        }
        Some(other) => issues.push(format!(
            "{name}: Invalid input: expected string, received {}",
            type_name(other)
        )),
    }
}

/// `z.number().int()` type and safe-range issues; `None` when no range check applies.
fn int_value(name: &str, value: &Value, issues: &mut Vec<String>) -> Option<f64> {
    let Some(n) = value.as_f64().filter(|_| value.is_number()) else {
        issues.push(format!(
            "{name}: Invalid input: expected number, received {}",
            type_name(value)
        ));
        return None;
    };
    if !n.is_finite() || n.fract() != 0.0 {
        issues.push(format!(
            "{name}: Invalid input: expected int, received number"
        ));
        return None;
    }
    if n < -MAX_SAFE {
        issues.push(format!(
            "{name}: Too small: expected int to be >=-9007199254740991"
        ));
    } else if n > MAX_SAFE {
        issues.push(format!(
            "{name}: Too big: expected int to be <=9007199254740991"
        ));
    }
    Some(n)
}

/// `z.number().int()` with an inclusive range.
pub(crate) fn int_issues(
    name: &str,
    value: &Value,
    min: f64,
    max: Option<f64>,
    issues: &mut Vec<String>,
) {
    let Some(n) = int_value(name, value, issues) else {
        return;
    };
    if n < min {
        issues.push(format!("{name}: Too small: expected number to be >={min}"));
    } else if let Some(max) = max.filter(|max| n > *max) {
        issues.push(format!("{name}: Too big: expected number to be <={max}"));
    }
}

/// `z.number().int().positive()`.
pub(crate) fn positive_int_issues(name: &str, value: Option<&Value>, issues: &mut Vec<String>) {
    let Some(value) = value else {
        issues.push(format!(
            "{name}: Invalid input: expected number, received undefined"
        ));
        return;
    };
    if int_value(name, value, issues).is_some_and(|n| n <= 0.0) {
        issues.push(format!("{name}: Too small: expected number to be >0"));
    }
}

fn enum_issues(name: &str, value: &Value, options: &[&str], issues: &mut Vec<String>) {
    if !value.as_str().is_some_and(|v| options.contains(&v)) {
        let expected = options
            .iter()
            .map(|o| format!("\"{o}\""))
            .collect::<Vec<_>>()
            .join("|");
        issues.push(format!(
            "{name}: Invalid option: expected one of {expected}"
        ));
    }
}

#[cfg(unix)]
fn pid_alive(pid: &Value) -> bool {
    use nix::{errno::Errno, sys::signal::kill, unistd::Pid};
    let Some(n) = pid.as_f64() else {
        return false;
    };
    if n.fract() != 0.0 || n < f64::from(i32::MIN) || n > f64::from(i32::MAX) {
        return false;
    }
    matches!(
        kill(Pid::from_raw(n as i32), None),
        Ok(()) | Err(Errno::EPERM)
    )
}

#[cfg(not(unix))]
fn pid_alive(_pid: &Value) -> bool {
    false
}

fn read_error(error: WorkReadError) -> CoreError {
    match error {
        WorkReadError::UnknownWork => CoreError::new(Code::UnknownTask, "Unknown work"),
        other => CoreError::new(Code::Internal, other.to_string()),
    }
}

/// Run a read with the TypeScript clock resolution (`Date.now() / 1000`).
pub(crate) fn with_reads<T>(
    ctx: &Ctx,
    read: impl FnOnce(&WorkReads<'_>) -> Result<T, WorkReadError>,
) -> Result<T, CoreError> {
    let mut state = AdmissionState::open(&ctx.pacer_home)
        .map_err(|error| CoreError::new(Code::Internal, error.0))?;
    let db = state
        .tasks
        .connection()
        .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
    let reads = WorkReads {
        db,
        now: (ctx.now * 1000.0).floor() / 1000.0,
        pid_alive: &pid_alive,
    };
    read(&reads).map_err(read_error)
}

pub fn dispatch_config_get(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx, "dispatch.config.get", &params)?;
        params_object(&params)?;
        let strategy = load_strategy(&ctx.pacer_home)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        let mut out = Map::new();
        for (key, value) in [
            ("strategy", strategy.get("name")),
            ("planner", strategy.pointer("/planner/agent")),
            ("plannerAccount", strategy.pointer("/planner/account")),
        ] {
            if let Some(value) = value {
                out.insert(key.into(), value.clone());
            }
        }
        let config = strategy.get("dispatch").filter(|c| !c.is_null());
        out.insert(
            "source".into(),
            json!(if config.is_some() {
                "strategy"
            } else {
                "built-in"
            }),
        );
        out.insert(
            "config".into(),
            config.cloned().unwrap_or_else(default_dispatch_config),
        );
        Ok(Value::Object(out))
    })
}

pub fn dispatch_tree(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx, "dispatch.tree", &params)?;
        let p = params_object(&params)?;
        let mut issues = Vec::new();
        string_issues("id", p.get("id"), Some(128), &mut issues);
        finish(issues)?;
        let id = p["id"].as_str().unwrap_or_default().to_owned();
        let granted = ctx.env.contains_key("PACER_WORK_GRANT");
        with_reads(ctx, move |reads| {
            let mut tree = reads.scoped_tree(&id)?;
            // `scopedWorkTree` under a work grant re-roots at the requested id
            // (`src/core/work.ts`): rootId becomes id, that node's parentId is null,
            // and dependencies are filtered to the visible subtree.
            if granted {
                grant_reroot_tree(&mut tree, &id);
            }
            Ok(tree)
        })
    })
}

/// Apply the work-grant remapping from TypeScript `scopedWorkTree`.
fn grant_reroot_tree(tree: &mut Value, id: &str) {
    let Some(obj) = tree.as_object_mut() else {
        return;
    };
    obj.insert("rootId".into(), Value::String(id.to_owned()));
    let Some(nodes) = obj.get_mut("nodes").and_then(Value::as_array_mut) else {
        return;
    };
    let visible: std::collections::HashSet<String> = nodes
        .iter()
        .filter_map(|n| n.get("taskId").and_then(Value::as_str).map(str::to_owned))
        .collect();
    for node in nodes {
        let Some(node) = node.as_object_mut() else {
            continue;
        };
        node.insert("rootId".into(), Value::String(id.to_owned()));
        let is_root = node.get("taskId").and_then(Value::as_str) == Some(id);
        if is_root {
            node.insert("parentId".into(), Value::Null);
        }
        if let Some(deps) = node.get_mut("dependencies").and_then(Value::as_array_mut) {
            deps.retain(|dep| dep.as_str().is_some_and(|dep_id| visible.contains(dep_id)));
        }
    }
}

pub fn dispatch_events(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx, "dispatch.events", &params)?;
        let p = params_object(&params)?;
        let mut issues = Vec::new();
        string_issues("id", p.get("id"), Some(128), &mut issues);
        if let Some(after) = p.get("after") {
            int_issues("after", after, 0.0, None, &mut issues);
        }
        finish(issues)?;
        let id = p["id"].as_str().unwrap_or_default();
        let after = p.get("after").and_then(Value::as_f64).unwrap_or(0.0) as i64;
        with_reads(ctx, |reads| reads.scoped_events(id, after))
    })
}

pub fn dispatch_list(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx, "dispatch.list", &params)?;
        let p = params_object(&params)?;
        let mut issues = Vec::new();
        if let Some(relation) = p.get("relation") {
            enum_issues("relation", relation, RELATIONS, &mut issues);
        }
        if let Some(state) = p.get("state") {
            enum_issues("state", state, STATES, &mut issues);
        }
        if p.contains_key("repo") {
            string_issues("repo", p.get("repo"), None, &mut issues);
        }
        if p.contains_key("before") {
            string_issues("before", p.get("before"), Some(128), &mut issues);
        }
        if let Some(limit) = p.get("limit") {
            int_issues("limit", limit, 1.0, Some(100.0), &mut issues);
        }
        finish(issues)?;
        let text = |key: &str| p.get(key).and_then(Value::as_str).unwrap_or("");
        let filter = WorkListFilter {
            relation: p.get("relation").and_then(Value::as_str).unwrap_or("roots"),
            state: text("state"),
            repo: text("repo"),
            before: text("before"),
            limit: p.get("limit").and_then(Value::as_f64).unwrap_or(50.0) as i64,
        };
        with_reads(ctx, |reads| reads.list(&filter))
    })
}

#[cfg(test)]
#[path = "dispatch_ops/tests.rs"]
mod tests;
