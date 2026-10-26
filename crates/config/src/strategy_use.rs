//! Conservative native activation for the fully validated strategy subset.

use crate::strategy_list::use_selection;
use pacer_foundation::{
    Ctx,
    api::{
        error::{Code, CoreError},
        registry::NativeOp,
    },
    lock::{LockOptions, with_lock_async},
};
use rustix::{
    fs::{AtFlags, CWD, Mode, OFlags, openat, renameat, unlinkat},
    io::Errno,
};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{self, Write},
    path::PathBuf,
};

const HINT: &str =
    "Use strategy.list to choose a strategy and strategy.preview to validate a draft.";

fn changed() -> CoreError {
    CoreError::new(Code::Conflict, "active strategy changed; retry").hint(HINT)
}

fn write_active(ctx: &Ctx, name: &str) -> io::Result<PathBuf> {
    let pacer = File::from(openat(
        CWD,
        &ctx.pacer_home,
        OFlags::RDONLY | OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    if name == "default" {
        match unlinkat(&pacer, "active", AtFlags::empty()) {
            Ok(()) | Err(Errno::NOENT) => {}
            Err(error) => return Err(error.into()),
        }
        return Ok(ctx.pacer_home.join("strategy.yaml"));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        pacer.set_permissions(std::fs::Permissions::from_mode(0o700))?;
    }
    let mut random = [0u8; 8];
    getrandom::fill(&mut random).map_err(io::Error::other)?;
    let temp = format!("active.{}.tmp", u64::from_le_bytes(random));
    let mut file = File::from(openat(
        &pacer,
        temp.as_str(),
        OFlags::WRONLY | OFlags::CREATE | OFlags::EXCL | OFlags::NOFOLLOW | OFlags::CLOEXEC,
        Mode::from_bits_retain(0o600),
    )?);
    let result = file
        .write_all(format!("{name}\n").as_bytes())
        .and_then(|()| renameat(&pacer, temp.as_str(), &pacer, "active").map_err(Into::into));
    if result.is_err() {
        let _ = unlinkat(&pacer, temp.as_str(), AtFlags::empty());
    }
    result?;
    Ok(ctx
        .pacer_home
        .join("strategies")
        .join(format!("{name}.yaml")))
}

/// Preserve TypeScript parsing and validation for any unsupported request or file.
pub fn requires_core_strategy_use_parser(ctx: &Ctx, params: &Value) -> bool {
    use_selection(ctx, params).is_none()
}

async fn use_op(ctx: &Ctx, params: Value) -> Result<Value, CoreError> {
    use_op_with(ctx, params, || {}).await
}

async fn use_op_with(
    ctx: &Ctx,
    params: Value,
    before_lock: impl FnOnce(),
) -> Result<Value, CoreError> {
    let (name, observed) = use_selection(ctx, &params).ok_or_else(changed)?;
    before_lock();
    with_lock_async(ctx, "strategy", LockOptions::default(), || async {
        let (_, current) = use_selection(ctx, &params).ok_or_else(changed)?;
        if current != observed {
            return Err(changed());
        }
        let path = write_active(ctx, &name)
            .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()).hint(HINT))?;
        pacer_store::record_strategy_switch(ctx, &name)
            .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()).hint(HINT))?;
        Ok(json!({"name":name,"path":path}))
    })
    .await
    .map_err(|error| CoreError::new(Code::InvalidInput, error.to_string()).hint(HINT))?
}

fn op(ctx: &Ctx, params: Value) -> pacer_foundation::api::registry::OpFuture<'_> {
    Box::pin(use_op(ctx, params))
}

pub fn ops() -> &'static [NativeOp] {
    &[NativeOp {
        name: "strategy.use",
        call: op,
    }]
}

#[cfg(test)]
mod tests;
