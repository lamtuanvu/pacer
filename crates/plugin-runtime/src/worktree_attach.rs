//! Worktree capability attach for flag-on [`crate::ProcessOwner`] (P4d-11).

use pacer_plugin_host::{NativeWorktree, WorktreeResource};
use std::{collections::HashMap, path::Path};

/// Core-sealed home + git pin for ProcessOwner worktree attach.
#[derive(Clone, Debug)]
pub struct WorktreeCallContext {
    pub home: std::path::PathBuf,
    pub provider_id: String,
    pub git: String,
    pub base: String,
    pub env: HashMap<String, String>,
}

pub(crate) struct WorktreeAttachPlan {
    pub grant: WorktreeResource,
    pub context: WorktreeCallContext,
}

pub(crate) async fn issue_worktree(
    plan: &WorktreeAttachPlan,
) -> Result<NativeWorktree, crate::capability::CapabilitySessionError> {
    NativeWorktree::issue(
        &plan.context.home,
        &plan.grant.task_id,
        &plan.context.provider_id,
        plan.grant.attempt,
        &plan.context.base,
        &plan.context.git,
        plan.context.env.clone(),
    )
    .await
    .map_err(|error| crate::capability::CapabilitySessionError::Native(error.to_string()))
}

pub fn worktree_context_from_value(
    value: &serde_json::Value,
) -> Result<Option<WorktreeCallContext>, crate::capability::CapabilitySessionError> {
    let Some(raw) = value.get("worktreeContext") else {
        return Ok(None);
    };
    let home = raw
        .get("home")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            crate::capability::CapabilitySessionError::Malformed("worktreeContext home")
        })?;
    let provider_id = raw
        .get("providerId")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            crate::capability::CapabilitySessionError::Malformed("worktreeContext providerId")
        })?;
    let git = raw
        .get("git")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            crate::capability::CapabilitySessionError::Malformed("worktreeContext git")
        })?;
    let base = raw
        .get("base")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| {
            crate::capability::CapabilitySessionError::Malformed("worktreeContext base")
        })?;
    let mut env = HashMap::new();
    if let Some(object) = raw.get("env").and_then(|v| v.as_object()) {
        for (key, value) in object {
            if let Some(text) = value.as_str() {
                env.insert(key.clone(), text.to_owned());
            }
        }
    }
    Ok(Some(WorktreeCallContext {
        home: Path::new(home).to_path_buf(),
        provider_id: provider_id.to_owned(),
        git: git.to_owned(),
        base: base.to_owned(),
        env,
    }))
}
