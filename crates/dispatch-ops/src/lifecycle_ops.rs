//! Native `dispatch.submit`, `dispatch.child`, `dispatch.wait`, `dispatch.review`,
//! `dispatch.retry`, `dispatch.answer` and `dispatch.stop` (`submitWork`,
//! `delegateChild`, `waitWork`, `reviewWork`, `retryWork`, `answerWork` and
//! `stopWork` in `src/core/work.ts`).
//!
//! Rust owns the caller refusals (`authorizeWorkOperation`) and the Zod issue
//! text of the published params. A request that would act stays forwarded:
//! admission and `launchTaskRunner` spawn, queue drain and runner supervision
//! while waiting, and the review, retry, answer and subtree-stop transactions
//! belong to Core. `options` on `submit` and `child` forwards as well, because
//! `workOptionsSchema` issues interleave with the other fields' issues. So does
//! a fractional, exponent or out-of-range number in a schema field, which
//! serde_json may round differently from `JSON.parse`.
//! Callers holding a work grant never reach these handlers.
#![allow(clippy::result_large_err)]
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
};
use serde_json::{Map, Value};

use crate::dispatch_ops::{
    authorize, finish, int_issues, params_object, positive_int_issues, string_issues, type_name,
};

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
    ("requestId", ID, true),
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
    authorize(ctx)?;
    let p = params_object(params)?;
    if (matches!(op, "dispatch.submit" | "dispatch.child") && p.contains_key("options"))
        || (op == "dispatch.child" && (p.contains_key("difficulty") || p.contains_key("model")))
    {
        return Ok(());
    }
    if inexact_number(shape, &p) {
        return Ok(());
    }
    finish(params_issues(shape, &p))
}

/// serde_json reads integer literals that fit 64 bits exactly; any other number
/// may round differently from `JSON.parse`, so Core reads it.
fn inexact_number(shape: Shape, p: &Map<String, Value>) -> bool {
    shape
        .iter()
        .any(|(name, ..)| matches!(p.get(*name), Some(Value::Number(n)) if n.is_f64()))
}

/// Inputs Rust would not refuse: Core spawns, supervises and settles the work.
pub fn lifecycle_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    LIFECYCLE_OPS.contains(&op) && check(ctx, op, params).is_ok()
}

fn refuse<'a>(ctx: &'a Ctx, op: &'static str, params: Value) -> OpFuture<'a> {
    Box::pin(async move {
        check(ctx, op, &params)?;
        Err(CoreError::new(
            Code::Unavailable,
            "dispatch lifecycle bridge unavailable",
        ))
    })
}

pub fn dispatch_submit(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    refuse(ctx, "dispatch.submit", params)
}

pub fn dispatch_child(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    refuse(ctx, "dispatch.child", params)
}

pub fn dispatch_wait(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    refuse(ctx, "dispatch.wait", params)
}

pub fn dispatch_review(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    refuse(ctx, "dispatch.review", params)
}

pub fn dispatch_retry(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    refuse(ctx, "dispatch.retry", params)
}

pub fn dispatch_answer(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    refuse(ctx, "dispatch.answer", params)
}

pub fn dispatch_stop(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    refuse(ctx, "dispatch.stop", params)
}

#[cfg(test)]
#[path = "lifecycle_ops/tests.rs"]
mod tests;
