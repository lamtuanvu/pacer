//! Claude Code installer (`plugins/pacer-planners/claude.ts:1-334`).

use crate::skill::install_skill;
use crate::types::{join, PlannerBuilder};
use pacer_plugin::install::{
    BlockStyle, HookFormat, HookSpec, PlanIo, PlannerCommandResult,
    RestoreBlock, RunOptions, UndoOp, block_text, has_block, parse_jsonc, policy_text,
    remove_hooks, shell_command, upsert_block, upsert_hooks,
};
use regex::Regex;
use serde_json::{Value, json};
use std::future::Future;
use std::path::Path;

const LEGACY_PERSIST: &str =
    r"(?m)^# Persist Claude's rate-limit windows for ~/\.claude/scripts/budget/budget-status[^\n]*\n";
const LEGACY_L4: &str = r"(?m)^# L4: cross-subscription pacing[^\n]*\n";

fn rx(pattern: &str) -> Regex {
    Regex::new(pattern).unwrap_or_else(|error| panic!("invalid claude regex: {error}"))
}

fn static_rx(pattern: &str) -> Regex {
    // Layout patterns are short and compiled only on the task-start path.
    rx(pattern)
}

pub struct ClaudeCommands {
    pub session: String,
    pub guard: String,
    pub stop: Option<String>,
    pub prompt: Option<String>,
    pub statusline: String,
}

pub struct ClaudeSettingsEdit {
    pub text: String,
    pub undo: Vec<UndoOp>,
    pub script_path: Option<String>,
    pub needs_pipe: bool,
}

/// `resolveScript` (`claude.ts:16-20`).
pub fn resolve_script(command: &str, home: &str) -> Option<String> {
    if command.is_empty() || rx(r"\s").is_match(command) {
        return None;
    }
    let path = rx(r"^~(?=/)").replace(command, home);
    let path = rx(r"^\$HOME(?=/)").replace(&path, home);
    if Path::new(path.as_ref()).is_absolute() {
        Some(path.into_owned())
    } else {
        None
    }
}

/// `claudeLegacyFiles` (`claude.ts:21-30`).
pub async fn claude_legacy_files(tx: &mut PlannerBuilder<'_>) -> Result<Vec<String>, String> {
    let root = tx
        .env()
        .folder
        .clone()
        .unwrap_or_else(|| join(&tx.context.home, ".claude"));
    let mut files: Vec<String> = ["budget_status.py", "subagent_guard.py", "budget-status"]
        .iter()
        .map(|name| join(&root, &format!("scripts/budget/{name}")))
        .collect();
    files.push(join(&root, "rules/model-delegation.md"));
    let list = (tx.context.list)(
        join(&root, "agents/delegation"),
        "*.md".to_string(),
    )
    .await?;
    let mut list = list;
    list.sort();
    files.extend(list);
    Ok(files)
}

fn split_lines_keep(text: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, _) in text.match_indices('\n') {
        out.push(&text[start..=i]);
        start = i + 1;
    }
    if start < text.len() {
        out.push(&text[start..]);
    }
    out
}

fn last_line_with_newline(text: &str) -> Option<String> {
    if !text.ends_with('\n') {
        return None;
    }
    let start = text[..text.len() - 1].rfind('\n').map_or(0, |i| i + 1);
    Some(text[start..].to_string())
}

/// `legacyBlock` (`claude.ts:32-46`): a block that ends at the next column-zero
/// `fi`, leaving surrounding shell intact.
fn legacy_block(text: &str, anchor: &Regex) -> Option<(usize, usize)> {
    let m = anchor.find(text)?;
    let rest = &text[m.end()..];
    let end = static_rx(r"(?m)^fi[\t ]*(?:\r?\n|$)").find(rest)?;
    Some((m.start(), m.end() + end.end()))
}

/// `statuslineUndo` (`claude.ts:48-81`).
fn statusline_undo(text: &str) -> Result<UndoOp, String> {
    let mut restore: Vec<RestoreBlock> = Vec::new();
    if !has_block(text, BlockStyle::Hash)? {
        for pattern in [LEGACY_PERSIST, LEGACY_L4] {
            let Some((start, end)) = legacy_block(text, &rx(pattern)) else {
                continue;
            };
            let before = &text[..start];
            let mut lines = split_lines_keep(before);
            let mut spacing = String::new();
            while lines.last().is_some_and(|last| last.trim().is_empty()) {
                let last = lines.pop().unwrap_or_default();
                spacing = format!("{last}{spacing}");
            }
            let anchor = last_line_with_newline(&before[..before.len() - spacing.len()]);
            restore.push(RestoreBlock {
                text: text[start..end].to_string(),
                anchor,
                spacing: Some(spacing),
                at_marker: Some(text[start..].starts_with("# L4:")),
            });
        }
    }
    restore.sort_by_key(|item| text.find(&item.text).unwrap_or(usize::MAX));
    Ok(UndoOp::Block {
        style: BlockStyle::Hash,
        restore: Some(restore),
    })
}

