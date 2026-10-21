# Interactive sessions

Open Pacer to start work. Enter a request, choose a repository and an agent/account, and select Start session. Add an existing local Git folder through Add a repository. The default New worktree creates an isolated branch from the displayed base; it does not copy uncommitted changes. Use existing checkout explicitly works on that checkout's files and refuses a checkout reserved by another session.

The working screen embeds the agent's terminal interface. Its commands, tools, permission prompts and keyboard interactions belong to the agent. Pacer adds session navigation, Changes, Request & files, terminal reconnection and End session. A completed assistant turn keeps the conversation open. Closing the window leaves the process running; live idle conversations still occupy an execution slot. The selected agent/account stays fixed when its budget becomes unavailable.

Pick or drop files, or paste a screenshot into the composer or terminal. Files stay in private Pacer storage outside Git. Limits are 20 files per batch, 25 MiB each and 100 MiB for the conversation. Unclaimed drafts expire after 24 hours. Later attachments provide an explicit reference to copy and paste into the agent input; Pacer does not submit a partly written prompt or send Enter on your behalf.

Agent capabilities vary. Codex's supported interactive CLI accepts initial images through its native image argument. Other files use labelled readable paths, which do not imply native image input. OpenCode interactive model overrides are currently refused with a reason; its configured default model can be used. Unsupported agents/versions and missing sign-in/readiness explain why they cannot start. Native attachment interpretation and model capabilities remain agent-specific.

End session stops the process while retaining its changes and output. It does not accept or merge the work. Resume conversation is available when the agent supplied a native session identity and its adapter supports resuming; it keeps the same agent/account and worktree.

CLI equivalents require a running `pacer serve`:

```sh
pacer session start --repo /path/to/project --executor codex --base main --attach /path/to/context.png -- "Explain and fix the failing test"
pacer attach <task-id> --control
pacer session end <task-id>
pacer session resume <task-id>
```

Use `--checkout /path/to/checkout` instead of `--base` for existing files. Add `--json` for structured results. In the TUI, `n` starts an interactive session and Enter opens its terminal; the existing `d` delegation flow remains available.

Implementation verification and live agent/version/platform coverage are recorded in the change's evidence report. Do not infer verified feature parity from an installed agent or a passing terminal-renderer test.
