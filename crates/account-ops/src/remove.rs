//! `account.remove` from `accounts.remove` in `src/core/accounts.ts`.
use crate::{
    SETTINGS_CONFLICT, evidence,
    js::{prototype_key, resolve},
    model::{account_folder, evidence_identity, path_text},
    params, strategy_loads,
};
use pacer_config::{
    config_writes::{edit, ensure_migrated},
    strategy::{StrategyError, load_strategy},
};
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const HINT: &str = "Check the account name, options and configured accounts.";

pub(crate) fn stays_forwarded(ctx: &Ctx, params: &Value) -> bool {
    match params::remove(params) {
        None => true,
        Some((name, _)) => prototype_key(&name) || !strategy_loads(ctx),
    }
}

fn refuse(message: impl Into<String>) -> CoreError {
    CoreError::new(Code::InvalidInput, message).hint(HINT)
}

/// Errors before the edit keep the account hint; the edit adds the strategy hint.
fn load_error(error: StrategyError) -> CoreError {
    let message = error.to_string();
    if message == SETTINGS_CONFLICT {
        return CoreError::new(Code::Conflict, message).hint(HINT);
    }
    refuse(message)
}

fn edit_error(error: StrategyError) -> CoreError {
    let message = error.to_string();
    if message == SETTINGS_CONFLICT || message.contains("changed during edit") {
        return CoreError::new(Code::Conflict, SETTINGS_CONFLICT).hint(HINT);
    }
    CoreError::new(Code::InvalidInput, message).hint("Check the strategy values and retry.")
}

fn canonical(p: &Path) -> PathBuf {
    if p.exists() {
        std::fs::canonicalize(p).unwrap_or_else(|_| resolve(p))
    } else {
        resolve(p)
    }
}

/// `deletionHome`: never a shared, default or symlinked folder.
fn deletion_home(ctx: &Ctx, s: &Value, name: &str) -> Result<PathBuf, CoreError> {
    let account = &s["accounts"][name];
    if account["source"] != "pacer" {
        return Err(refuse(
            "--delete-home is only available for pacer-managed accounts",
        ));
    }
    let folder = account_folder(ctx, account).ok_or_else(|| refuse("account home not found"))?;
    if folder.exists()
        && std::fs::symlink_metadata(&folder).is_ok_and(|m| m.file_type().is_symlink())
    {
        return Err(refuse("refusing to delete a symlinked account home"));
    }
    let target = canonical(&folder);
    if target.parent().is_none() {
        return Err(refuse("refusing to delete a protected account home"));
    }
    let mut protected = vec![
        ctx.home.clone(),
        ctx.pacer_home.clone(),
        ctx.home.join(".claude"),
        ctx.home.join(".codex"),
    ];
    protected.extend(
        s["accounts"]
            .as_object()
            .into_iter()
            .flat_map(|accounts| accounts.values())
            .filter(|a| a["name"] != name)
            .filter_map(|a| account_folder(ctx, a)),
    );
    let target_text = path_text(&target);
    let inside = format!("{target_text}/");
    if protected.iter().any(|p| {
        let c = path_text(&canonical(p));
        c == target_text || c.starts_with(&inside)
    }) {
        return Err(refuse(
            "refusing to delete a protected or shared account home",
        ));
    }
    Ok(folder)
}

pub(crate) fn remove(ctx: &Ctx, params: &Value) -> Result<Value, CoreError> {
    let (name, delete_home) = params::remove(params).ok_or_else(crate::forwarded)?;
    let home = &ctx.pacer_home;
    let migrated = ensure_migrated(home).map_err(load_error)?;
    let s = load_strategy(home).map_err(load_error)?;
    let account = s["accounts"]
        .get(&name)
        .cloned()
        .ok_or_else(|| refuse(format!("unknown account: {name}")))?;
    let in_use = s["planner"]["account"] == name.as_str()
        || s["runners"]
            .as_object()
            .is_some_and(|runners| runners.values().any(|r| r["account"] == name.as_str()));
    if in_use {
        return Err(
            CoreError::new(Code::Conflict, format!("account {name} is in use"))
                .hint("Remove its runners and change the planner first."),
        );
    }
    let folder = if delete_home {
        Some(deletion_home(ctx, &s, &name)?)
    } else {
        None
    };
    edit(home, |doc, _| {
        doc.remove_mapping_entry("accounts", &name)
            .map_err(|e| StrategyError::Other(e.to_string()))
    })
    .map_err(edit_error)?;
    evidence::retire(ctx, &evidence_identity(&account, &s["hosts"]), &name).map_err(refuse)?;
    if let Some(folder) = folder {
        match std::fs::remove_dir_all(&folder) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => {
                std::fs::remove_file(&folder).map_err(|_| refuse(e.to_string()))?;
            }
            _ => {}
        }
    }
    let mut result = json!({"removed": true});
    if let Some(migrated) = migrated {
        result["migrated"] = migrated;
    }
    Ok(result)
}
