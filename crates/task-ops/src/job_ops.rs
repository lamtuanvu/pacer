//! Native `job.list`, `job.get` and `job.cancel` over the shared job files in
//! `state/jobs` (`src/jobs/registry.ts`). A running job's owner polls its file,
//! so writing the cancelled state is the whole cross-process cancellation.
//! Files only Bun's parser describes (unreadable, malformed or not a job
//! object) forward to TypeScript.
#![allow(clippy::result_large_err)]
use crate::lifecycle_ops::{invalid, type_name};
use crate::session_context_ops::authorize;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
};
use pacer_lifecycle::jobs;
use serde_json::Value;
use std::{fs, io, path::PathBuf};

fn directory(ctx: &Ctx) -> PathBuf {
    ctx.pacer_home.join("state").join("jobs")
}

/// `JSON.stringify` spelling for an integral `ctx.now`.
fn js_number(value: f64) -> Value {
    if value.is_finite() && value.fract() == 0.0 && value.abs() < 9_007_199_254_740_992.0 {
        Value::from(value as i64)
    } else {
        Value::from(value)
    }
}

enum Stored {
    Missing,
    Job(Value),
    /// Read or parse failures whose messages only TypeScript reproduces.
    Foreign,
}

fn read(ctx: &Ctx, id: &str) -> Stored {
    match fs::read(directory(ctx).join(format!("{id}.json"))) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Stored::Missing,
        Err(_) => Stored::Foreign,
        Ok(bytes) => serde_json::from_slice(&bytes).map_or(Stored::Foreign, Stored::Job),
    }
}

/// `job.list` entries in directory order, or `None` when TypeScript would throw.
fn entries(ctx: &Ctx) -> Option<Vec<(String, Value)>> {
    let names = match fs::read_dir(directory(ctx)) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Some(vec![]),
        Err(_) => return None,
        Ok(dir) => dir
            .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<io::Result<Vec<_>>>()
            .ok()?,
    };
    let mut out = Vec::new();
    for name in names {
        let Some(id) = name.strip_suffix(".json").filter(|id| jobs::valid_id(id)) else {
            continue;
        };
        let Stored::Job(job) = read(ctx, id) else {
            continue;
        };
        let number = |key: &str| job.get(key).is_none_or(|v| v.is_number() || v.is_null());
        if !job.is_object() || !job["startedAt"].is_number() || !number("endedAt") {
            return None;
        }
        out.push((name, job));
    }
    Some(out)
}

fn single_id(params: &Value) -> Option<&str> {
    params.get("id").and_then(Value::as_str)
}

/// Inputs whose result only the TypeScript job registry reproduces.
pub fn job_stays_forwarded(ctx: &Ctx, op: &str, params: &Value) -> bool {
    match op {
        "job.list" => entries(ctx).is_none(),
        "job.get" | "job.cancel" => single_id(params)
            .filter(|id| jobs::valid_id(id))
            .is_some_and(|id| match read(ctx, id) {
                Stored::Foreign => true,
                Stored::Job(job) => op == "job.cancel" && !job.is_object(),
                Stored::Missing => false,
            }),
        _ => false,
    }
}

/// `z.object({<name>: z.string().min(1).max(128)})`, absent params as `{}`.
fn id_param<'a>(
    params: &'a Value,
    name: &str,
    optional: bool,
) -> Result<Option<&'a str>, CoreError> {
    let map = match params {
        Value::Null => None,
        Value::Object(map) => Some(map),
        other => {
            return Err(invalid(format!(
                "params: Invalid input: expected object, received {}",
                type_name(other)
            )));
        }
    };
    let value = match map.and_then(|map| map.get(name)) {
        None if optional => return Ok(None),
        None => {
            return Err(invalid(format!(
                "{name}: Invalid input: expected string, received undefined"
            )));
        }
        Some(Value::String(value)) => value,
        Some(other) => {
            return Err(invalid(format!(
                "{name}: Invalid input: expected string, received {}",
                type_name(other)
            )));
        }
    };
    let units = value.encode_utf16().count();
    if units < 1 {
        return Err(invalid(format!(
            "{name}: Too small: expected string to have >=1 characters"
        )));
    }
    if units > 128 {
        return Err(invalid(format!(
            "{name}: Too big: expected string to have <=128 characters"
        )));
    }
    Ok(Some(value))
}

fn get(ctx: &Ctx, id: &str) -> Result<Value, CoreError> {
    if !jobs::valid_id(id) {
        return Err(invalid("invalid job id"));
    }
    match read(ctx, id) {
        Stored::Job(job) => Ok(job),
        Stored::Missing => Err(invalid(format!("unknown job {id}"))),
        Stored::Foreign => Err(CoreError::new(
            Code::Unavailable,
            "job.get: this job file needs the forwarded operation",
        )),
    }
}

pub fn job_get(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let id = id_param(&params, "id", false)?.unwrap_or_default();
        get(ctx, id)
    })
}

pub fn job_list(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let target = id_param(&params, "target", true)?;
        let found = entries(ctx).ok_or_else(|| {
            CoreError::new(
                Code::Unavailable,
                "job.list: the job directory needs the forwarded operation",
            )
        })?;
        let mut kept = Vec::new();
        for (name, job) in found {
            if jobs::retained(&job, ctx.now) {
                kept.push(job);
            } else {
                let _ = fs::remove_file(directory(ctx).join(name));
            }
        }
        Ok(Value::Array(jobs::list(&kept, ctx.now, target)))
    })
}

pub fn job_cancel(ctx: &Ctx, params: Value) -> OpFuture<'_> {
    Box::pin(async move {
        authorize(ctx)?;
        let id = id_param(&params, "id", false)?.unwrap_or_default();
        let job = get(ctx, id)?;
        let mut cancelled = jobs::cancel(&job, ctx.now)
            .map_err(|error| CoreError::new(Code::NotAllowed, error.message))?;
        if job["state"] != "running" {
            return Ok(job);
        }
        cancelled["endedAt"] = js_number(ctx.now);
        let bytes = serde_json::to_vec(&cancelled)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        write_private(&directory(ctx).join(format!("{id}.json")), &bytes)
            .map_err(|error| CoreError::new(Code::Internal, error.to_string()))?;
        let env = Value::Object(
            ctx.env
                .iter()
                .map(|(key, value)| (key.clone(), Value::String(value.clone())))
                .collect(),
        );
        if let Some(value) = jobs::published(&cancelled, &env) {
            let event =
                serde_json::json!({"type":"entity","data":{"kind":"job","id":id,"value":value}});
            for error in pacer_store::publish(ctx, &[event]).errors {
                eprintln!("pacer: job publication failed: {error}");
            }
        }
        Ok(cancelled)
    })
}

#[cfg(test)]
mod tests;
