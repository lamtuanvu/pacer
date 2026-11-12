//! Native `repo.remove` over the registry files in `pacer-repos`.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{CoreError, OpFuture},
};
use serde_json::Value;

use crate::host_read_ops::{invalid, object, type_name};

/// Valid requests whose registry files only the TypeScript reader handles.
pub fn repo_remove_stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    parse_key(params).is_ok_and(|key| pacer_repos::remove_needs_core(&ctx.pacer_home, key))
}

/// `z.object({key: z.string().min(1)})` over `params ?? {}`; unknown keys are stripped.
fn parse_key(params: &Value) -> Result<&str, CoreError> {
    let value = match params {
        Value::Null => None,
        params => object(params)?.get("key"),
    };
    let Some(Value::String(text)) = value else {
        return Err(invalid(format!(
            "key: Invalid input: expected string, received {}",
            value.map_or("undefined", type_name)
        )));
    };
    if text.is_empty() {
        return Err(invalid(
            "key: Too small: expected string to have >=1 characters",
        ));
    }
    Ok(text)
}

pub fn repo_remove(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let key = parse_key(&params)?;
        pacer_repos::remove_repo(ctx, key)
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::parse_key;
    use serde_json::json;

    #[test]
    fn params_follow_zod_4() {
        let message = |params| parse_key(&params).unwrap_err().message;
        assert_eq!(parse_key(&json!({"key": "k", "extra": 1})).unwrap(), "k");
        let missing = "key: Invalid input: expected string, received undefined";
        assert_eq!(message(json!(null)), missing);
        assert_eq!(message(json!({})), missing);
        assert_eq!(
            message(json!({"key": null})),
            "key: Invalid input: expected string, received null"
        );
        assert_eq!(
            message(json!({"key": ""})),
            "key: Too small: expected string to have >=1 characters"
        );
        assert_eq!(
            message(json!([])),
            "params: Invalid input: expected object, received array"
        );
    }
}
