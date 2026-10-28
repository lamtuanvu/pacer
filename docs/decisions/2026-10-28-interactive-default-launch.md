# Interactive default launch for delegated tasks

Status: Proposed, 2026-10-28. Amends [ADR 0003](0003-interactive-conversations.md) and the specs named under "Superseded statements".

## Context

Delegated tasks ran headless (`claude -p`, `codex exec`) unless a runner set `session: interactive`. Interactive runs can be watched and taken over, and they finish when the agent runs `pacer report`. Making them the default exposed three gaps.

1. Claude Code shows dialogs before it loads pacer's hooks: folder trust, the external `CLAUDE.md` import warning, the one-time bypass-permissions acknowledgement and project MCP approval. An unattended task would wait at them unseen.
2. Under launchd or systemd the service's environment lacks the user's shell profile, so an interactive agent did not behave like the same CLI started in a terminal.
3. Strict delegation enforcement certifies a specific launch (binary, account folder, control files, headless argv). A changed default must not move strict work onto an uncertified launch.

## Decision

**Launch mode and precedence.** A runner's `session:` wins, then `execution.launch_mode` (`interactive` | `headless`), then `interactive`. A mode taken from the setting or the default falls back to headless, with the reason in the attempt note, for remote runners, Codex older than 0.162.1 or of unverifiable version, endpoint test tasks and agents without an interactive launcher. An explicit runner `session: interactive` keeps reporting these cases as errors. Conversations are always interactive. Backend selection uses the same resolution as the attempt.

**Strict managed work.** It stays headless when its mode is default-derived, and an explicit `session: interactive` runner is refused at once (and again at launch). Strict work is exempt from terminal parity. The attempt runs with exactly the service environment that was certified: no login shell, direnv, mise or login umask, and the default account uses the service's default folder. The certification canary uses the same folder. Any other environment could start a different binary or read settings other than the certified ones.

**Terminal parity for other work.** Executors start from the user's login-shell environment (fixed argv, 5 s limit, 60 s in-memory cache, service environment as fallback, `PACER_LOGIN_ENV=off`). The login umask applies to the agent only. direnv and mise apply per workdir under their own trust. Pacer's own variables and the account selection go on top. Only the login profile or the strategy selects an account folder (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`); direnv and mise never do. The profile's folder is recorded for usage readers, and each run records the folder it used for its own transcript lookup. Routing's installed check reads the cached login PATH and never waits on a shell. The service and the task runner read the login environment before routing.

**Scoped exception to "preserve native permission prompts".** For unattended interactive task launches of Claude Code, pacer answers these prompts and no others:

- **Folder trust.** Granted only for a worktree pacer created for the task under `~/.pacer/worktrees`, never for in-place runs, non-git folders, `$HOME` or `/`. The grant is a lock-guarded, atomic update of the `projects` entries in the account's `.claude.json`, locked at its real path.
- **External `CLAUDE.md` imports.** An unanswered prompt is recorded as declined on the repository root. Earlier answers are kept.
- **Bypass-permissions acknowledgement.** Skipped through the run's `--settings` file. This applies to every interactive launch that already passes the bypass flag.
- **Project MCP approval.** For unattended runs in a pacer-created task worktree only, `enableAllProjectMcpServers` goes in the run's `--settings` file. `disabledMcpjsonServers` and `enabledMcpjsonServers` are carried over from the source checkout's `.claude/settings.local.json` and the account's `.claude.json` project entry (read-only, only those keys), so rejected servers stay off. Claude Code 2.1.281 applies `disabledMcpjsonServers` before `enableAllProjectMcpServers` from the same per-run file; this was verified in a sandbox. If either source file exists but cannot be read or parsed, nothing is approved (fail closed) and the attempt note says Claude's MCP prompt may appear. In-place runs keep Claude's MCP prompt, and pacer reads no MCP answers for them.

Conversations and takeovers, where the user is at the terminal, keep Claude's native MCP prompt and get no trust grant beyond the task-worktree rule. Native tool permission prompts are unchanged; they were already bypassed by the permission flags described in the README. The account's `settings.json` is never edited.

**Host-side placement (ARCH-12/13, P13).** Claude folder trust, the login environment and account-folder resolution live in the host (`src/exec/`), not in the bundled `agentSession` plugin. By design that plugin has no filesystem or process grants and receives no credentials (ADR 0003). Trust writes the account's `.claude.json`, which can hold an API key on some platforms. The login environment spawns the user's shell. The account folder belongs to the host's account model and also feeds routing, usage readers and enforcement. Moving any of these into the plugin would need new filesystem and process grants and would hand account state to plugin code. The plugin keeps preparing argv and identity plans, and the host executes them, as before. A future plugin-protocol revision could let the plugin declare such needs as data for the host to carry out; that is out of scope here.

## Alternatives considered

- **Keep headless as the default.** Rejected: interactive runs are what the user can watch and take over, and the prompts above were the only blockers.
- **Edit the account's `settings.json`** (`enableAllProjectMcpServers`, `skipDangerousModePermissionPrompt`). Rejected: it would change the user's own Claude sessions in every project.
- **Approve all project MCP servers without the user's answers.** Rejected: it would turn rejected servers back on, because a task worktree lacks the untracked `settings.local.json`.
- **Pre-trust every launch folder.** Rejected: an in-place run or parent-folder walk could trust `$HOME` or a whole checkout for the user's own sessions.
- **For strict work, certify the composed login environment and pin argv[0].** Rejected: the login and per-folder environments change between certification and launch, so the certificate would not describe the run. Running strict work with the service environment keeps one certified launch.
- **Only extend the service's PATH** (as `service install` does). Rejected as the only fix: it does not bring locale, proxies, tool managers or profile exports.
- **Put this logic in the `agentSession` plugin.** Rejected for the grant reasons above.

## Superseded statements (REPO-9)

- [Interactive entry spec](../specs/2026-10-21-interactive-entry-design.md), validation: "Exercise native permission prompts without suppressing them in the new interactive launch mode". Superseded for unattended delegated tasks by the scoped exception above.
- [Interactive agent support spec](../specs/2026-10-24-interactive-agent-support-design.md), Claude Code: "Preserve native permission prompts". Superseded in the same scope. Conversations still keep the native MCP prompt.

## Consequences

Governance: ARCH-1/2/8/9/12/13, API-1/3, SEC-1/5/7, CT-11, REPO-9. Because the trust update parses `.claude.json` (which may contain an API key) and writes a temporary copy, the maintainer granted a scoped SEC-1 exception on 2026-10-28 ([Exceptions](../../.project/decisions.md#exceptions)). Within it, the file is parsed to merge `projects` entries and to read the two MCP answer keys, for pacer-created task worktrees and their source repository only; pacer never logs, returns or keeps its contents, writes the temporary copy `wx` with the file's own mode and removes it, including leftovers from a crash.
