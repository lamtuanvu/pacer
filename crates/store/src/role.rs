//! Executor-session identity shared by the native gateways.
//!
//! Ported from `src/install/role.ts` (`isExecutorSession`) and
//! `src/exec/orca/names.ts` (`orcaWorktreeName`). It lives in `pacer-store` so
//! every domain crate can apply the same predicate without depending on
//! `pacer-lifecycle`.
use pacer_foundation::Ctx;
use regex::Regex;
use std::{path::Path, sync::LazyLock};

use crate::is_task_id;

static ORCA_CWD: LazyLock<Option<Regex>> = LazyLock::new(|| {
    Regex::new(r"/orca/workspaces/[^/]+/pacer-(t-[0-9]{8}-[0-9]{6}-[0-9a-f]{4})-([^/]+)(?:/|$)")
        .ok()
});

/// `orcaWorktreeName` from `src/exec/orca/names.ts`.
pub fn orca_worktree_name(name: &str) -> String {
    static STEPS: LazyLock<Option<[Regex; 4]>> = LazyLock::new(|| {
        Some([
            Regex::new(r"[^\p{L}\p{N}._-]+").ok()?,
            Regex::new(r"-+").ok()?,
            Regex::new(r"\.{2,}").ok()?,
            Regex::new(r"^[.-]+|[.-]+$").ok()?,
        ])
    });
    let Some([other, dashes, dots, edges]) = STEPS.as_ref() else {
        return name.to_owned();
    };
    let name = other.replace_all(name, "-");
    let name = dashes.replace_all(&name, "-");
    let name = dots.replace_all(&name, ".");
    edges.replace_all(&name, "").into_owned()
}

/// `isExecutorSession` (`src/install/role.ts:13-24`) for a working directory. `providers` is read
/// only for an Orca workspace path and may return nothing when the strategy cannot load.
pub fn executor_session(ctx: &Ctx, cwd: &Path, providers: impl FnOnce() -> Vec<String>) -> bool {
    if ctx.env.get("PACER_ROLE").map(String::as_str) == Some("executor") {
        return true;
    }
    let cwd = cwd.to_string_lossy();
    let own = format!("{}/", ctx.pacer_home.join("worktrees").display());
    if cwd
        .strip_prefix(&own)
        .and_then(|rest| rest.split('/').nth(1))
        .is_some_and(is_task_id)
    {
        return true;
    }
    let Some(found) = ORCA_CWD.as_ref().and_then(|re| re.captures(&cwd)) else {
        return false;
    };
    let (Some(id), Some(name)) = (found.get(1), found.get(2)) else {
        return false;
    };
    is_task_id(id.as_str())
        && providers()
            .iter()
            .any(|p| orca_worktree_name(p) == name.as_str())
}
