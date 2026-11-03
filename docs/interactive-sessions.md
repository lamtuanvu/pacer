# Interactive sessions

Open Pacer to start work. Enter a request, choose a repository and an agent/account, and select Start session. Add an existing local Git folder through Add a repository. The default New worktree creates an isolated branch from the displayed base; it does not copy uncommitted changes. Use existing checkout explicitly works on that checkout's files and refuses a checkout reserved by another session.

The working screen embeds the agent's terminal interface. Its commands, tools, permission prompts and keyboard interactions belong to the agent. Pacer adds session navigation, Changes, Request & files, terminal reconnection and End session. A completed assistant turn keeps the conversation open. Closing the window leaves the process running; live idle conversations still occupy an execution slot. The selected agent/account stays fixed when its budget becomes unavailable.

In a built-in session terminal, HTTP(S) links open in a new browser tab or the system browser. File references such as `src/main.ts:42:7` and local OSC 8 `file://` links open a read-only viewer at the named line. Quote or backtick paths that contain spaces. While you control the terminal, use Ctrl/⌘-click to follow a link; watchers can click directly. The viewer keeps the terminal connected and opens beside it when the session area is wide enough. Code shows selectable source and whole-file search; Markdown and HTML open on Source and offer Preview. HTML preview is isolated and blocks scripts, inline styles, forms, external resources and local assets, so it may differ from a running page; the viewer lists what it blocked. Esc closes search, then the viewer. Files must be local UTF-8 text within the session workspace and below 512 KiB. Symlink paths, Pacer state, remote files, and Orca-owned terminals are unavailable in this viewer.

Pick or drop files, or paste a screenshot into the composer or terminal. Files stay in private Pacer storage outside Git. Limits are 20 files per batch, 25 MiB each and 100 MiB for the conversation. Unclaimed drafts expire after 24 hours. Later attachments provide an explicit reference to copy and paste into the agent input; Pacer does not submit a partly written prompt or send Enter on your behalf.

Interactive adapters support Codex, Claude Code and OpenCode. Pacer inspects the installed CLI's interface in the selected account environment; a version update alone does not disable an executor. Missing executables, required native options, sign-in, account readiness, budget and operator restrictions each report their own reason. Other agents and remote interactive sessions remain unsupported. Ordinary delegated execution keeps its separate support.

Codex accepts initial images natively. Claude Code and OpenCode receive labelled readable file paths for initial images and other files; these are references, not native image attachments. Later attachments remain explicit references for all three agents. Native permission and workspace trust prompts stay in the terminal.

Claude Code starts with an assigned native conversation UUID. OpenCode creates a specific native session on a private server and applies the selected model to it; its full-screen CLI does not need a model argument. Both persist the identity before launch. Codex records the identity supplied by its native hooks. Resume uses that exact identity without resending the first request or attachments. OpenCode verifies existing history before resuming so a missing history cannot silently become a new conversation. Model and named-account environments are retained, including endpoint configuration. Explicit interactive selection may use the configured planner account; delegation still excludes it. Repository policies, account readiness, budgets and execution slots continue to apply.

End session stops the process while retaining its changes and output. It does not accept or merge the work. Resume conversation is available when the agent supplied a native session identity and its adapter supports resuming; it keeps the same agent/account and worktree.

If a session fails, the working screen shows its recorded failure reason. For a
full disk, free space on this machine before resuming. Resume keeps the native
conversation identity when available and waits until the previous agent process
and terminal have stopped. **Open in terminal** can replay retained output; if
opening the app fails, the screen shows a copyable `pacer attach` command. A
failure before the agent reports a resumable identity requires a new session;
the failed record remains available for reference.

CLI equivalents require a running `pacer serve`:

```sh
pacer session start --repo /path/to/project --executor codex --base main --attach /path/to/context.png -- "Explain and fix the failing test"
pacer attach <task-id> --control
pacer session end <task-id>
pacer session resume <task-id>
```

