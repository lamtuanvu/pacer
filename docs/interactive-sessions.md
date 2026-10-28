# Interactive sessions

Open Pacer to start work. Enter a request, choose a repository and an agent/account, and select Start session. Add an existing local Git folder through Add a repository. The default New worktree creates an isolated branch from the displayed base; it does not copy uncommitted changes. Use existing checkout explicitly works on that checkout's files and refuses a checkout reserved by another session.

The working screen embeds the agent's terminal interface. Its commands, tools, permission prompts and keyboard interactions belong to the agent. Pacer adds session navigation, Changes, Request & files, terminal reconnection and End session. A completed assistant turn keeps the conversation open. Closing the window leaves the process running; live idle conversations still occupy an execution slot. The selected agent/account stays fixed when its budget becomes unavailable.

In a built-in session terminal, HTTP(S) links open in a new browser tab or the system browser. File references such as `src/main.ts:42:7` and local OSC 8 `file://` links open a read-only viewer at the named line. Quote or backtick paths that contain spaces. While you control the terminal, use Ctrl/⌘-click to follow a link; watchers can click directly. The viewer keeps the terminal connected. Code shows selectable source and search; Markdown and HTML offer Source and Preview. HTML preview is isolated and blocks scripts, forms, external resources and local assets, so it may differ from a running page. Files must be local UTF-8 text within the session workspace and below 512 KiB. Symlink paths, Pacer state, remote files, and Orca-owned terminals are unavailable in this viewer.

### Open in your editor

The desktop app can hand a session file to your own editor, including binary and oversized files that the viewer can't show. It can also reveal the file in Finder or the file manager. Browser clients don't offer either action. The service resolves the file with the viewer's rules: it must be a regular file inside the current local attempt's workspace, reached without following symlinks, and outside Pacer state. The desktop checks the file again just before opening it. Terminal text never names a file to native code directly.

By default, macOS opens the file in your default text editor (`open -t`), never in the app associated with its type, so a `.command` or `.app` file is never launched. Linux has no safe default, because `xdg-open` picks a handler by content type, so Open in editor appears there only once you configure an editor. To use a specific editor, create `$PACER_HOME/desktop/editor.json` yourself, for example with mode `0600`:

```json
{ "command": ["/usr/local/bin/code", "--goto", "{path}:{line}:{column}"] }
```

The program must be an absolute path. `{path}`, `{line}` and `{column}` are replaced inside individual arguments. One argument never splits into several, and the command never runs through a shell. The line and column default to 1. No API operation writes this file. If the file, `$PACER_HOME/desktop` or `$PACER_HOME` is owned by another user, or if group or other users can write to any of them, Open in editor reports an error and doesn't fall back to the default editor. The file must be a regular file, not a symlink, and at most 64 KiB. See [ADR 0011](decisions/0011-open-session-file-in-editor.md).

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
