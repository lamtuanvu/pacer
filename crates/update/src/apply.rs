//! Native `update.apply` (`applyUpdate` in `src/api/ops.ts`).
//!
//! Rust owns the caller refusals, the install-method/source preflight and the shared
//! update job. There is no Core effects bridge: `run.rs` performs the download, verify
//! and pair replacement, and the front door supplies refresh, migration and restart.
use crate::{
    manager,
    run::{self, NoopHost, UpdateInputs, UpdateOptions},
};
use pacer_foundation::api::CoreError;
use pacer_foundation::{Ctx, api::Code};
use serde_json::Value;
use std::path::Path;

const UPGRADE_REFUSAL: &str =
    "PACER_ROLE=executor: upgrades are not allowed from a delegated task.";

/// The hint TypeScript attaches to every manager refusal (`src/api/ops.ts:180`).
pub const MANAGED_UPDATE_HINT: &str =
    "This installation is updated by its own installer, not by this service.";

/// The refusals and schema; an admitted request is the reference operation's to run.
pub fn admit(ctx: &Ctx, params: &Value) -> Result<(), CoreError> {
    if ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor") {
        return Err(CoreError::new(Code::NotAllowed, UPGRADE_REFUSAL));
    }
    if ctx
        .env
        .get("PACER_ENFORCEMENT_TOKEN")
        .is_some_and(|token| !token.is_empty())
    {
        return Err(CoreError::new(
            Code::NotAllowed,
            "Enforcement identity only reports a native child denial",
        ));
    }
    match params {
        Value::Null | Value::Object(_) => Ok(()),
        other => Err(CoreError::new(
            Code::InvalidInput,
            format!(
                "params: Invalid input: expected object, received {}",
                match other {
                    Value::Array(_) => "array",
                    Value::String(_) => "string",
                    Value::Number(_) => "number",
                    Value::Bool(_) => "boolean",
                    _ => "null",
                }
            ),
        )),
    }
}

/// `true` unless `PACER_CORE_ARGV` is set, i.e. a source core runs this front door.
pub fn standalone(env: &std::collections::HashMap<String, String>) -> bool {
    run::standalone(env)
}

/// `applyUpdate` before the job: manager refusal, then the install-method preflight.
///
/// The preflight runs `runUpdate({check:false}, {..., standalone:false})`, which always
/// stops before fetching. Except for a plain source install, its refusal becomes a
/// `not_allowed` error; a source install additionally gets the release-build hint.
pub fn preflight(ctx: &Ctx, inputs: &UpdateInputs) -> Result<(), CoreError> {
    let exec_dir = inputs.exec_path.parent().unwrap_or_else(|| Path::new(""));
    if let Some(manager) = manager::update_manager(ctx, &inputs.exec_path, exec_dir, inputs.nightly)
    {
        return Err(CoreError::new(Code::NotAllowed, manager.message).hint(MANAGED_UPDATE_HINT));
    }
    let probe = UpdateInputs {
        env: inputs.env.clone(),
        pacer_home: inputs.pacer_home.clone(),
        exec_path: inputs.exec_path.clone(),
        standalone: false,
        version: inputs.version.clone(),
        platform: inputs.platform,
        nightly: inputs.nightly,
    };
    let result = run::run_update(
        &UpdateOptions {
            check: false,
            ..UpdateOptions::default()
        },
        &probe,
        &mut NoopHost,
    );
    if !inputs.standalone
        || !result
            .err
            .starts_with("pacer update: this pacer runs from source")
    {
        let message = result
            .err
            .strip_prefix("pacer update: ")
            .unwrap_or(&result.err)
            .to_owned();
        let error = CoreError::new(Code::NotAllowed, message);
        return Err(if inputs.standalone {
            error
        } else {
            error.hint("Install a release build to update from this screen.")
        });
    }
    Ok(())
}