/// `editStatuslineScript` (`claude.ts:83-102`). `None` means the script is not
/// a pacer status-line script and cannot be edited.
pub fn edit_statusline_script(text: &str, command: &str) -> Result<Option<String>, String> {
    if !static_rx(r"(?m)^input=\$\(cat\)\s*$").is_match(text) {
        return Ok(None);
    }
    let body = format!("printf '%s' \"$input\" | {command} statusline 2>/dev/null");
    if has_block(text, BlockStyle::Hash)? {
        return Ok(Some(upsert_block(text, &body, BlockStyle::Hash)?));
    }
    let mut work = text.to_string();
    if let Some((start, end)) = legacy_block(text, &rx(LEGACY_PERSIST)) {
        work = format!("{}{}", &text[..start], &text[end..]);
    }
    let block = block_text(&body, BlockStyle::Hash);
    if let Some((start, end)) = legacy_block(&work, &rx(LEGACY_L4)) {
        return Ok(Some(format!("{}{}{}", &work[..start], block, &work[end..])));
    }
    if let Some(m) = static_rx(r"\nexit 0\s*$").find(&work) {
        return Ok(Some(format!(
            "{}\n{}{}",
            &work[..m.start()],
            block,
            &work[m.start()..]
        )));
    }
    Ok(Some(upsert_block(&work, &body, BlockStyle::Hash)?))
}

fn is_pacer_status(command: &str) -> bool {
    static_rx(r"(?:pacer|cli\.(?:ts|js))").is_match(command) && static_rx(r"\sstatusline$").is_match(command)
}

/// `editClaudeSettings` (`claude.ts:105-184`).
pub fn edit_claude_settings(
    old: Option<&str>,
    cmds: &ClaudeCommands,
    home: &str,
    automatic: bool,
) -> Result<ClaudeSettingsEdit, String> {
    let original = match old {
        Some(text) if !text.trim().is_empty() => parse_jsonc(text).map_err(|e| e.0)?,
        _ => json!({}),
    };
    let (doc, removed) = remove_hooks(&original, HookFormat::Claude, &|command: &str| {
        !automatic && command.contains("/.claude/scripts/budget/")
    });
    let mut specs = vec![
        HookSpec {
            event: "SessionStart".to_string(),
            matcher: None,
            command: cmds.session.clone(),
            timeout: Some(15),
            status_message: Some("Checking subscription budgets".to_string()),
        },
        HookSpec {
            event: "PreToolUse".to_string(),
            matcher: Some("Agent|Task|Bash".to_string()),
            command: cmds.guard.clone(),
            timeout: Some(15),
            status_message: None,
        },
    ];
    if let Some(stop) = &cmds.stop {
        specs.push(HookSpec {
            event: "Stop".to_string(),
            matcher: None,
            command: stop.clone(),
            timeout: Some(10),
            status_message: None,
        });
    }
    if let Some(prompt) = &cmds.prompt {
        specs.push(HookSpec {
            event: "UserPromptSubmit".to_string(),
            matcher: None,
            command: prompt.clone(),
            timeout: Some(10),
            status_message: None,
        });
    }
    let mut next = upsert_hooks(&doc, HookFormat::Claude, &specs, "claude-code");
    let created_status_line = next.get("statusLine").is_none();
    let mut script_path: Option<String> = None;
    let mut needs_pipe = false;
    if created_status_line {
        if let Some(map) = next.as_object_mut() {
            map.insert(
                "statusLine".to_string(),
                json!({ "type": "command", "command": cmds.statusline }),
            );
        }
    } else {
        let command = next
            .get("statusLine")
            .and_then(|value| value.get("command"))
            .and_then(Value::as_str)
            .map(str::to_string);
        if command.as_deref().is_some_and(is_pacer_status) {
            if let Some(map) = next
                .as_object_mut()
                .and_then(|map| map.get_mut("statusLine"))
                .and_then(Value::as_object_mut)
            {
                map.insert("command".to_string(), Value::String(cmds.statusline.clone()));
            }
        } else {
            script_path = command.as_deref().and_then(|command| resolve_script(command, home));
            needs_pipe = script_path.is_none();
        }
    }
    let text = match old {
        Some(text) if original == next => text.to_string(),
        _ => format!(
            "{}\n",
            serde_json::to_string_pretty(&next).map_err(|error| error.to_string())?
        ),
    };
    let mut commands: Vec<String> = vec![cmds.session.clone(), cmds.guard.clone()];
    if let Some(stop) = &cmds.stop {
        commands.push(stop.clone());
    }
    if let Some(prompt) = &cmds.prompt {
        commands.push(prompt.clone());
    }
    let mut undo = vec![UndoOp::Hooks {
        format: HookFormat::Claude,
        commands,
        restore: removed,
    }];
    if created_status_line {
        undo.push(UndoOp::JsonKey {
            key: "statusLine".to_string(),
        });
    }
    Ok(ClaudeSettingsEdit {
        text,
        undo,
        script_path,
        needs_pipe,
    })
}

