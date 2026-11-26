//! Native `job.list`, `job.get` and `job.cancel` over the shared job files in
//! `state/jobs` (`src/jobs/registry.ts`). A running job's owner polls its file,
//! so writing the cancelled state is the whole cross-process cancellation.
//! Files are read with `JSON.parse` semantics: a missing file is an unknown
//! job, an unreadable or malformed one throws, `listJobs` skips what it cannot
//! read, and non-object documents keep the runtime's own property behavior.
#![allow(clippy::result_large_err)]
use crate::lifecycle_ops::{invalid, type_name};
use crate::session_context_ops::authorize;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError, OpFuture},
    fsutil::write_private,
};
use pacer_js_json::quoted;
use pacer_lifecycle::jobs;
use serde_json::Value;
use std::{
    fs, io,
    path::{Path, PathBuf},
};

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
    /// `JSON.parse` or the file read threw; only the runtime spells the message.
    Foreign(CoreError),
}

/// Node's `ErrnoException` message, which the API reports as an internal error.
fn node_error(error: &io::Error, syscall: &str, path: &Path) -> CoreError {
    let (code, message) = match error.raw_os_error() {
        Some(2) => ("ENOENT", "no such file or directory"),
        Some(13) => ("EACCES", "permission denied"),
        Some(20) => ("ENOTDIR", "not a directory"),
        Some(21) => ("EISDIR", "is a directory"),
        _ => ("EIO", "input/output error"),
    };
    CoreError::new(
        Code::Internal,
        format!("{code}: {message}, {syscall} '{}'", path.display()),
    )
}

fn read(ctx: &Ctx, id: &str) -> Stored {
    let path = directory(ctx).join(format!("{id}.json"));
    match fs::read(&path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => Stored::Missing,
        Err(error) => Stored::Foreign(node_error(&error, "open", &path)),
        Ok(bytes) => match quoted::parse_file(&bytes) {
            Ok(job) => Stored::Job(job),
            Err(error) => Stored::Foreign(CoreError::new(Code::Internal, error)),
        },
    }
}

/// JavaScript's `-` coercion: a non-number becomes `NaN`, so the comparison is
/// false, exactly as `getJob`'s retention check behaves.
fn numeric(value: Option<&Value>) -> f64 {
    value.and_then(quoted::js_number).unwrap_or(f64::NAN)
}

/// `getJob` for a missing file: Core's own not-found error.
fn missing(id: &str) -> CoreError {
    invalid(format!("unknown job {id}"))
}

/// `listJobs` entries whose documents survive retention, in directory order.
fn entries(ctx: &Ctx) -> Result<Vec<(String, Value)>, CoreError> {
    let dir_path = directory(ctx);
    let names = match fs::read_dir(&dir_path) {
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(vec![]),
        Err(error) => return Err(node_error(&error, "scandir", &dir_path)),
        Ok(dir) => dir
            .map(|entry| entry.map(|e| e.file_name().to_string_lossy().into_owned()))
            .collect::<io::Result<Vec<_>>>()
            .map_err(|error| node_error(&error, "scandir", &dir_path))?,
    };
    let mut out = Vec::new();
    for name in names {
        let Some(id) = name.strip_suffix(".json").filter(|id| jobs::valid_id(id)) else {
            continue;
        };
        // TypeScript catches every read/parse failure here and skips the file.
        let Stored::Job(job) = read(ctx, id) else {
            continue;
        };
        // `null.state` throws a TypeError, which listJobs catches; other JSON
        // values simply have no `state` and keep the runtime's NaN behavior.
        if job.is_null() {
            continue;
        }
        let running = job["state"].as_str() == Some("running");
        let ended = job
            .get("endedAt")
            .filter(|value| !value.is_null())
            .or_else(|| job.get("startedAt"));
        // A NaN (non-numeric `startedAt`/`endedAt`) makes the comparison false,
        // so the document is kept just as `listJobs` keeps it.
        if !running && ctx.now - numeric(ended) > 86_400.0 {
            let _ = fs::remove_file(directory(ctx).join(&name));
            continue;
        }
        out.push((name, job));
    }
    Ok(out)
}

/// `ActiveJob` sort in registry.ts: `b.startedAt - a.startedAt || a.id.localeCompare(b.id)`.
/// A document without a string `id` makes the comparator throw when the
/// timestamps compare equal (or NaN), exactly as it does in the runtime.
fn sort_jobs(jobs: &mut [Value]) -> Result<(), CoreError> {
    let mut threw = false;
    let collator = icu_collator::CollatorBorrowed::new_root(Default::default());
    jobs.sort_by(|a, b| {
        let diff = numeric(b.get("startedAt")) - numeric(a.get("startedAt"));
        if diff > 0.0 {
            std::cmp::Ordering::Greater
        } else if diff < 0.0 {
            std::cmp::Ordering::Less
        } else {
            match (a["id"].as_str(), b["id"].as_str()) {
                (Some(left), Some(right)) => collator.compare(left, right),
                _ => {
                    threw = true;
                    std::cmp::Ordering::Equal
                }
            }
        }
    });
    if threw {
        Err(CoreError::new(
            Code::Internal,
            "undefined is not an object (evaluating 'a.id.localeCompare')",
        ))
    } else {
        Ok(())
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
        Stored::Missing => Err(missing(id)),
        Stored::Foreign(error) => Err(error),
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
        let found = entries(ctx)?;
        let mut kept: Vec<Value> = found
            .into_iter()
            .filter(|(_, job)| target.is_none_or(|t| job["target"].as_str() == Some(t)))
            .map(|(_, job)| job)
            .collect();
        sort_jobs(&mut kept)?;
        Ok(Value::Array(kept))
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
