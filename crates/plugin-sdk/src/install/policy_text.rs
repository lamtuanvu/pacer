fn name(planner: &str) -> &str {
    match planner {
        "claude-code" => "Claude Code",
        "codex" => "Codex",
        "cursor" => "Cursor",
        "opencode" => "OpenCode",
        other => other,
    }
}

/// The delegation policy injected into planner instruction files.
pub fn policy_text(planner: &str) -> String {
    let display = name(planner);
    let budget = if planner == "claude-code" || planner == "codex" {
        "The budget block arrives at session start. Read it before choosing work or an executor."
    } else {
        "At the start of every session, run `pacer status --json` and read its budget, mode and executor recommendations."
    };
    let subagents = if planner == "claude-code" {
        "Claude-model subagents (general-purpose, Sonnet, Haiku, …)".to_string()
    } else {
        format!("{display} subagents")
    };
    let enforcement = if planner == "opencode" {
        "Do not use them for execution work unless"
    } else {
        "A hook blocks them for execution work unless"
    };
    format!(
        "This applies only when you are the planner pacer is configured for; if pacer started you as an executor (PACER_ROLE=executor), ignore it.\n\
# pacer delegation policy ({display} is the planner)\n\n\
Your role: plan, decide and review; delegate execution.\n\n\
{budget}\n\n\
## Modes\n\n\
| Mode | How to work |\n\
| --- | --- |\n\
| strict/emergency | Delegate execution to available executors; reserve planner budget for decisions and review. |\n\
| normal | Delegate substantial execution work; keep planning and review with the planner. |\n\
| relaxed | You may execute directly or delegate when useful. |\n\n\
## Delegation workflow\n\n\
Use the installed `pacer` skill for CLI routing, brief files, waiting and review.\n\
Run `pacer route <kind> --json`, then `pacer delegate --brief-file <path|-> --json`.\n\
Review the diff and run acceptance before `pacer review <id> --accept|--reject`. Use `pacer msg send <id> \"…\"` for follow-ups; it continues the same agent and worktree.\n\n\
## Subagents\n\n\
**{subagents} count as you doing the work**.\n\
{enforcement} the mode is `relaxed`, no executor is available, or `PACER=off`. Read-only helpers and reviewers stay allowed.\n\n\
## Review and completion\n\n\
Review each delegated result and verify before reporting done. Check the changes and run the acceptance command; then run `pacer review <id> --accept|--reject [--kind <k>]` to record your verdict and any corrected kind tag.\n\n\
When a human decision is needed, use `pacer task request-review <id> --note \"<specific concern>\"` (or MCP task_request_review) instead of recording a verdict you have not reached. Successful execution alone never means acceptance. A completed run without a verdict stays in history and does not require a second human acknowledgment.\n\n\
Escape hatch: set `PACER=off` to disable pacing and delegation enforcement for the session.\n"
    )
}