Use `--checkout /path/to/checkout` instead of `--base` for existing files. Add `--json` for structured results. In the TUI, `n` starts an interactive session and Enter opens its terminal; the existing `d` delegation flow remains available.

Implementation verification and live agent/version/platform coverage are recorded in the change's evidence report. Do not infer verified feature parity from an installed agent or a passing terminal-renderer test.

Task changes use the recorded base commit for a new worktree and the first start
commit for an existing checkout. Orca-owned tasks use the same baseline even
without a built-in terminal record. Changes already committed before that baseline
are excluded. Existing uncommitted edits and changes by other tools in a shared
checkout cannot be assigned to an individual agent by Git alone.

## Several agents in one task

In Workspace, select a task and choose **+ → New agent session**. Each added agent
belongs to that task, shares its existing local worktree, and has an independent
conversation, recording, controller and reconnect address. Stable session numbers
identify agents using the same account. Closing a panel leaves its session running;
**End session** affects only that agent. **Start fresh conversation** retains earlier
attempts with a fresh native identity; **Resume conversation** uses the recorded
identity and original account/model. The account must remain available. Additional
agents currently require the built-in local host, and respect executor and machine
capacity. Wait until the primary task has published its workspace and a confirmed
local backend before adding agents, including tasks using the current checkout.
The service verifies that the workspace still belongs to the task's repository.
Another task's live or waiting agent, or pending final checks, reserves overlapping paths; legacy retries
cannot transfer such a checkout to a different task. End added sessions before
moving their primary task to Orca or a remote host. Additional Orca and remote
sessions are currently unsupported and refused.

Added-session creation, fresh retry and native resume pass both delegation and
routing plugin policy before changing the task's checks, review or session attempt.
Receipts are revalidated after native preparation and immediately before launch.
Route exclusions can refuse the selected executor; identity-preserving amendments
are supported. An amendment that changes the task kind, executor or workspace is
refused even in open policy mode: an appended session cannot move its parent.

Workspace session reads follow service lifecycle invalidations rather than
per-panel timers. Cross-client changes and unexpected process exits are observed
on the service's next lifecycle pump (normally within 15 seconds), including
when every agent panel is hidden or closed.

The additive protocol 3 operations are `session.agent.list`, `.get`, `.create`,
`.end`, `.retry` and `.resume`. Creation takes `task_id`, `request_id`, `executor`
and `request`; mutations take `task_id`, session `id` and `expect_rev`. Repeating an
identical creation request returns the same session. Conflicting revisions or
account bindings require a refresh. The existing `session.create`, `session.end`,
`session.resume` and `task.session` operations retain their original meanings.

New conversations invalidate the prior task checks and review. Task acceptance
waits until the primary run and all added sessions have ended, then records one
check for the latest session generation. The checker retains a supervised receipt
across service reconnects. Task stop also stops its added agents and checker;
cleanup and review wait for active agents and pending checks.

**Stop all** durably cancels the exact pending checker generation, including one
that has not claimed or launched acceptance yet. It terminates a running checker
and waits for diff capture to finish before releasing the checkout reservation.
Cancelled checks do not publish acceptance results, and the stop report includes
cancelled pending work even when no child had launched. A later session generation
is not cancelled by an older stop request.

Added-session attempt recordings and final-check generation directories are not
pruned by the primary session retention setting. Retained history can grow without
a lifetime disk bound. Reservation reads and the lifecycle pump share a
generation-aware cache: explicit exit evidence retires a naturally ended attempt
from warm idle probes, without rewriting its history. Ambiguous starts and runs
without exit evidence remain observable. A new attempt invalidates the cache.
Reservation reads pin the database file before SQLite acquisition and verify its
identity after reading. A concurrent replacement returns a retryable conflict
and discards the cached view, even when the replacement reuses a generation.
Cold reads and registry mutations still load retained history; this is not a
lifetime history or disk bound. Safe archival/pruning remains follow-up work.
