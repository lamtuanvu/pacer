//! Stale MCP entry cleanup (`plugins/pacer-planners/mcp.ts:1-64`).

use crate::types::PlannerBuilder;
use pacer_plugin::install::{FileChange, UndoOp, apply_undo};

type IsMcpOp<'a> = &'a (dyn Fn(&UndoOp) -> bool + Send + Sync);

/// The prior record entry whose only managed content is this config's pacer
/// MCP member/table (`mcp.ts:13-17`).
pub fn owned_mcp_entry(
    tx: &PlannerBuilder<'_>,
    config_path: &str,
    is_mcp_op: IsMcpOp<'_>,
) -> Option<FileChange> {
    tx.record().files.iter().find(|file| {
        file.path == config_path
            && !file.undo.is_empty()
            && file.undo.iter().all(|op| is_mcp_op(op))
    }).cloned()
}

/// The edit an explicit `--no-mcp` applies to the config (`mcp.ts:26-30`). When
/// the prior record entry owns the registration, that is exactly the entry's
/// own undo (honouring `dropEmpty`); otherwise a bare member/table removal.
pub fn no_mcp_edit<F>(
    entry: Option<&FileChange>,
    bare: F,
) -> impl FnOnce(Option<&str>) -> Result<String, String>
where
    F: FnOnce(&str) -> Result<String, String>,
{
    let entry = entry.cloned();
    move |old| match &entry {
        Some(item) => apply_undo(old.unwrap_or_default(), &item.undo, &mut Vec::new()),
        None => bare(old.unwrap_or_default()),
    }
}

/// A planner install or reconnect without MCP must not keep a prior record
/// entry whose only managed content was this planner's MCP member/table
/// (`mcp.ts:43-64`). Unrelated user content is never touched.
pub async fn drop_stale_mcp_entry(
    tx: &mut PlannerBuilder<'_>,
    config_path: &str,
    is_mcp_op: IsMcpOp<'_>,
    member_present: &(dyn Fn(&str) -> bool + Send + Sync),
) -> Result<(), String> {
    if tx.env().mcp == Some(true) || tx.record().mcp == Some(true) {
        return Ok(());
    }
    let Some(entry) = owned_mcp_entry(tx, config_path, is_mcp_op) else {
        return Ok(());
    };
    let text = tx.read(config_path).await?;
    let present = text
        .as_deref()
        .map(|text| member_present(text))
        .unwrap_or(false);
    // No flag and the registration is live: keep the entry and the file.
    if present && tx.env().mcp != Some(false) {
        return Ok(());
    }
    if present {
        let undo = entry.undo.clone();
        tx.edit(
            config_path,
            |old| apply_undo(old.unwrap_or_default(), &undo, &mut Vec::new()),
            vec![],
        )
        .await?;
        tx.notes()
            .push(format!("removed the pacer MCP registration from {config_path}"));
    }
    if let Some(index) = tx
        .record()
        .files
        .iter()
        .position(|file| file.path == config_path)
    {
        tx.record_mut().files.remove(index);
    }
    Ok(())
}