/// Shared note logic for `removeClaudeMcp` (`claude.ts:277-302`).
fn mcp_remove_notes(
    registered: bool,
    result: &Result<PlannerCommandResult, String>,
    argv: &[String],
    notes: &mut Vec<String>,
) -> bool {
    match result {
        Ok(result) => {
            if !registered {
                notes.push("MCP server pacer was not registered".to_string());
            }
            if result.code != 0 && registered {
                let stream = if !result.stderr.is_empty() {
                    &result.stderr
                } else {
                    &result.stdout
                };
                let first_line = stream.lines().next().unwrap_or_default();
                notes.push(format!(
                    "`{}` failed (exit {}): {}",
                    shell_command(argv),
                    result.code,
                    first_line
                ));
            } else if result.code == 0 && registered {
                notes.push(format!("removed MCP server pacer ({})", shell_command(argv)));
            }
            result.code == 0
        }
        Err(error) => {
            notes.push(format!("`{}` failed: {}", shell_command(argv), error));
            false
        }
    }
}

/// `removeClaudeMcp` over an arbitrary `runRaw` (used by the uninstall handler).
pub async fn remove_claude_mcp<F, Fut>(
    mut run_raw: F,
    notes: &mut Vec<String>,
    argv: &[String],
) -> Result<bool, String>
where
    F: FnMut(Vec<String>) -> Fut,
    Fut: Future<Output = Result<PlannerCommandResult, String>>,
{
    let get = vec![argv[0].clone(), "mcp".to_string(), "get".to_string(), "pacer".to_string()];
    let registered = run_raw(get).await.is_ok_and(|result| result.code == 0);
    let result = run_raw(argv.to_vec()).await;
    Ok(mcp_remove_notes(registered, &result, argv, notes))
}

/// `removeClaudeMcp` over the transaction builder (used by `installClaude`).
async fn remove_claude_mcp_tx(tx: &mut PlannerBuilder<'_>, argv: &[String]) -> Result<bool, String> {
    let get = vec![argv[0].clone(), "mcp".to_string(), "get".to_string(), "pacer".to_string()];
    let registered = tx
        .run_raw(&get, None)
        .await
        .is_ok_and(|result| result.code == 0);
    let result = tx.run_raw(argv, None).await;
    let mut notes = Vec::new();
    let removed = mcp_remove_notes(registered, &result, argv, &mut notes);
    tx.notes().extend(notes);
    Ok(removed)
}

fn with(argv: &[String], extra: &[&str]) -> Vec<String> {
    let mut out = argv.to_vec();
    out.extend(extra.iter().map(|s| (*s).to_string()));
    out
}

