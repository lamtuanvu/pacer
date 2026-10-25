const NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};

export function policyText(planner: string): string {
  const name = NAMES[planner] ?? planner;
  const budget =
    planner === "claude-code" || planner === "codex"
      ? "The budget block arrives at session start. Read it before choosing work or an executor."
      : "At the start of every session, run `pacer status --json` and read its budget, mode and executor recommendations.";
  const subagents =
    planner === "claude-code"
      ? "Claude-model subagents (general-purpose, Sonnet, Haiku, …)"
      : `${name} subagents`;
  const enforcement =
    planner === "opencode"
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

Use the installed \`pacer\` skill for CLI routing, brief files, waiting and review.
Run \`pacer route <kind> --json\`, then \`pacer delegate --brief-file <path|-> --json\`.
Review the diff and run acceptance before \`pacer review <id> --accept|--reject\`.

## Subagents

**${subagents} count as you doing the work**.
${enforcement} the mode is \`relaxed\`, no executor is available, or \`PACER=off\`. Read-only helpers and reviewers stay allowed.

## Review and completion

Review each delegated result and verify before reporting done. Check the changes and run the acceptance command; then run \`pacer review <id> --accept|--reject [--kind <k>]\` to record your verdict and any corrected kind tag.

When a human decision is needed, use \`pacer task request-review <id> --note "<specific concern>"\` (or MCP task_request_review) instead of recording a verdict you have not reached. Successful execution alone never means acceptance. A completed run without a verdict stays in history and does not require a second human acknowledgment.

Escape hatch: set \`PACER=off\` to disable pacing and delegation enforcement for the session.
`;
}
