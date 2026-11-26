//! Native `dispatch.submit`, `dispatch.child`, `dispatch.wait`, `dispatch.review`,
//! `dispatch.retry`, `dispatch.answer` and `dispatch.stop` (`submitWork`,
//! `delegateChild`, `waitWork`, `reviewWork`, `retryWork`, `answerWork` and
//! `stopWork` in `src/core/work.ts`).
//!
//! Rust owns the caller refusals (`authorizeWorkOperation`) and the Zod issue
//! text of the published params. All seven lifecycle ops are served natively
//! end-to-end: after `check` passes they route through [`LifecycleEffects`],
//! which the server backs with `pacer_delegation::work`. `options`,
//! `difficulty` and `model` are validated natively against `workOptionsSchema`
//! (see [`crate::work_options`]), so those requests no longer forward. B2-9
//! owned submit/child, B2-10 added wait/review/stop and B2-11 adds retry and
//! answer (`pacer_delegation::work::{retry_work, answer_work}`).
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value};
use std::sync::{Arc, OnceLock};

use crate::dispatch_ops::{
    authorize, finish, int_issues, params_object, positive_int_issues, string_issues, type_name,
};
use crate::preview_ops::{issue_enum, issue_string};

/// Effects a native lifecycle op needs that `dispatch_ops` cannot own. The
/// front door installs a runtime-backed implementation once at startup; all
/// seven ops route through it.
pub trait LifecycleEffects: Send + Sync {
    fn submit<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a>;
    fn child<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a>;
    fn wait<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a>;
    fn review<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a>;
    fn retry<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a>;
    fn answer<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a>;
    fn stop<'a>(&'a self, ctx: &'a Ctx, params: Value) -> OpFuture<'a>;
}

static EFFECTS: OnceLock<Arc<dyn LifecycleEffects + Send + Sync>> = OnceLock::new();

/// Install the [global] runtime-backed effects. Called once by the front door.
pub fn install_lifecycle_effects(effects: Arc<dyn LifecycleEffects + Send + Sync>) {
    let _ = EFFECTS.set(effects);
}

fn effects() -> Result<&'static (dyn LifecycleEffects + Send + Sync), CoreError> {
    EFFECTS
        .get()
        .map(Arc::as_ref)
        .ok_or_else(|| CoreError::new(Code::Unavailable, "dispatch lifecycle bridge unavailable"))
}

pub const LIFECYCLE_OPS: &[&str] = &[
    "dispatch.submit",
    "dispatch.child",
    "dispatch.wait",
    "dispatch.review",
    "dispatch.retry",
    "dispatch.answer",
    "dispatch.stop",
];

/// One published params field, checked as its Zod schema in `src/api/ops.ts`.
#[derive(Clone, Copy)]
enum Field {
    /// `z.string().min(1).max(n)`; the `id` schema is `Name(128)`.
    Name(usize),
    /// `z.string().max(n)`.
    Text(usize),
    /// `z.number().int().min(min).max(max)`.
    Int(f64, f64),
    /// `z.number().int().positive()`.
    PositiveInt,
    /// `z.boolean()`.
    Bool,
    /// `workOptionsSchema.partial().optional()` for the `options` param
    /// (`src/api/ops.ts`), served natively under B2-9.
    Options,
    /// `delegateSchema.difficulty` passed as a top-level `dispatch.child` param.
    Difficulty,
    /// `delegateSchema.model` passed as a top-level `dispatch.child` param.
    Model,
}

/// `(key, schema, required)` in schema key order, which is Zod's issue order.
type Shape = &'static [(&'static str, Field, bool)];

const ID: Field = Field::Name(128);
const LONG: Field = Field::Text(20_000);

const SUBMIT: Shape = &[
    ("goal", Field::Name(20_000), true),
    ("repo", Field::Name(4096), true),
    ("title", Field::Text(500), false),
    ("kind", ID, false),
    ("acceptance", LONG, false),
    ("acceptance_timeout_min", Field::Int(1.0, 120.0), false),
    ("context", LONG, false),
    ("constraints", LONG, false),
    ("executor", ID, false),
    ("requestId", ID, false),
    ("options", Field::Options, false),
];
const CHILD: Shape = &[
    ("goal", Field::Name(20_000), true),
    ("title", Field::Text(500), false),
    ("kind", ID, false),
    ("acceptance", LONG, false),
    ("acceptance_timeout_min", Field::Int(1.0, 120.0), false),
    ("context", LONG, false),
    ("constraints", LONG, false),
    ("executor", ID, false),
    ("difficulty", Field::Difficulty, false),
    ("model", Field::Model, false),
    ("requestId", ID, true),
    ("options", Field::Options, false),
];
const WAIT: Shape = &[
    ("id", ID, true),
    ("timeout_s", Field::Int(1.0, 3000.0), false),
];
const REVIEW: Shape = &[
    ("id", ID, true),
    ("accepted", Field::Bool, true),
    ("note", Field::Text(2000), false),
    ("expect_rev", Field::PositiveInt, true),
];
const RETRY: Shape = &[
    ("id", ID, true),
    ("expect_rev", Field::PositiveInt, true),
    ("requestId", ID, true),
    ("feedback", Field::Text(2000), false),
];
const ANSWER: Shape = &[
    ("id", ID, true),
    ("expect_rev", Field::PositiveInt, true),
    ("requestId", ID, true),
    ("text", Field::Name(2000), true),
];
const STOP: Shape = &[("id", ID, true), ("expect_rev", Field::PositiveInt, false)];

