//! Conservative native runner edits over a strict, byte-proven strategy subset.
mod parse;
#[cfg(test)]
mod tests;

use crate::{
    doc::{insert_missing_flow_scalar, replace_existing_scalar, replace_flow_list},
    strategy_write,
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

const OPENCODE: &str =
    "{\n  \"$schema\": \"https://opencode.ai/config.json\",\n  \"provider\": {}\n}\n";
const HINT: &str = "Check the runner id, account and host configuration.";

#[derive(PartialEq, Eq)]
struct Selected {
    before: parse::RunnerDoc,
    after: String,
    result: Value,
}

fn selected(ctx: &Ctx, name: &str, params: &Value) -> Option<Selected> {
    let doc = parse::parse(ctx)?;
    let fields = params.as_object()?;
    let (after, result) = match name {
        "runner.reorder" => {
            if fields.len() != 1 {
                return None;
            }
            let ids = fields.get("ids")?.as_array()?;
            let ids = ids
                .iter()
                .map(|id| id.as_str().map(str::to_owned))
                .collect::<Option<Vec<_>>>()?;
            if ids.len() != doc.executors.len()
                || ids.iter().any(|id| !doc.executors.contains(id))
                || ids.iter().collect::<std::collections::BTreeSet<_>>().len() != ids.len()
            {
                return None;
            }
            let values = ids.iter().map(|id| json!(id)).collect::<Vec<_>>();
            (
                replace_flow_list(&doc.yaml, &[json!("pacing"), json!("order")], &values)?,
                json!({"order":ids}),
            )
        }
        "runner.set" => {
            if fields.len() != 2 {
                return None;
            }
            let id = fields.get("id")?.as_str()?;
            if !doc.executors.iter().any(|executor| executor == id) || !doc.declared.contains(id) {
                return None;
            }
            let (field, value) = fields.iter().find(|(key, _)| key.as_str() != "id")?;
            let path = &[json!("runners"), json!(id), json!(field)];
            let mut warnings = Vec::<String>::new();
            let after = match field.as_str() {
                "enabled" => {
                    let enabled = value.as_bool()?;
                    if !enabled
                        && doc.route.contains(&id.to_owned())
                        && doc.route.iter().all(|runner| {
                            runner == id
                                || runner == &doc.planner
                                || !doc.enabled.get(runner).copied().unwrap_or(false)
                        })
                    {
                        warnings
                            .push("routing rule 'default' has no enabled executor left".to_owned());
                    }
                    replace_existing_scalar(&doc.yaml, path, value)
                        .or_else(|| insert_missing_flow_scalar(&doc.yaml, path, value))?
                }
                "model" => {
                    if !value.is_null() && value.as_str()?.is_empty() {
                        return None;
                    }
                    replace_existing_scalar(&doc.yaml, path, value)
                        .or_else(|| insert_missing_flow_scalar(&doc.yaml, path, value))?
                }
                "max_tasks" => {
                    if !(1..=16).contains(&value.as_i64()?) {
                        return None;
                    }
                    replace_existing_scalar(&doc.yaml, path, value)
                        .or_else(|| insert_missing_flow_scalar(&doc.yaml, path, value))?
                }
                "rank" => {
                    let rank = usize::try_from(value.as_u64()?).ok()?;
                    if rank >= doc.executors.len() {
                        return None;
                    }
                    let mut order = doc.order.clone();
                    order.retain(|item| item != id);
                    order.insert(rank, id.to_owned());
                    replace_flow_list(
                        &doc.yaml,
                        &[json!("pacing"), json!("order")],
                        &order.iter().map(|id| json!(id)).collect::<Vec<_>>(),
                    )?
                }
                _ => return None,
            };
            (after, json!({"id":id,"warnings":warnings}))
        }
        _ => return None,
    };
    Some(Selected {
        before: doc,
        after,
        result,
    })
}

/// Preserve full TypeScript validation, migration and editor behavior for broader shapes.
pub fn requires_core_runner_parser(ctx: &Ctx, name: &str, params: &Value) -> bool {
    selected(ctx, name, params).is_none()
}

fn changed() -> CoreError {
    CoreError::new(
        Code::Conflict,
        "Your settings changed while they were being updated. Try again.",
    )
}

async fn edit_with(
    ctx: &Ctx,
    name: &str,
    params: Value,
    before_lock: impl FnOnce(),
) -> Result<Value, CoreError> {
    let observed = selected(ctx, name, &params).ok_or_else(changed)?;
    before_lock();
    with_lock_async(ctx, "strategy", LockOptions::default(), || async {
        let current = selected(ctx, name, &params).ok_or_else(changed)?;
        if current != observed {
            return Err(changed());
        }
        if current.after != current.before.yaml {
            strategy_write::replace_strategy(
                ctx,
                &current.before.active,
                &current.before.yaml,
                current.after.as_bytes(),
            )
            .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()).hint(HINT))?;
        }
        strategy_write::refresh_opencode(ctx, OPENCODE.as_bytes())
            .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()).hint(HINT))?;
        pacer_store::record_runner_change(ctx)
            .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()).hint(HINT))?;
        Ok(current.result)
    })
    .await
    .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()))?
}

async fn edit(ctx: &Ctx, name: &str, params: Value) -> Result<Value, CoreError> {
    edit_with(ctx, name, params, || {}).await
}

fn reorder_op(ctx: &Ctx, params: Value) -> pacer_foundation::api::registry::OpFuture<'_> {
    Box::pin(edit(ctx, "runner.reorder", params))
}
fn set_op(ctx: &Ctx, params: Value) -> pacer_foundation::api::registry::OpFuture<'_> {
    Box::pin(edit(ctx, "runner.set", params))
}
pub fn ops() -> &'static [NativeOp] {
    &[
        NativeOp {
            name: "runner.reorder",
            call: reorder_op,
        },
        NativeOp {
            name: "runner.set",
            call: set_op,
        },
    ]
}