/// `installClaude` (`claude.ts:186-275`).
pub async fn install_claude(tx: &mut PlannerBuilder<'_>) -> Result<(), String> {
    let pacer_argv = tx.env().pacer_argv.clone();
    let command = shell_command(&pacer_argv);
    let claude = tx.context.binary.clone();
    let mcp = tx.env().mcp;
    let reconcile = tx.env().mode.as_deref() == Some("reconcile");

    if claude.is_some() && mcp == Some(true) {
        let cli = claude.clone().unwrap_or_default();
        let remove = vec![cli.clone(), "mcp".into(), "remove".into(), "-s".into(), "user".into(), "pacer".into()];
        tx.run(&remove, None, RunOptions { quiet: Some(true), success_note: None })
            .await?;
        let add = with(&remove[..1].to_vec(), &["mcp", "add", "-s", "user", "pacer", "--"]);
        let mut add = add;
        add.extend(pacer_argv.clone());
        add.push("mcp".to_string());
        let note = format!("registered MCP server pacer ({})", shell_command(&add));
        tx.run(&add, Some(&remove), RunOptions { quiet: None, success_note: Some(note) })
            .await?;
    } else if mcp == Some(true) {
        tx.notes().push(format!(
            "claude CLI not found: register the MCP server yourself with `claude mcp add -s user pacer -- {command} mcp`"
        ));
    }
    if mcp == Some(false) && !reconcile {
        if let Some(cli) = &claude {
            let argv = vec![cli.clone(), "mcp".into(), "remove".into(), "-s".into(), "user".into(), "pacer".into()];
            remove_claude_mcp_tx(tx, &argv).await?;
        } else {
            tx.notes().push(
                "claude CLI not found: remove the MCP server yourself with `claude mcp remove -s user pacer`"
                    .to_string(),
            );
        }
    }

    if !reconcile {
        for path in claude_legacy_files(tx).await? {
            if tx.read(&path).await?.is_some() {
                tx.move_aside(&path).await?;
            }
        }
    }

    let root = tx
        .env()
        .folder
        .clone()
        .unwrap_or_else(|| join(&tx.context.home, ".claude"));
    install_skill(tx, &root).await?;
    let rules = join(&root, "rules/pacer.md");
    tx.edit(&rules, |_| Ok(policy_text("claude-code")), vec![]).await?;

    let settings_path = join(&root, "settings.json");
    let commands = ClaudeCommands {
        session: format!("{command} msg hook session --planner claude-code"),
        stop: Some(format!("{command} msg hook stop --planner claude-code")),
        prompt: Some(format!("{command} msg hook prompt --planner claude-code")),
        guard: format!("{command} guard --planner claude-code"),
        statusline: format!("{command} statusline"),
    };
    let settings = edit_claude_settings(
        tx.read(&settings_path).await?.as_deref(),
        &commands,
        &tx.context.home,
        reconcile,
    )
    .map_err(|error| format!("cannot update {settings_path}: {error}"))?;
    tx.edit(
        &settings_path,
        |_| Ok(settings.text.clone()),
        settings.undo.clone(),
    )
    .await?;

    let mut needs_pipe = settings.needs_pipe;
    if let Some(script_path) = &settings.script_path
        && (!reconcile
            || tx.record().files.iter().any(|file| &file.path == script_path))
    {
        let old = tx.read(script_path).await?;
        let next = match old.as_deref() {
            Some(text) => edit_statusline_script(text, &command)?,
            None => None,
        };
        match next {
            Some(next) => {
                let undo = statusline_undo(old.as_deref().unwrap_or_default())?;
                tx.edit(script_path, move |_| Ok(next.clone()), vec![undo]).await?;
            }
            None => needs_pipe = true,
        }
    }
    if needs_pipe {
        tx.notes().push(format!(
            "Pipe your status-line JSON to `{command} statusline` to include pacer budgets."
        ));
    }
    Ok(())
}

/// `claudePreview` (`claude.ts:305-334`).
pub async fn claude_preview(io: &PlanIo, home: &str, root: &str) -> Result<String, String> {
    let old = io.read(&join(root, "settings.json")).await?;
    let settings = match old.as_ref().map(|image| image.text.as_str()) {
        Some(text) if !text.trim().is_empty() => match parse_jsonc(text) {
            Ok(value) => value,
            Err(_) => {
                return Ok(
                    "settings.json: cannot preview malformed settings; repair it before connecting"
                        .to_string(),
                )
            }
        },
        _ => json!({}),
    };
    if settings.get("statusLine").is_none() {
        return Ok("settings.json: SessionStart + PreToolUse hooks, and the status line (pacer statusline) because none is set".to_string());
    }
    let command = settings
        .get("statusLine")
        .and_then(|value| value.get("command"))
        .and_then(Value::as_str);
    if command.is_some_and(is_pacer_status) {
        return Ok("settings.json: SessionStart + PreToolUse hooks; refresh the existing pacer status line".to_string());
    }
    let path = command.and_then(|command| resolve_script(command, home));
    let script = match &path {
        Some(path) => io.read(path).await?.map(|image| image.text).unwrap_or_default(),
        None => String::new(),
    };
    if path.is_some() && edit_statusline_script(&script, "pacer")?.is_some() {
        return Ok("settings.json: SessionStart + PreToolUse hooks; existing status line will be left alone. Its script will also pipe the input JSON to pacer statusline.".to_string());
    }
    Ok("settings.json: SessionStart + PreToolUse hooks; existing status line will be left alone. Pipe its input JSON to pacer statusline to include pacer budgets.".to_string())
}