fn shape(op: &str) -> Option<Shape> {
    Some(match op {
        "dispatch.submit" => SUBMIT,
        "dispatch.child" => CHILD,
        "dispatch.wait" => WAIT,
        "dispatch.review" => REVIEW,
        "dispatch.retry" => RETRY,
        "dispatch.answer" => ANSWER,
        "dispatch.stop" => STOP,
        _ => return None,
    })
}

/// `z.string().max(max)`; Zod counts code points.
fn text_issues(name: &str, value: &Value, max: usize, issues: &mut Vec<String>) {
    match value {
        Value::String(text) if text.chars().count() > max => issues.push(format!(
            "{name}: Too big: expected string to have <={max} characters"
        )),
        Value::String(_) => {}
        other => issues.push(format!(
            "{name}: Invalid input: expected string, received {}",
            type_name(other)
        )),
    }
}

fn field_issues(name: &str, field: Field, value: Option<&Value>, issues: &mut Vec<String>) {
    match (field, value) {
        (Field::Name(max), value) => string_issues(name, value, Some(max), issues),
        (Field::PositiveInt, value) => positive_int_issues(name, value, issues),
        (Field::Text(_) | Field::Int(..) | Field::Bool, None) => {
            let expected = match field {
                Field::Bool => "boolean",
                Field::Int(..) => "number",
                _ => "string",
            };
            issues.push(format!(
                "{name}: Invalid input: expected {expected}, received undefined"
            ));
        }
        (Field::Text(max), Some(value)) => text_issues(name, value, max, issues),
        (Field::Int(min, max), Some(value)) => int_issues(name, value, min, Some(max), issues),
        (Field::Bool, Some(value)) if value.is_boolean() => {}
        (Field::Bool, Some(value)) => issues.push(format!(
            "{name}: Invalid input: expected boolean, received {}",
            type_name(value)
        )),
        // `options` is `workOptionsSchema.partial().optional()`; issue text and
        // key order mirror the `work_options` port of `src/dispatch/work.ts`.
        (Field::Options, Some(value)) => {
            crate::work_options::work_options_issues(issues, "options", value);
        }
        // `dispatch.child` also accepts `difficulty`/`model` as top-level
        // params, validated like `delegateSchema.difficulty`/`delegateSchema.model`.
        (Field::Difficulty, Some(value)) => {
            issues.extend(issue_enum(name, value, &["simple", "standard", "complex"]));
        }
        (Field::Model, Some(value)) => {
            issues.extend(issue_string(name, value, 1, 256));
        }
        (Field::Options | Field::Difficulty | Field::Model, None) => {}
    }
}

fn params_issues(shape: Shape, p: &Map<String, Value>) -> Vec<String> {
    let mut issues = Vec::new();
    for &(name, field, required) in shape {
        let value = p.get(name);
        if required || value.is_some() {
            field_issues(name, field, value, &mut issues);
        }
    }
    issues
}

/// `Ok(())` when Core must run the request; otherwise the refusal or params
/// error TypeScript answers before any lifecycle effect.
fn check(ctx: &Ctx, op: &str, params: &Value) -> Result<(), CoreError> {
    let Some(shape) = shape(op) else {
        return Err(CoreError::new(
            Code::UnknownOp,
            format!("unknown operation \"{op}\""),
        ));
    };
    authorize(ctx, op, params)?;
    let p = params_object(params)?;
    finish(params_issues(shape, &p))
}

pub fn dispatch_submit(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        check(ctx, "dispatch.submit", &params)?;
        effects()?.submit(ctx, params).await
    })
}

pub fn dispatch_child(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        check(ctx, "dispatch.child", &params)?;
        effects()?.child(ctx, params).await
    })
}

pub fn dispatch_wait(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        check(ctx, "dispatch.wait", &params)?;
        effects()?.wait(ctx, params).await
    })
}

pub fn dispatch_review(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        check(ctx, "dispatch.review", &params)?;
        effects()?.review(ctx, params).await
    })
}

pub fn dispatch_retry(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        check(ctx, "dispatch.retry", &params)?;
        effects()?.retry(ctx, params).await
    })
}

pub fn dispatch_answer(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        check(ctx, "dispatch.answer", &params)?;
        effects()?.answer(ctx, params).await
    })
}

pub fn dispatch_stop(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        check(ctx, "dispatch.stop", &params)?;
        effects()?.stop(ctx, params).await
    })
}

#[cfg(test)]
#[path = "lifecycle_ops/tests.rs"]
mod tests;
