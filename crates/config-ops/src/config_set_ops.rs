//! Native `config.set`: TypeScript `config.ts` `set` without planner integration
//! installs (wave 10) or Orca readiness probes (wave 3), which stay forwarded.
use std::collections::BTreeSet;
use std::sync::{Mutex, PoisonError};

use pacer_config::{
    settings::{self, PLANNER_INSTALL_FORWARDED, SetOptions},
    strategy::{load_strategy, strategy_path},
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use pacer_lifecycle::files_search::executor_session;
use serde_json::Value;

/// Per-process edits in flight, keyed like TypeScript `pendingEdits`.
static PENDING_EDITS: Mutex<BTreeSet<String>> = Mutex::new(BTreeSet::new());

/// Holds one `pendingEdits` key and releases it on every exit, including unwinding.
struct PendingEdit(String);

impl PendingEdit {
    fn claim(key: String) -> Option<Self> {
        let mut edits = PENDING_EDITS.lock().unwrap_or_else(PoisonError::into_inner);
        // A refused claim must not construct a guard: dropping it would release the holder's key.
        if !edits.insert(key.clone()) {
            return None;
        }
        Some(Self(key))
    }
}

impl Drop for PendingEdit {
    fn drop(&mut self) {
        PENDING_EDITS
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .remove(&self.0);
    }
}

fn backend_env(ctx: &Ctx) -> Option<&str> {
    ctx.env
        .get("PACER_BACKEND")
        .map(String::as_str)
        .filter(|env| !env.is_empty())
}

/// Planner changes that would install integrations and `execution.backend=orca`
/// without `PACER_BACKEND` stay on the TypeScript `config.set` path.
pub fn config_set_stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    let Ok(p) = super::config_params::parse("config.set", params.clone()) else {
        return false;
    };
    match p["key"].as_str() {
        Some("execution.backend") => p["value"] == "orca" && backend_env(ctx).is_none(),
        Some("planner") if p["integrations"] == "install" => {
            let Ok((path, name)) = strategy_path(&ctx.pacer_home) else {
                return false;
            };
            matches!(write(ctx, &path, &name, &p), Err(e) if e.message == PLANNER_INSTALL_FORWARDED)
        }
        _ => false,
    }
}

fn write(
    ctx: &Ctx,
    path: &std::path::Path,
    name: &str,
    p: &Value,
) -> Result<Value, settings::SettingsError> {
    let key = p["key"].as_str().unwrap_or_default();
    let executor = key == "planner"
        && executor_session(ctx, &std::env::current_dir().unwrap_or_default(), || {
            load_strategy(&ctx.pacer_home)
                .ok()
                .and_then(|s| Some(s.get("providers")?.as_object()?.keys().cloned().collect()))
                .unwrap_or_default()
        });
    let options = SetOptions {
        terminal_presets_only: ctx
            .env
            .get("PACER_TERMINAL_PRESETS_ONLY")
            .is_some_and(|v| v == "1"),
        integrations: p["integrations"].as_str(),
        executor_session: executor,
        backend_env: backend_env(ctx),
    };
    settings::set_setting(path, name, key, &p["value"], options)
}

/// Validated params in; publishes the `config` change before releasing the edit key.
#[allow(clippy::result_large_err)]
pub(crate) fn config_set(ctx: &Ctx, p: &Value) -> Result<Value, CoreError> {
    let key = p["key"].as_str().unwrap_or_default();
    let (path, name) = strategy_path(&ctx.pacer_home)
        .map_err(|e| CoreError::new(Code::InvalidInput, e.to_string()))?;
    let Some(_edit) = PendingEdit::claim(format!("{}:{key}", path.display())) else {
        return Err(
            CoreError::new(Code::Conflict, "This setting is already being changed")
                .hint("Refresh and retry."),
        );
    };
    let mut result = write(ctx, &path, &name, p).map_err(|e| {
        // The predicate saw an unchanged planner; the strategy changed since.
        if e.message == PLANNER_INSTALL_FORWARDED {
            CoreError::new(Code::Conflict, "Strategy changed during edit")
                .hint("Refresh and retry.")
        } else {
            super::config_writes::settings_error(e)
        }
    })?;
    // Match the TypeScript op handler: notes stay internal.
    if let Some(obj) = result.as_object_mut() {
        obj.remove("notes");
    }
    super::config_writes::publish(ctx, "config")?;
    Ok(result)
}

#[cfg(test)]
mod tests;
