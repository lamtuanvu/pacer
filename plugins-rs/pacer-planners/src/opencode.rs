//! OpenCode installer (`plugins/pacer-planners/opencode.ts:1-67`).

use crate::mcp::{drop_stale_mcp_entry, no_mcp_edit, owned_mcp_entry};
use crate::skill::install_skill;
use crate::types::{join, PlannerBuilder};
use pacer_plugin::install::{
    BlockStyle, UndoOp, get_member, policy_text, remove_member, set_member, upsert_block,
};
use serde_json::json;

fn is_pacer_mcp_op(op: &UndoOp) -> bool {
    matches!(op, UndoOp::JsonMember { path, .. }
        if path.len() == 2 && path[0] == "mcp" && path[1] == "pacer")
}

pub async fn install_opencode_files(tx: &mut PlannerBuilder<'_>) -> Result<(), String> {
    let dir = tx
        .env()
        .folder
        .clone()
        .unwrap_or_else(|| join(&tx.context.home, ".config/opencode"));
    let jsonc = join(&dir, "opencode.jsonc");
    let config_path = if tx.read(&jsonc).await?.is_some() {
        jsonc
    } else {
        join(&dir, "opencode.json")
    };

    let agents = join(&dir, "AGENTS.md");
    tx.edit(
        &agents,
        |old| Ok(upsert_block(old.unwrap_or_default(), &policy_text("opencode"), BlockStyle::Md)?),
        vec![UndoOp::Block { style: BlockStyle::Md, restore: None }],
    )
    .await?;
    install_skill(tx, &dir).await?;

    let argv = &tx.env().pacer_argv;
    let mut command = argv.clone();
    command.push("mcp".to_string());
    let pacer = json!({ "type": "local", "command": command, "enabled": true });
    let path = vec!["mcp".to_string(), "pacer".to_string()];

    if tx.env().mcp == Some(false) && tx.read(&config_path).await?.is_some() {
        let entry = owned_mcp_entry(tx, &config_path, &is_pacer_mcp_op);
        let edit = no_mcp_edit(entry.as_ref(), |old| remove_member(old, &path).map_err(|e| e.0));
        tx.edit(&config_path, edit, vec![]).await?;
    }

    if tx.env().mcp == Some(true) {
        let old = tx.read(&config_path).await?;
        let empty = old.as_deref().is_none_or(|text| text.trim().is_empty());
        let missing_container = if empty {
            false
        } else {
            get_member(old.as_deref().unwrap_or_default(), &["mcp".to_string()])
                .map_err(|e| e.0)?
                .is_none()
        };
        let drop_empty = (empty || missing_container).then(|| vec!["mcp".to_string()]);
        let undo = UndoOp::JsonMember {
            path: path.clone(),
            drop_empty,
        };
        let edit_pacer = pacer.clone();
        let edit_path = path.clone();
        let edit = move |old: Option<&str>| -> Result<String, String> {
            if empty {
                let fresh = json!({
                    "$schema": "https://opencode.ai/config.json",
                    "mcp": { "pacer": edit_pacer },
                });
                Ok(format!(
                    "{}\n",
                    serde_json::to_string_pretty(&fresh).map_err(|e| e.to_string())?
                ))
            } else {
                set_member(old.unwrap_or_default(), &edit_path, edit_pacer).map_err(|e| e.0)
            }
        };
        tx.edit(&config_path, edit, vec![undo]).await?;
    }

    tx.notes().push(
        "OpenCode guard is policy-only; policy and skill installed; MCP is optional.".to_string(),
    );

    let member_present = |text: &str| -> bool {
        get_member(text, &path).map(|value| value.is_some()).unwrap_or(true)
    };
    drop_stale_mcp_entry(tx, &config_path, &is_pacer_mcp_op, &member_present).await?;
    Ok(())
}
