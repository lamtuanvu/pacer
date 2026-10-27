//! Conservative native routing edit for one existing default rule.

mod write;

use crate::{
    doc::replace_flow_list,
    routing::routing_get,
    strategy_list::{strategy_show, use_selection},
    strategy_load::normalize_basic,
};
use pacer_foundation::{
    Ctx,
    api::{
        error::{Code, CoreError},
        registry::NativeOp,
    },
    lock::{LockOptions, with_lock_async},
};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

const OPENCODE: &str =
    "{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"provider\": {}\n}\n";
const HINT: &str = "Check the strategy values and retry.";

#[derive(PartialEq, Eq)]
struct Selected {
    active: String,
    before: String,
    after: String,
    path: PathBuf,
}

fn selected(ctx: &Ctx, params: &Value) -> Option<Selected> {
    let fields = params.as_object()?;
    if fields.keys().any(|key| key != "rules") {
        return None;
    }
    let rules = fields.get("rules")?.as_array()?;
    if rules.len() != 1 {
        return None;
    }
    let rule = rules[0].as_object()?;
    if rule.len() != 1 {
        return None;
    }
    let executors = rule.get("executors")?.as_array()?;
    if executors.is_empty() || executors.len() > 16 {
        return None;
    }
    let available = routing_get(ctx).ok()?;
    let current = available["rules"].as_array()?;
    if current.len() != 1 || current[0].get("kinds").is_some() {
        return None;
    }
    let known = available["available"].as_array()?;
    if !executors.iter().all(|item| {
        item.as_str()
            .is_some_and(|name| known.iter().any(|known| known == name))
    }) {
        return None;
    }
    let (_, active) = use_selection(ctx, &json!({"name":"default"}))?;
    let shown = strategy_show(ctx, &json!({"name":active})).ok()?;
    let before = shown["yaml"].as_str()?.to_owned();
    let after = replace_flow_list(
        &before,
        &[json!("routing"), json!(0), json!("default")],
        executors,
    )?;
    normalize_basic(&after, &active)?;
    let path = if active == "default" {
        ctx.pacer_home.join("strategy.yaml")
    } else {
        ctx.pacer_home
            .join("strategies")
            .join(format!("{active}.yaml"))
    };
    let metadata = fs::symlink_metadata(&path).ok()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if !metadata.is_file() || metadata.permissions().mode() & 0o777 != 0o600 {
            return None;
        }
    }
    #[cfg(not(unix))]
    if !metadata.is_file() {
        return None;
    }
    Some(Selected {
        active,
        before,
        after,
        path,
    })
}

/// Keep all broader documents, validation errors and list-shape edits with Bun.
pub fn requires_core_routing_set_parser(ctx: &Ctx, params: &Value) -> bool {
    selected(ctx, params).is_none()
}

fn diff(path: &std::path::Path, before: &str, after: &str) -> String {
    if before == after {
        return String::new();
    }
    let a: Vec<&str> = before.split('\n').collect();
    let b: Vec<&str> = after.split('\n').collect();
    let mut start = 0;
    while start < a.len() && start < b.len() && a[start] == b[start] {
        start += 1;
    }
    let (mut end_a, mut end_b) = (a.len(), b.len());
    while end_a > start && end_b > start && a[end_a - 1] == b[end_b - 1] {
        end_a -= 1;
        end_b -= 1;
    }
    let path = path.to_string_lossy();
    std::iter::once(format!("--- {path}"))
        .chain(std::iter::once(format!("+++ {path}")))
        .chain(std::iter::once(format!(
            "@@ -{},{} +{},{} @@",
            start + 1,
            end_a - start,
            start + 1,
            end_b - start
        )))
        .chain(a[start..end_a].iter().map(|line| format!("-{line}")))
        .chain(b[start..end_b].iter().map(|line| format!("+{line}")))
        .collect::<Vec<_>>()
        .join("\n")
}

fn changed() -> CoreError {
    CoreError::new(
        Code::Conflict,
        "Your settings changed while they were being updated. Try again.",
    )
}

async fn set_op_with(
    ctx: &Ctx,
    params: Value,
    before_lock: impl FnOnce(),
) -> Result<Value, CoreError> {
    let observed = selected(ctx, &params).ok_or_else(changed)?;
    before_lock();
    with_lock_async(ctx, "strategy", LockOptions::default(), || async {
        let current = selected(ctx, &params).ok_or_else(changed)?;
        if current != observed {
            return Err(changed());
        }
        if current.after != current.before {
            write::replace_strategy(
                ctx,
                &current.active,
                &current.before,
                current.after.as_bytes(),
            )
            .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()).hint(HINT))?;
        }
        write::refresh_opencode(ctx, OPENCODE.as_bytes())
            .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()).hint(HINT))?;
        pacer_store::record_routing_change(ctx)
            .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()).hint(HINT))?;
        Ok(json!({"diff":diff(&current.path, &current.before, &current.after)}))
    })
    .await
    .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()))?
}

fn op(ctx: &Ctx, params: Value) -> pacer_foundation::api::registry::OpFuture<'_> {
    Box::pin(set_op_with(ctx, params, || {}))
}
pub fn ops() -> &'static [NativeOp] {
    &[NativeOp {
        name: "routing.set",
        call: op,
    }]
}

#[cfg(test)]
mod tests;
