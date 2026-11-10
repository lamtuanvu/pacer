//! Native `service.install` (`src/api/ops.ts`, `serviceInstall` in `src/core/setup.ts`).
//!
//! Rust owns the `parseOpParams` refusals and the consent schema. The install transaction and
//! manifest, the `pacerArgv` of the running core, `launchctl bootstrap`/`systemctl enable`, the
//! deferred self-reload and the health wait run in Core: over HTTP through its private effects
//! bridge (`/_internal/service-effects`), over stdio as the forwarded request.
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Value, json};

pub(crate) const UPGRADE_REFUSAL: &str =
    "PACER_ROLE=executor: upgrades are not allowed from a delegated task.";

/// One Core effect per call; requests are `{"kind": ...}` objects.
pub trait ServiceEffects: Send {
    fn call(&mut self, request: Value) -> OpFuture<'_>;
}

/// Ops a front door dispatches through [`service_install`] with a Core effects bridge.
pub fn uses_effects(op: &str) -> bool {
    op == "service.install"
}

/// Registry entry for `service.install`, which runs only with a Core effects bridge.
pub fn service_install_stub(_: &Ctx, _: Value) -> OpFuture<'_> {
    Box::pin(async move {
        Err(CoreError::new(
            Code::Unavailable,
            "service effects bridge unavailable",
        ))
    })
}

/// Work-grant callers, whose scope Core checks.
pub fn stays_forwarded(ctx: &Ctx) -> bool {
    ctx.env
        .get("PACER_WORK_GRANT")
        .is_some_and(|grant| !grant.is_empty())
}

/// `parseOpParams` refusals that precede the schema: executor upgrades, then enforcement.
pub(crate) fn authorize_upgrade(ctx: &Ctx) -> Result<(), CoreError> {
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
    Ok(())
}

/// `z.object({consent: z.literal(true)})` over `params ?? {}`.
fn consent(params: &Value) -> Result<(), CoreError> {
    let kind = match params {
        Value::Null => return Err(consent_issue()),
        Value::Object(map) => {
            return match map.get("consent") {
                Some(Value::Bool(true)) => Ok(()),
                _ => Err(consent_issue()),
            };
        }
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
    };
    Err(CoreError::new(
        Code::InvalidInput,
        format!("params: Invalid input: expected object, received {kind}"),
    ))
}

fn consent_issue() -> CoreError {
    CoreError::new(Code::InvalidInput, "consent: Invalid input: expected true")
}

/// The refusals and schema; an admitted request is the reference operation's to run.
pub fn admit(ctx: &Ctx, params: &Value) -> Result<(), CoreError> {
    authorize_upgrade(ctx)?;
    consent(params)
}

pub async fn service_install(
    ctx: &Ctx,
    params: Value,
    effects: &mut dyn ServiceEffects,
) -> Result<Value, CoreError> {
    admit(ctx, &params)?;
    effects.call(json!({"kind": "install"})).await
}
