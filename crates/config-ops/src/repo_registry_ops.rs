//! Native `repo.list` (`listReposWithBranches` in `src/core/repos.ts`) over the Rust
//! repository registry. Registries the JavaScript reader treats differently stay forwarded.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use pacer_lifecycle::repo_registry;
use serde_json::{Map, Value, json};

pub fn repo_list_stays_forwarded(ctx: &Ctx, op: &str) -> bool {
    op == "repo.list" && repo_registry::registry_needs_core(&ctx.pacer_home)
}

pub(crate) fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

/// The params object of a (stripping) Zod object schema; `null` reads as `{}`.
pub(crate) fn params_object(params: &Value) -> Result<Map<String, Value>, CoreError> {
    match params {
        Value::Null => Ok(Map::new()),
        Value::Object(map) => Ok(map.clone()),
        other => Err(CoreError::new(
            Code::InvalidInput,
            format!(
                "params: Invalid input: expected object, received {}",
                received(Some(other))
            ),
        )),
    }
}

/// Registered repositories with their local branches, current branch first.
pub fn repo_list(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        params_object(&params)?;
        let repos = repo_registry::list_repos(ctx, false)?;
        let branches: Vec<Result<Vec<String>, CoreError>> = std::thread::scope(|scope| {
            let reads: Vec<_> = repos
                .iter()
                .map(|repo| {
                    scope.spawn(|| repo_registry::read_branches(&ctx.pacer_home, &repo.path))
                })
                .collect();
            reads
                .into_iter()
                .map(|read| {
                    read.join().unwrap_or_else(|_| {
                        Err(CoreError::new(Code::Internal, "branch read failed"))
                    })
                })
                .collect()
        });
        let mut out = Vec::with_capacity(repos.len());
        for (repo, branches) in repos.iter().zip(branches) {
            let mut row = repo.to_json();
            row["branches"] = json!(branches?);
            out.push(row);
        }
        Ok(Value::Array(out))
    })
}
