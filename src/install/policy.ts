const NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

export function policyText(planner: string): string {
  const name = NAMES[planner] ?? planner;
  const budget = planner === "claude-code" || planner === "codex"
    ? "The budget block arrives at session start. Read it before choosing work or an executor."
    : "At the start of every session, call the pacer MCP tool `budget_status` and read its budget, mode and executor recommendations.";
  const subagents = planner === "claude-code"
    ? "Claude-model subagents (general-purpose, Sonnet, Haiku, …)"
    : `${name} subagents`;
  const enforcement = planner === "opencode"
    ? "Do not use them for execution work unless"
    : "A hook blocks them for execution work unless";

  return `This applies only when you are the planner pacer is configured for; if pacer started you as an executor (PACER_ROLE=executor), ignore it.
# pacer delegation policy (${name} is the planner)

Your role: plan, decide and review; delegate execution.

${budget}

## Modes

| Mode | How to work |
| --- | --- |
| strict/emergency | Delegate execution to available executors; reserve planner budget for decisions and review. |
| normal | Delegate substantial execution work; keep planning and review with the planner. |
| relaxed | You may execute directly or delegate when useful. |

## Delegation workflow

Use the pacer MCP tool \`route\` with a kind tag to choose an available executor, then \`delegate\` to start the task.
Give each task a brief with goal, repo (absolute path), scope, acceptance (a verification command), and constraints/context. Include a kind tag alongside the brief.
Use \`task_wait\` to wait for a result, \`task_status\` to inspect progress, and \`task_stop\` to stop a task when needed.
Choose \`worktree: current\` for uncommitted work, read-only research/review, installed dependencies/build output, or a small follow-up there.
Choose \`worktree: new\` when another task or the user is editing there, for parallel tasks on the same repo, or exploratory/risky work.
Give a one-line \`worktree_reason\`; omit the choice to let pacer decide (auto).
If an executor hits a provider limit, use \`report_limit\` so subsequent routing can account for it.

## Subagents

**${subagents} count as you doing the work**.
${enforcement} the mode is \`relaxed\`, no executor is available, or \`PACER=off\`. Read-only helpers and reviewers stay allowed.

## Review and completion

Review each delegated result and verify before reporting done. Check the changes and run the acceptance command; then call \`task_review(task_id, accepted, kind?)\` to record your verdict and any corrected kind tag.

Escape hatch: set \`PACER=off\` to disable pacing and delegation enforcement for the session.
`;
}
