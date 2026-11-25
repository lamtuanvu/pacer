//! Codex installer (`plugins/pacer-planners/codex.ts:1-126`).

use crate::mcp::{drop_stale_mcp_entry, no_mcp_edit, owned_mcp_entry};
use crate::skill::install_skill;
use crate::types::{join, PlannerBuilder};
use pacer_plugin::install::{
    BlockStyle, HookFormat, HookSpec, UndoOp, edit_hooks_file, policy_text,
    remove_block, remove_toml_table, shell_command, upsert_block,
};
use regex::Regex;
use std::sync::OnceLock;

const PACER_TABLE: &str = "mcp_servers.pacer";

fn is_codex_mcp_op(op: &UndoOp) -> bool {
    matches!(op, UndoOp::TomlTable { table } if table == PACER_TABLE)
        || matches!(op, UndoOp::Block { style: BlockStyle::Hash, .. })
}

fn mcp_table_re() -> &'static Regex {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| {
        Regex::new(r#"(?m)^\[mcp_servers\.("pacer"|pacer)\]"#)
            .unwrap_or_else(|error| panic!("invalid mcp table regex: {error}"))
    })
}

fn has_mcp_table(text: &str) -> Result<bool, String> {
    let stripped = remove_block(text, BlockStyle::Hash)?;
    Ok(mcp_table_re().is_match(&stripped))
}

/// `codexMcpBlock` (`codex.ts:18-21`) — TOML registration with the exact text.
pub fn codex_mcp_block(argv: &[String]) -> String {
    let command = argv.first().cloned().unwrap_or_default();
    let mut args: Vec<String> = argv.iter().skip(1).cloned().collect();
    args.push("mcp".to_string());
    format!(
        "[mcp_servers.pacer]\ncommand = {}\nargs = {}\n",
        serde_json::to_string(&command).unwrap_or_default(),
        serde_json::to_string(&args).unwrap_or_default(),
    )
}

fn with(argv: &[String], extra: &[&str]) -> Vec<String> {
    let mut out = argv.to_vec();
    out.extend(extra.iter().map(|s| (*s).to_string()));
    out
}

pub async fn install_codex(tx: &mut PlannerBuilder<'_>) -> Result<(), String> {
    let dir = tx
        .env()
        .folder
        .clone()
        .unwrap_or_else(|| join(&tx.context.home, ".codex"));
    let argv = tx.env().pacer_argv.clone();
    let config_path = join(&dir, "config.toml");

    let owns_table = tx.record().files.iter().any(|file| {
        file.path == config_path
            && file.undo.iter().any(|op| matches!(op, UndoOp::TomlTable { table } if table == PACER_TABLE))
    });

    if tx.env().mcp == Some(false) && tx.read(&config_path).await?.is_some() {
        let entry = owned_mcp_entry(tx, &config_path, &is_codex_mcp_op);
        let edit = no_mcp_edit(entry.as_ref(), |old| {
            let stripped = remove_block(old, BlockStyle::Hash)?;
            Ok(remove_toml_table(&stripped, PACER_TABLE))
        });
        tx.edit(&config_path, edit, vec![]).await?;
    }

    if tx.env().mcp == Some(true) {
        // `codex.ts:52-65` pushes a note from inside the edit callback when a
        // user-defined table already exists. Compute it before the edit so the
        // note order in the record is preserved.
        let existing = tx.read(&config_path).await?;
        let note = existing
            .as_deref()
            .is_some_and(|old| has_mcp_table(old).unwrap_or(false))
            && !owns_table;
        let edit_argv = argv.clone();
        let edit = move |old: Option<&str>| -> Result<String, String> {
            let text = old.unwrap_or_default().to_string();
            if has_mcp_table(&text)? {
                if owns_table {
                    let without = remove_toml_table(&remove_block(&text, BlockStyle::Hash)?, PACER_TABLE);
                    Ok(upsert_block(&without, &codex_mcp_block(&edit_argv), BlockStyle::Hash)?)
                } else {
                    Ok(text)
                }
            } else {
                Ok(upsert_block(&text, &codex_mcp_block(&edit_argv), BlockStyle::Hash)?)
            }
        };
        tx.edit(
            &config_path,
            edit,
            vec![
                UndoOp::Block { style: BlockStyle::Hash, restore: None },
                UndoOp::TomlTable { table: PACER_TABLE.to_string() },
            ],
        )
        .await?;
        if note {
            tx.notes().push("already defines [mcp_servers.pacer]; left it unchanged".to_string());
        }
    }

    let member_present = |text: &str| -> bool {
        match text.parse::<toml::Value>() {
            Ok(value) => value.get("mcp_servers").and_then(|m| m.get("pacer")).is_some(),
            Err(_) => true,
        }
    };
    drop_stale_mcp_entry(tx, &config_path, &is_codex_mcp_op, &member_present).await?;

    let skill_dir = tx.env().skill_folder.clone().unwrap_or_else(|| {
        let base = tx.env().folder.clone().unwrap_or_else(|| {
            tx.context
                .env
                .get("CODEX_HOME")
                .cloned()
                .unwrap_or_else(|| dir.clone())
        });
        base
    });
    install_skill(tx, &skill_dir).await?;

    let agents = join(&dir, "AGENTS.md");
    tx.edit(
        &agents,
        |old| Ok(upsert_block(old.unwrap_or_default(), &policy_text("codex"), BlockStyle::Md)?),
        vec![UndoOp::Block { style: BlockStyle::Md, restore: None }],
    )
    .await?;

    let specs = vec![
        HookSpec {
            event: "SessionStart".to_string(),
            matcher: None,
            command: shell_command(&with(&argv, &["status", "--hook", "codex"])),
            timeout: Some(15),
            status_message: Some("Checking subscription budgets".to_string()),
        },
        HookSpec {
            event: "PreToolUse".to_string(),
            matcher: Some("spawn_agent".to_string()),
            command: shell_command(&with(&argv, &["guard", "--planner", "codex"])),
            timeout: Some(15),
            status_message: None,
        },
        HookSpec {
            event: "Stop".to_string(),
            matcher: None,
            command: shell_command(&with(&argv, &["msg", "hook", "stop", "--planner", "codex"])),
            timeout: Some(10),
            status_message: None,
        },
        HookSpec {
            event: "UserPromptSubmit".to_string(),
            matcher: None,
            command: shell_command(&with(&argv, &["msg", "hook", "prompt", "--planner", "codex"])),
            timeout: Some(10),
            status_message: None,
        },
    ];
    let commands: Vec<String> = specs.iter().map(|spec| spec.command.clone()).collect();
    let hooks = join(&dir, "hooks.json");
    tx.edit(
        &hooks,
        |old| edit_hooks_file(old, HookFormat::Claude, &specs, "codex"),
        vec![UndoOp::Hooks {
            format: HookFormat::Claude,
            commands,
            restore: vec![],
        }],
    )
    .await?;
    tx.notes().push(
        "Codex may ask you to review and trust the new pacer hooks the next time it starts."
            .to_string(),
    );
    Ok(())
}
