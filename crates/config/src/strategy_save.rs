//! Conservative native strategy.save selection and byte-compatible serialization.

mod write;
mod yaml;

use crate::{
    strategy_list::{read_regular, summary, use_selection, valid_name},
    strategy_load::normalize_basic,
};
use jiff::Timestamp;
use pacer_foundation::{
    Ctx,
    api::{
        error::{Code, CoreError},
        registry::NativeOp,
    },
    lock::{LockOptions, with_lock_async},
};
use rustix::fs::{CWD, Mode, OFlags, openat};
use serde_json::{Value, json};
use std::{fs, path::PathBuf};

const HINT: &str =
    "Use strategy.list to choose a strategy and strategy.preview to validate a draft.";

struct Selected {
    name: String,
    content: String,
    overwrite: bool,
    existed: bool,
    active: String,
}

fn line(text: &str) -> String {
    text.chars()
        .map(|ch| if ch <= '\u{1f}' { ' ' } else { ch })
        .collect()
}

fn timestamp(now: f64) -> Option<String> {
    let millis = now * 1000.0;
    if !millis.is_finite() || !(0.0..=253_402_300_799_999.0).contains(&millis) {
        return None;
    }
    let stamp = Timestamp::from_millisecond(millis as i64).ok()?;
    Some(stamp.strftime("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
}

fn source_yaml(ctx: &Ctx, name: &str) -> Option<String> {
    let pacer = openat(
        CWD,
        &ctx.pacer_home,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .ok()?;
    if name == "default" {
        return read_regular(&pacer, "strategy.yaml", 256 * 1024);
    }
    let dir = openat(
        &pacer,
        "strategies",
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )
    .ok()?;
    read_regular(&dir, &format!("{name}.yaml"), 256 * 1024)
}

fn selection(ctx: &Ctx, params: &Value) -> Option<Selected> {
    let fields = params.as_object()?;
    if fields
        .keys()
        .any(|key| !matches!(key.as_str(), "name" | "draft" | "reason" | "overwrite"))
    {
        return None;
    }
    let name = fields.get("name")?.as_str()?;
    if name == "default" || !valid_name(name) {
        return None;
    }
    let reason = fields.get("reason")?.as_str()?;
    if reason.trim().is_empty() || !reason.is_ascii() || reason.len() > 4096 {
        return None;
    }
    let overwrite = match fields.get("overwrite") {
        Some(value) => value.as_bool()?,
        None => false,
    };
    let draft = fields.get("draft")?;
    let draft_fields = draft.as_object()?;
    if draft_fields
        .keys()
        .any(|key| !matches!(key.as_str(), "from" | "set" | "unset" | "description"))
    {
        return None;
    }
    let from = draft_fields.get("from")?.as_str()?;
    let (_, active) = use_selection(ctx, &json!({"name":from}))?;
    let source = source_yaml(ctx, from)?;
    let yaml = yaml::render_draft(&source, draft)?;
    let strategy = normalize_basic(&yaml, name)?;
    let description = match draft_fields.get("description") {
        Some(value) => value.as_str()?.to_owned(),
        None => summary(&strategy)?,
    };
    if !description.is_ascii() || description.len() > 4096 {
        return None;
    }
    let who = ctx
        .env
        .get("PACER_AGENT")
        .or_else(|| ctx.env.get("ORCA_AGENT"))
        .map_or("agent", String::as_str);
    if !who.is_ascii() || who.len() > 4096 {
        return None;
    }
    let target = ctx
        .pacer_home
        .join("strategies")
        .join(format!("{name}.yaml"));
    let existed = match fs::symlink_metadata(&target) {
        Ok(stat) if stat.is_file() => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        _ => return None,
    };
    Some(Selected {
        name: name.to_owned(),
        overwrite,
        existed,
        active,
        content: format!(
            "# {}\n# created by {} on {}: {}\n{yaml}",
            line(&description),
            line(who),
            timestamp(ctx.now)?,
            line(reason)
        ),
    })
}

/// Keep unsupported YAML, edits and request forms with the TypeScript core.
pub fn requires_core_strategy_save_parser(ctx: &Ctx, params: &Value) -> bool {
    selection(ctx, params).is_none()
}

fn changed() -> CoreError {
    CoreError::new(Code::Conflict, "strategy changed during save; retry").hint(HINT)
}

async fn save_op_with(
    ctx: &Ctx,
    params: Value,
    before_lock: impl FnOnce(),
) -> Result<Value, CoreError> {
    selection(ctx, &params).ok_or_else(changed)?;
    before_lock();
    with_lock_async(ctx, "strategy", LockOptions::default(), || async {
        let selected = selection(ctx, &params).ok_or_else(changed)?;
        let path: PathBuf = ctx.pacer_home.join("strategies").join(format!("{}.yaml", selected.name));
        if selected.existed && !selected.overwrite {
            return Err(CoreError::new(Code::InvalidInput, format!("strategy \"{}\" already exists; use overwrite:true to replace it", selected.name)).hint(HINT));
        }
        if selected.existed && selected.active == selected.name {
            return Err(CoreError::new(Code::InvalidInput, format!("strategy \"{}\" is active; overwriting changes live routing; use activeOk:true to approve", selected.name)).hint(HINT));
        }
        write::save_named(ctx, &selected.name, selected.content.as_bytes(), selected.overwrite)
            .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()).hint(HINT))?;
        pacer_store::record_strategy_change(ctx)
            .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()).hint(HINT))?;
        Ok(json!({"name":selected.name,"path":path}))
    }).await.map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()))?
}

async fn save_op(ctx: &Ctx, params: Value) -> Result<Value, CoreError> {
    save_op_with(ctx, params, || {}).await
}
fn op(ctx: &Ctx, params: Value) -> pacer_foundation::api::registry::OpFuture<'_> {
    Box::pin(save_op(ctx, params))
}
pub fn ops() -> &'static [NativeOp] {
    &[NativeOp {
        name: "strategy.save",
        call: op,
    }]
}

#[cfg(test)]
mod tests;
