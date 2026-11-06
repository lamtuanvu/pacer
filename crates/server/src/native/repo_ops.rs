//! Native repository registry ops; list/add probe git via the core bridge.
#![allow(clippy::result_large_err)]
use pacer_config::repos;
use pacer_foundation::{
    Ctx,
    api::{CoreError, OpFuture},
};
use serde_json::Value;

use super::lifecycle_ops::{invalid, object, type_name};

pub(crate) fn repo_remove_stays_forwarded(ctx: &Ctx) -> bool {
    repos::requires_core_repo_parser(ctx)
}

fn parse_key(params: &Value) -> Result<&str, CoreError> {
    let map = object(params)?;
    for key in map.keys() {
        if key != "key" {
            return Err(invalid("params: Unrecognized key(s) in object"));
        }
    }
    let value = map.get("key").ok_or_else(|| invalid("key: Required"))?;
    let text = value.as_str().ok_or_else(|| {
        invalid(format!(
            "key: Invalid input: expected string, received {}",
            type_name(value)
        ))
    })?;
    if text.is_empty() {
        return Err(invalid(
            "key: Too small: expected string to have >=1 characters",
        ));
    }
    Ok(text)
}

pub(super) fn repo_remove(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let key = parse_key(&params)?;
        repos::remove_repo(ctx, key)
    })
}
