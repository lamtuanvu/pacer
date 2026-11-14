//! Project policy for routing and dispatch previews (`src/core/project-policy.ts`): the
//! repository a `repo` input names, the identity a strict policy requires, and the inputs
//! only TypeScript reads (an unreadable policy or registry, live agent sessions).
#![allow(clippy::result_large_err)]
use pacer_dispatch::ReadOnlyStore;
use pacer_foundation::{
    Ctx,
    api::{Code, CoreError},
    lock::{LockOptions, with_lock},
};
use pacer_lifecycle::{AdmissionError, read_project_strategies};
use serde_json::{Value, json};
use std::path::Path;

const POLICY_FILE: &str = "project-strategies.json";

fn invalid(message: &str) -> CoreError {
    CoreError::new(Code::InvalidInput, message)
}

pub fn internal(error: impl ToString) -> CoreError {
    CoreError::new(Code::Internal, error.to_string())
}

/// A `project-strategies.json` only TypeScript reads: present, but not a regular file Rust
/// reads and validates, or beside a repository registry only TypeScript reads.
pub fn policy_needs_core(ctx: &Ctx) -> bool {
    let home = &ctx.pacer_home;
    match std::fs::metadata(home.join(POLICY_FILE)) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Ok(meta) if meta.is_file() => {
            read_project_strategies(home).is_err() || pacer_repos::registry_needs_core(home, false)
        }
        _ => true,
    }
}

/// Live agent sessions hold slots in `slotUse(…, ctx)`, and only Core probes their runs:
/// any session record that has not ended keeps the answer in TypeScript. Reads through the
/// read-only view, so asking writes nothing.
pub fn agent_sessions_may_hold_slots(ctx: &Ctx) -> bool {
    let Ok(store) = ReadOnlyStore::open(&ctx.pacer_home, true) else {
        return true;
    };
    if !store.has("agent_sessions") {
        return false;
    }
    let sql =
        "SELECT count(*) FROM agent_sessions WHERE json_extract(record, '$.state') IS NOT 'ended'";
    store
        .query(sql, [], |row| row.get::<_, i64>(0))
        .map_or(true, |open| open.first().is_none_or(|open| *open > 0))
}

/// A relative `repo` that names no registered repository (Core's working directory), or
/// a policy or registry only TypeScript reads. `writes`: the absolute path registers.
pub fn repo_needs_core(ctx: &Ctx, repo: &str, writes: bool) -> bool {
    let home = &ctx.pacer_home;
    let absolute = Path::new(repo).is_absolute();
    policy_needs_core(ctx)
        || pacer_repos::registry_needs_core(home, absolute && writes)
        || !absolute
            && !pacer_repos::list_repos_read_only(home)
                .iter()
                .any(|known| known.key == repo)
}

pub fn policy_error(AdmissionError(message): AdmissionError) -> CoreError {
    let hint = if message.starts_with("Cannot read") {
        "Check project-strategies.json permissions before delegating."
    } else {
        "Repair project-strategies.json before delegating; no global fallback was used."
    };
    invalid(&message).hint(hint)
}

/// A project naming its executors makes repository identity mandatory.
fn policy_is_strict(projects: &Value) -> bool {
    projects["projects"]
        .as_object()
        .is_some_and(|projects| projects.values().any(|p| !p["executors"].is_null()))
}

/// `requirePolicyIdentity`.
pub fn require_policy_identity(repo: &Value, projects: &Value) -> Result<(), CoreError> {
    if repo["identityUnverified"] == true && policy_is_strict(projects) {
        return Err(invalid("Cannot establish repository identity for project routing").hint(
            "Restore Git access and retry; project policy cannot safely fall back to global routing.",
        ));
    }
    Ok(())
}

fn registered(ctx: &Ctx, value: &str, read_only: bool) -> Result<Value, CoreError> {
    pacer_repos::list_repos(ctx, read_only)
        .map_err(internal)?
        .into_iter()
        .find(|known| known.key == value)
        .map(|known| known.to_json())
        .ok_or_else(|| invalid("repo must be an absolute path or a registered repo key"))
}

/// `resolvePolicyRepoInput`: an absolute checkout registers (strictly when the policy names
/// executors); any other value names a registered repository. Unlike TypeScript, registration
/// takes the `repos` lock, so a lock timeout answers `internal`.
pub fn policy_repo(ctx: &Ctx, value: &str, projects: &Value) -> Result<Value, CoreError> {
    if !Path::new(value).is_absolute() {
        return registered(ctx, value, false);
    }
    let strict = policy_is_strict(projects);
    let mut repo = with_lock(ctx, "repos", LockOptions::default(), || {
        pacer_repos::register_repo(ctx, value, strict)
    })
    .map_err(internal)??;
    repo["path"] = json!(pacer_repos::canonical(value).map_err(internal)?);
    require_policy_identity(&repo, projects)?;
    Ok(repo)
}

/// `resolvePolicyRepoInputReadOnly`: the same repository, recording nothing.
pub fn policy_repo_read_only(ctx: &Ctx, value: &str, projects: &Value) -> Result<Value, CoreError> {
    let repo = if Path::new(value).is_absolute() {
        let strict = policy_is_strict(projects);
        let mut repo = pacer_repos::resolve_repo_read_only(ctx, value, strict)?;
        repo["path"] = json!(pacer_repos::canonical(value).map_err(internal)?);
        repo
    } else {
        registered(ctx, value, true)?
    };
    require_policy_identity(&repo, projects)?;
    Ok(repo)
}
