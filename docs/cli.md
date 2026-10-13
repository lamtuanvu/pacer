# pacer CLI and skill

`pacer install <planner>` installs the pacer skill and planner policy/hooks. Supported
planners are claude-code, codex, cursor and opencode. Skills live at
`~/.claude/skills/pacer/SKILL.md`, `${CODEX_HOME:-~/.codex}/skills/pacer/SKILL.md`,
`~/.cursor/skills/pacer/SKILL.md`, or `${XDG_CONFIG_HOME:-~/.config}/opencode/skills/pacer/SKILL.md`.
The install manifest tracks files and backups; `pacer uninstall <planner>` reverses the install
while preserving later user edits. `pacer doctor` reports skill integrity.

MCP is optional: `pacer install <planner> --mcp` registers it. A default reinstall
leaves an existing pacer MCP entry unchanged; `--no-mcp` explicitly removes it.
Restart a running MCP client after updating pacer. CLI commands always run the current binary.

Read `pacer status --json`, choose an executor with `pacer route <kind> --json`, then
write a brief JSON file:

```json
{"goal":"Fix the flaky test","repo":"/absolute/repo","kind":"debug","scope":"test/","acceptance":"bun test","worktree":"current","worktree_reason":"Follow-up on uncommitted work"}
```

Run `pacer delegate --brief-file brief.json --json`, or pipe the JSON to
`pacer delegate --brief-file - --json`. Flags override file fields. The brief supports
`goal`, `repo` (defaults to cwd), `kind`, `scope`, `acceptance`, `constraints`, `context`,
`executor`, `timeout_min` (1–240), `worktree` (current/new/auto), and `worktree_reason`
(max 200 characters). Executors cannot delegate onward.

Choose current for uncommitted work, research/review, installed dependencies, or small
follow-ups. Choose new for parallel tasks, concurrent user edits, or risky experiments;
omit the choice for auto placement.

`pacer wait <id> --timeout 600 --json` blocks until a task leaves queued/running, or times out.
Timeout defaults to 600 seconds, maximum 3000; exit 0 means settled, exit 2 means timeout
(or invalid input). Review the diff and run acceptance before
`pacer review <id> --accept|--reject [--kind <kind>] --json`.
Use `pacer stop <id> --json` to cancel, `pacer report-limit <provider>` to record a quota
limit, and `pacer dismiss <id...>` to hide cards.

JSON contracts:

| Command | Top-level fields |
| --- | --- |
| status | generatedAt, strategy, planner, mode, disabled, calendarPace, providers, executors |
| route | kind, ranked, excluded |
| delegate | id, createdAt, kind, requestedExecutor, timeoutS, brief, state, attempts, placement; optional runtime fields |
| tasks id, wait, stop | task_id, state, kind, requested_executor, placement, attempts, result, review, resolved |
| tasks | Array of task summaries |
| review | recorded |

The task summary matches MCP task_status; delegate keeps returning the full task record.
Needs attention clears for partial/failed tasks reviewed with either verdict, whose worker
worktree was removed, or whose tracked/untracked file contents already match the base branch
tip. The brain checks at most once per task per minute and exposes `resolved` with reason
`reviewed`, `worktree removed`, or `already on <branch>`. Running and attention cards with
live Orca terminals open their session on click or Enter/Space; unavailable sessions show a
short action error.
