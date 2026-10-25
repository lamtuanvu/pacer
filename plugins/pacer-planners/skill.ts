import { join } from "node:path";
import type { PlannerBuilder } from "./types";

export const PACER_SKILL = `---
name: pacer
description: Route and delegate work by subscription budget, answer budget and pace questions, and wait on or review delegated tasks.
---

# pacer

Use the pacer CLI as the primary interface; MCP is an optional adapter.
Executors (PACER_ROLE=executor) must complete their assigned task directly and must not delegate.

1. Run \`pacer status --json\` and read the planner mode and budget.
2. Run \`pacer route <kind> --json\` to choose an available executor.
3. Write a brief JSON file, then run \`pacer delegate --brief-file brief.json --json\`.
   To avoid shell quoting, pipe the JSON to \`pacer delegate --brief-file - --json\`.
4. Use the returned \`id\` with \`pacer watch <id> --json\` to stream output and state changes until settled.
   It emits one JSON event per line (default timeout 600 seconds, max 3000). Exit 0 means settled,
   not necessarily successful; inspect the final state. Exit 2 means timeout or error; check the final event.
   Watch again after a timeout; Ctrl-C stops watching without stopping the task.
   Use \`pacer wait <id> --json\` for completion only, or \`pacer tasks <id> --json\` for a snapshot.
   Use these commands instead of polling private task files or tailing executor logs.
5. Review the diff and run acceptance yourself, then \`pacer review <id> --accept --json\`
   or \`pacer review <id> --reject --json\`; optionally correct \`--kind <kind>\`.

Use \`pacer stop <id> --json\` to cancel and \`pacer dismiss <id...>\` to hide settled cards.
If an executor hits a provider limit, run \`pacer report-limit <provider>\` so routing skips it.

## Brief fields

JSON object: \`goal\` (required string), \`repo\` (absolute path, defaults to cwd),
\`kind\`, \`scope\`, \`acceptance\` (verification command), \`constraints\`, \`context\`,
\`executor\`, \`timeout_min\` (1–240), \`worktree\` (current/new/auto),
\`worktree_reason\` (one line, max 200 characters).
Command-line flags override file fields. Give a kind tag and a concrete acceptance command.

Choose current for uncommitted work, read-only research/review, installed dependencies/build
output, or a small follow-up there. Choose new when another task or the user is editing there,
for parallel tasks on the same repo, or exploratory/risky work. Give a worktree_reason;
omit the choice to let pacer decide (auto).

Strict/emergency: delegate execution and reserve planner budget for decisions/review.
Normal: delegate substantial execution. Relaxed: execute directly or delegate when useful.
Review and verify before reporting completion; the worker's report is evidence to check.
`;
export async function installSkill(
  tx: PlannerBuilder,
  dir: string,
): Promise<void> {
  await tx.edit(
    join(dir, "skills", "pacer", "SKILL.md"),
    () => PACER_SKILL,
    [],
  );
}
