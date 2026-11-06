//! `machine.get`, `machine.set` and `machine.rotate` over the shared identity store.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value};

use super::lifecycle_ops::{invalid, object, type_name};
use super::machine_identity::{self as identity, Env};

const MAX_SAFE: f64 = 9_007_199_254_740_991.0;

/// `def.params.safeParse(params ?? {})`: these schemas strip unknown keys.
fn params_object(params: &Value) -> Result<Map<String, Value>, CoreError> {
    match params {
        Value::Null => Ok(Map::new()),
        _ => object(params).cloned(),
    }
}

/// `z.object({ name: z.string().min(1).max(256), expect_rev: z.number().int().positive().safe() })`
/// with zod's issue order and messages, joined like `parseOpParams`.
fn parse_machine_set(params: &Value) -> Result<(String, i64), CoreError> {
    let map = params_object(params)?;
    let mut issues = Vec::new();
    let name = match map.get("name") {
        Some(Value::String(text)) => {
            let len = text.encode_utf16().count();
            if len < 1 {
                issues.push("name: Too small: expected string to have >=1 characters".to_owned());
            } else if len > 256 {
                issues.push("name: Too big: expected string to have <=256 characters".to_owned());
            }
            Some(text.clone())
        }
        other => {
            let received = other.map_or("undefined", type_name);
            issues.push(format!(
                "name: Invalid input: expected string, received {received}"
            ));
            if let Some(Value::Array(items)) = other {
                if items.is_empty() {
                    issues.push("name: Too small: expected array to have >=1 items".to_owned());
                } else if items.len() > 256 {
                    issues.push("name: Too big: expected array to have <=256 items".to_owned());
                }
            }
            None
        }
    };
    let rev = match map.get("expect_rev") {
        Some(Value::Number(n)) => {
            let n = n.as_f64().unwrap_or(f64::NAN);
            if n.fract() != 0.0 || !n.is_finite() {
                issues.push("expect_rev: Invalid input: expected int, received number".to_owned());
                None
            } else {
                let range = if n > MAX_SAFE {
                    Some("expect_rev: Too big: expected int to be <=9007199254740991")
                } else if n < -MAX_SAFE {
                    Some("expect_rev: Too small: expected int to be >=-9007199254740991")
                } else {
                    None
                };
                issues.extend(range.map(str::to_owned));
                if n <= 0.0 {
                    issues.push("expect_rev: Too small: expected number to be >0".to_owned());
                }
                issues.extend(range.map(str::to_owned));
                Some(n as i64)
            }
        }
        other => {
            let received = other.map_or("undefined", type_name);
            issues.push(format!(
                "expect_rev: Invalid input: expected number, received {received}"
            ));
            None
        }
    };
    match (name, rev) {
        (Some(name), Some(rev)) if issues.is_empty() => Ok((name, rev)),
        _ => Err(invalid(issues.join("; "))),
    }
}

/// Identity work is blocking file, lock and `security` I/O.
async fn blocking(
    f: impl FnOnce() -> Result<Value, CoreError> + Send + 'static,
) -> Result<Value, CoreError> {
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| CoreError::new(Code::Internal, e.to_string()))?
}

pub(super) fn machine_get(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        params_object(&params)?;
        let ctx = ctx.clone();
        blocking(move || identity::machine_get(&ctx, &Env::system())).await
    })
}

pub(super) fn machine_set(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        let (name, expect_rev) = parse_machine_set(&params)?;
        let ctx = ctx.clone();
        blocking(move || identity::machine_set(&ctx, &Env::system(), &name, expect_rev)).await
    })
}

pub(super) fn machine_rotate(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        params_object(&params)?;
        let ctx = ctx.clone();
        blocking(move || identity::rotate(&ctx, &Env::system())).await
    })
}

#[cfg(test)]
#[allow(clippy::unwrap_used)]
mod tests {
    use super::parse_machine_set;
    use serde_json::json;

    #[test]
    fn machine_set_params_match_zod_messages() {
        assert_eq!(
            parse_machine_set(&json!({"name":"a","expect_rev":2,"extra":true})).unwrap(),
            ("a".to_owned(), 2)
        );
        for (params, message) in [
            (
                json!(null),
                "name: Invalid input: expected string, received undefined; expect_rev: Invalid input: expected number, received undefined",
            ),
            (
                json!([]),
                "params: Invalid input: expected object, received array",
            ),
            (
                json!({"name":"","expect_rev":0}),
                "name: Too small: expected string to have >=1 characters; expect_rev: Too small: expected number to be >0",
            ),
            (
                json!({"name":[],"expect_rev":{}}),
                "name: Invalid input: expected string, received array; name: Too small: expected array to have >=1 items; expect_rev: Invalid input: expected number, received object",
            ),
            (
                json!({"name":"a","expect_rev":-1.5}),
                "expect_rev: Invalid input: expected int, received number",
            ),
            (
                json!({"name":"a","expect_rev":1e21}),
                "expect_rev: Too big: expected int to be <=9007199254740991; expect_rev: Too big: expected int to be <=9007199254740991",
            ),
            (
                json!({"name":"a","expect_rev":-1e300}),
                "expect_rev: Too small: expected int to be >=-9007199254740991; expect_rev: Too small: expected number to be >0; expect_rev: Too small: expected int to be >=-9007199254740991",
            ),
        ] {
            assert_eq!(
                parse_machine_set(&params).unwrap_err().message,
                message,
                "{params}"
            );
        }
    }
}
