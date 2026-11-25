//! Cursor installer (`plugins/pacer-planners/cursor.ts:1-75`).

use crate::mcp::{drop_stale_mcp_entry, no_mcp_edit, owned_mcp_entry};
use crate::skill::install_skill;
use crate::types::{join, PlannerBuilder};
use pacer_plugin::install::{
    HookFormat, HookSpec, UndoOp, edit_hooks_file, get_member, remove_member, set_member,
    shell_command,
};
use serde_json::json;

fn is_pacer_mcp_op(op: &UndoOp) -> bool {
    matches!(op, UndoOp::JsonMember { path, .. }
        if path.len() == 2 && path[0] == "mcpServers" && path[1] == "pacer")
}

fn with(argv: &[String], extra: &[&str]) -> Vec<String> {
    let mut out = argv.to_vec();
    out.extend(extra.iter().map(|s| (*s).to_string()));
    out
}

pub async fn install_cursor(tx: &mut PlannerBuilder<'_>) -> Result<(), String> {
    let argv = tx.env().pacer_argv.clone();
    let dir = tx
        .env()
        .folder
        .clone()
        .unwrap_or_else(|| join(&tx.context.home, ".cursor"));
    // `cursor.ts:15`: command is argv[0], args are argv.slice(1) + "mcp".
    let tail: Vec<String> = argv.iter().skip(1).cloned().collect();
    let server = json!({
        "command": argv.first().cloned().unwrap_or_default(),
        "args": with(&tail, &["mcp"]),
    });
    let path = vec!["mcpServers".to_string(), "pacer".to_string()];
    let mcp_path = join(&dir, "mcp.json");

    if tx.env().mcp == Some(false) && tx.read(&mcp_path).await?.is_some() {
        let entry = owned_mcp_entry(tx, &mcp_path, &is_pacer_mcp_op);
        let edit = no_mcp_edit(entry.as_ref(), |old| {
            remove_member(old, &path).map_err(|e| e.0)
        });
        tx.edit(&mcp_path, edit, vec![]).await?;
    }

    if tx.env().mcp == Some(true) {
        let old = tx.read(&mcp_path).await?;
        let empty = old.as_deref().is_none_or(|text| text.trim().is_empty());
        let missing_container = if empty {
            false
        } else {
            get_member(old.as_deref().unwrap_or_default(), &["mcpServers".to_string()])
                .map_err(|e| e.0)?
                .is_none()
        };
        let drop_empty = (empty || missing_container).then(|| vec!["mcpServers".to_string()]);
        let undo = UndoOp::JsonMember {
            path: path.clone(),
            drop_empty,
        };
        let edit_server = server.clone();
        let edit_path = path.clone();
        let edit = move |old: Option<&str>| -> Result<String, String> {
            if empty {
                let fresh = json!({ "mcpServers": { "pacer": edit_server } });
                Ok(format!(
                    "{}\n",
                    serde_json::to_string_pretty(&fresh).map_err(|e| e.to_string())?
                ))
            } else {
                set_member(old.unwrap_or_default(), &edit_path, edit_server).map_err(|e| e.0)
            }
        };
        tx.edit(&mcp_path, edit, vec![undo]).await?;
    }

    let member_present = |text: &str| -> bool {
        get_member(text, &path).map(|value| value.is_some()).unwrap_or(true)
    };
    drop_stale_mcp_entry(tx, &mcp_path, &is_pacer_mcp_op, &member_present).await?;

    install_skill(tx, &dir).await?;

    let specs = vec![
        HookSpec {
            event: "sessionStart".to_string(),
            matcher: None,
            command: shell_command(&with(&argv, &["session-start", "--planner", "cursor"])),
            timeout: Some(15),
            status_message: None,
        },
        HookSpec {
            event: "subagentStart".to_string(),
            matcher: None,
            command: shell_command(&with(&argv, &["guard", "--planner", "cursor"])),
            timeout: Some(15),
            status_message: None,
        },
    ];
    let commands: Vec<String> = specs.iter().map(|spec| spec.command.clone()).collect();
    let hooks = join(&dir, "hooks.json");
    tx.edit(
        &hooks,
        |old| edit_hooks_file(old, HookFormat::Cursor, &specs, "cursor"),
        vec![UndoOp::Hooks {
            format: HookFormat::Cursor,
            commands,
            restore: vec![],
        }],
    )
    .await?;
    tx.notes().push(
        "Cursor has no user rule file; pacer's policy arrives through the sessionStart hook."
            .to_string(),
    );
    Ok(())
}
