import { join } from "node:path";
import type { Txn } from "./txn";

export const PACER_SKILL = `---
name: pacer
description: Control Pacer through discoverable CLI operations, inspect subscription budgets, and route, delegate, observe and review work.
---

# pacer

Use the pacer CLI as the primary interface; MCP is an optional adapter.
Executors (PACER_ROLE=executor) may delegate only when Pacer gives them a scoped PACER_WORK_GRANT for the current work attempt. Use \`pacer dispatch child --goal "..." --request-id "stable-key"\` and review each child. Without that grant, complete the assigned task directly.
For a failed or incomplete child, use \`pacer dispatch retry --id CHILD_ID --request-id stable-retry --expect-rev REV\`. For a child question, use \`pacer dispatch answer --id CHILD_ID --request-id stable-answer --expect-rev REV --text "..."\`. Reuse the same request ID if the response is lost. Inspect the current revision in \`pacer dispatch tree --id CHILD_ID --json\`; a grant cannot retry or answer its own task.

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

## Other product actions

Discover only what you need: \`pacer api list --prefix runner. --json\` (or \`--search settings\`).
Inspect one input schema: \`pacer api describe runner.settings.save --json\`.
Invoke: \`pacer api call <op> --params-file - --json\`, piping a JSON object; omit params for {}.
Success is {result}; errors are {error:{code,message,hint?}} on stderr with a nonzero exit.
Use \`expect_rev\` from a fresh read when offered; on conflict re-read before deciding.
Supply \`consent\` only for user-authorized actions. Never replay an uncertain mutation blindly.
Use \`strategy.preview\` before saving; show ranking changes and save/switch only as requested.
Use \`pacer session io <id> --control --json\` for NDJSON terminal input/output; take control first.
Use \`pacer attachment\` for files and \`pacer api list --prefix client.control --json\` for client controls.
Pending jobs/client requests need status checks; pending is not success. Native actions need a connected desktop.
Use \`pacer help\` for stream/file commands. Do not read private task files, credentials or logs.

## Brief fields

JSON object: \`goal\` (required string), \`repo\` (absolute path, defaults to cwd),
\`kind\`, \`scope\`, \`acceptance\` (verification command), \`acceptance_timeout_min\` (integer 1–120, default 10;
acceptance deadline in minutes, also \`--acceptance-timeout-min\`; preserved on retry), \`acceptance_pipefail\` (boolean,
default false), \`constraints\`, \`context\`,
\`executor\`, \`timeout_min\` (1–240), \`worktree\` (current/new/auto),
\`worktree_reason\` (one line, max 200 characters).
Command-line flags override file fields. Give a kind tag and a concrete acceptance command.
\`acceptance\` runs exactly as written (\`bash -c\`/\`sh -c\`); pipeline idioms like
\`grep -v ... | (! grep .)\` or \`cmd | grep -q ...\` behave normally. Set
\`acceptance_pipefail: true\`, or write \`set -o pipefail;\` yourself, to also fail on a
non-final pipeline stage. The reported result always includes the exit code and shell
used, plus a hint for a 141 (SIGPIPE) or an instant empty-output failure.

Choose current for uncommitted work, read-only research/review, installed dependencies/build
output, or a small follow-up there. Choose new when another task or the user is editing there,
for parallel tasks on the same repo, or exploratory/risky work. Give a worktree_reason;
omit the choice to let pacer decide (auto).

Strict/emergency: delegate execution and reserve planner budget for decisions/review.
Normal: delegate substantial execution. Relaxed: execute directly or delegate when useful.
Review and verify before reporting completion; the worker's report is evidence to check.
`;
export function installSkill(tx: Txn, dir: string): void {
  tx.edit(join(dir,"skills","pacer","SKILL.md"),()=>PACER_SKILL,[]);
}
