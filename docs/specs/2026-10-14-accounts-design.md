# Accounts: several accounts per agent, agents vs providers

Status: decisions recorded 2026-10-14; ready for an implementation plan. Nothing is built.

## Goal

1. Track and use several accounts of the same agent: two Claude Code subscriptions, a personal and a team Codex account.
2. Separate the **agent** (the tool that runs the work) from the **account** (where the budget comes from), so that OpenCode with BytePlus, OpenCode with a local Ollama model and OpenCode with a company endpoint are three budgets run by one agent.
3. The planner can be any account of a planner agent.

Success: `pacer status`, the dashboard and the panel show each account's usage and the runners that draw on it; routing picks between runners (including several accounts of one agent) by headroom; a delegated task runs on the runner pacer chose; nothing changes for a user with one account per agent.

## What exists today

pacer:

- A strategy has one `providers` entry per budget. Native entries are keyed by agent name (`claude-code`, `codex`, `cursor`, `agy`), so there is exactly one per agent. Anything else must be `via: opencode` with `model: <provider>/<model>` (today: `byteplus`, `local`).
- Usage readers assume the default config folder: Codex reads `~/.codex/sessions`; Claude reads one cache that pacer's status-line hook writes (`<pacerHome>/cache/claude-rate-limits.json`).
- Executors start with the default config folders.

Orca 1.4.224 (verified with `orca account --help` and `orca account list --json`):

- Orca manages accounts for **claude, codex, opencode and devin** (`orca account add --agent <a>`, which runs the agent's own login, `list`, `rm`). OpenCode and Devin have `select` for new launches. Claude and Codex have an active account per runtime; the CLI has no command to launch an agent on a specific non-active account.
- `orca account list --json` returns `rateLimits` for claude, codex, gemini, opencodeGo, kimi, antigravity, minimax, grok, cursor and zcode (session, weekly and, where relevant, monthly windows, with reset times), plus `inactiveClaudeAccounts` and `inactiveCodexAccounts`.
- Account records include the signed-in email. pacer must not copy it into logs, task records or anything published.

## Concepts

Three separate things:

- **Account**: one budget and the credentials or endpoint behind it. Usage is tracked per account. Examples: a Claude subscription, a second Claude subscription, a ChatGPT/Codex plan, a Cursor plan, a BytePlus coding plan, a local Ollama, a company endpoint.
- **Agent**: the program that does the work: `claude-code`, `codex`, `cursor`, `agy`, `opencode` (more later). Decides how a task is launched and which planner integration (skill, hooks, status line) applies.
- **Runner**: an agent on an account, on a host. The **planner is one runner**; **executors are runners**. Routing and pacing choose runners.
- **Host**: the machine a runner executes on: this machine by default, or an Orca host (SSH host or paired Orca server). The account is the budget and is global: the same account used on two hosts is one budget.

### Runner ids: `agent#account@host`

A runner is identified by what runs, on which budget, where. Its id spells that out:

| Id | Meaning |
|---|---|
| `claude-code` | Claude Code on its default account, this machine |
| `claude-code#work` | Claude Code on account `work`, this machine |
| `codex#team@vudesktop` | Codex on account `team`, running on host `vudesktop` |
| `opencode#byteplus` | OpenCode on account `byteplus`, this machine |
| `opencode#byteplus@vudesktop` | OpenCode on account `byteplus`, running on `vudesktop` (same budget as the line above) |

- Grammar: `<agent>[#<account>][@<host>]`; each part `[a-z0-9][a-z0-9-]*`; `@<host>` is an Orca host id or name from `orca host list`.
- `#account` omitted: the agent's default account (the one account of its kind with no `home` / `orca_account`; at most one per kind). `@host` omitted: this machine.
- The same id is used everywhere: `planner`, `routing`, `pacing.order`, `pacer delegate --executor`, `pacer config set planner`, status, dashboard and panel.
- The model is not part of the id. An account may set `model` (its default); a runner entry may override it.
- In YAML the ids need no quotes (`#` starts a comment only after whitespace); the same holds for shell arguments.
- Orca host names can contain characters outside the grammar (for example `Home/Server`); the remote-runners design defines how a host is named in an id (a slug or an alias table).
- **Remote hosts are reserved, not built in this version**: an id with `@host` parses but is refused with "remote runners aren't supported yet" until the remote-runners design lands (it needs code transfer, remote usage and Orca dispatch tracking).

Two runners may share an account (for example OpenCode and Claude Code both using one API account); they then share that account's budget. Pacing charges usage to the account, not the runner.

Each account has a **source**, which says where pacer learns its usage and how a runner is pointed at it:

- **pacer-managed**: a config folder pacer points the agent at (`CLAUDE_CONFIG_DIR`, `CODEX_HOME`).
- **Orca-managed**: an account Orca already knows (`orca account list`); usage comes from Orca.
- **endpoint**: an API provider, local server or company endpoint used through an agent that can target it (today: OpenCode's `<provider>/<model>`), with a quota source, a metered token budget, or unmetered.

### Which agent can use which account

| Agent | Account kinds it can run on |
|---|---|
| claude-code | Claude subscription (default folder, pacer-managed folder, or Orca-managed) |
| codex | ChatGPT/Codex plan (default folder, pacer-managed folder, or Orca-managed) |
| cursor | its own signed-in Cursor plan only (no second account yet) |
| agy | its own signed-in Antigravity account only (no second account yet) |
| opencode | endpoint accounts (`<provider>/<model>`), including OpenCode Go and local servers |

pacer validates every runner against this table. Pairings outside it (for example Claude Code on a non-Anthropic endpoint) are refused until they are verified and added.

## Strategy format

```yaml
accounts:
  claude:      { kind: claude }                                   # default ~/.claude
  work:        { kind: claude, home: ~/.claude-work }             # pacer-managed
  codex:       { kind: codex }
  team:        { kind: codex, orca_account: <orca account id> }   # Orca-managed
  cursor:      { kind: cursor, usage: reactive, cooldown: 6h, model: auto }
  byteplus:    { kind: endpoint, usage: quota, quota_source: arkcli, model: coding-plan/dola-seed-2.0-code }
  ollama:      { kind: endpoint, usage: unmetered, model: ollama/qwen3 }
  acme:        { kind: endpoint, usage: metered, budget: { weekly_tokens: 50M }, model: acme/gpt-x }

planner: claude-code#work

runners:                       # optional: only for per-runner settings
  opencode#ollama: { model: ollama/qwen3-coder }   # override the account's default model

pacing:  { policy: priority, order: [codex#team, cursor, opencode#byteplus, opencode#ollama], planner_reserve: 15 }
routing: [ { default: [codex#team, cursor, opencode#byteplus, opencode#ollama, opencode#acme] } ]
```

Rules:

- A runner exists when its id appears in `planner`, `routing` or `runners`; there is no separate list to keep in sync. Its agent/account pair must be allowed (table above); OpenCode needs a model from the runner entry or the account.
- `planner` is a runner id; `planner: { agent, account }` is accepted too. Today's `planner: <agent>` is already a valid id (default account).
- `home` is valid for `claude` and `codex` accounts; `orca_account` for kinds Orca manages; usage settings (`usage`, `quota_source`, `budget`, `cooldown`, `allow_paid`) and the default `model` live on the account.
- `opencode` alone in `pacing.order` keeps meaning every OpenCode runner, in routing order.
- **Backward compatibility**: a strategy with today's `providers:` loads by mapping each provider to an account and a runner (native ids → that agent on its default account, e.g. `codex`; `via: opencode` entries → an endpoint account of the same name and the runner `opencode#<name>`). Old provider names stay valid as aliases in `--executor`, routing and pacing (`byteplus` → `opencode#byteplus`). Migration (during `pacer init` / `pacer update`, or `pacer config migrate`) rewrites the file with runner ids and a backup.

## Usage per account

| Account | Source |
|---|---|
| default Claude Code | unchanged (status-line cache) |
| pacer-managed Claude Code | the status-line hook installed in that config folder writes `<pacerHome>/cache/claude-rate-limits.<account>.json`; the hook picks the file by matching `CLAUDE_CONFIG_DIR` |
| pacer-managed Codex | `<home>/sessions` |
| Orca-managed (any) | `orca account list --json` rate limits for that account (active or inactive) |
| OpenCode-run | unchanged: arkcli quota, metered token budget, or unmetered |

Decided (see Decisions): Orca's rate limits also cover Cursor, Gemini, Kimi, OpenCode Go and others, which pacer only tracks reactively today. A `usage_source: orca` option could use them for any provider.

## Running a task on an account

- In 0.1.23, runners whose account uses a non-default folder (pacer-managed `home` or Orca-managed) always use the **direct backend**, even when `execution.backend` is `orca` or `auto`. Interactive Orca launches cannot pre-approve folder trust for that account; a real Claude run stopped at its workspace-trust dialog, while headless `claude -p` ran successfully. The attempt log records `direct backend: non-default account (Orca launch can't pre-approve folder trust)`. Default accounts keep their existing backend behavior.
- pacer-managed: pacer sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME` in the direct executor's environment. Never set for the default account.
- Orca-managed: **folder layout (2026-10-14, read from Orca's source):** Orca runs each managed account from its own config folder, exactly like a pacer-managed account:
  - Claude: `<Orca data>/claude-profiles/<accountId>/home`, launched with `CLAUDE_CONFIG_DIR` set to it. Claude names the account's Keychain entry from that exact path, so the same path reaches the same login.
  - Codex: `<Orca data>/codex-accounts/<accountId>/home`, a self-contained `CODEX_HOME`.
  - pacer selects the same folder with `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in the direct executor's environment.
  - **Gap:** `orca account list --json` returns account summaries without the folder path (the full records with `managedHomePath`/`managedAuthPath` stay inside Orca). pacer therefore derives the path from Orca's layout, checks the folder exists before using it, and otherwise treats the account as usage-only. This is a workaround with its own `upstream: orca` issue (ask Orca to include the folder in `account list --json`, or a per-launch account option).
  - pacer never reads or copies credentials from these folders or the Keychain; it only sets the environment variable.

## Planner runner

The planner is one runner: an agent and the account it runs on. pacer installs the planner integration for that agent (skill, hooks, status line) into that account's config folder when the account is pacer-managed. In a planner session, the hook reports the budget of the account the session actually runs on, found from `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in the hook's environment; a folder that matches no account falls back to the default account with a warning in `pacer status`. Changing the planner (`pacer config set planner <runner id>`, e.g. `claude-code#work`) moves the integration: installs it for the new runner and offers to remove it from the old one.

## Commands

- `pacer account list [--json]`: every account with kind, source, folder or Orca id, usage, which runners use it, and whether it looks signed in. Never prints credentials; shows Orca's label rather than the email.
- `pacer account add <claude|codex> <name> [--home <dir>] [--no-login]`: creates the folder (0700), adds the account to the active strategy (keeping comments), runs the matching agent's own login with the env var set.
- `pacer account add <kind> <name> --orca <orca account id>`: links an account Orca already manages.
- `pacer account add endpoint <name> --usage <quota|metered|unmetered> [...]`: an API, local or company endpoint.
- `pacer account rm <name> [--delete-home]`: refuses while the planner or any runner uses it; deletes a folder only with `--delete-home` and a y/N confirmation.
- `pacer runner list [--json]`; `pacer runner add <agent#account> [--model <m>]` (validated against the agent/account table; adds it to routing's default rule); `pacer runner rm <agent#account>` (refuses for the planner and the last runner; removes it from routing, pacing order and `runners`).
- `pacer config set planner <runner id>`: picks the planner runner and moves the planner integration (see Planner runner).
- `pacer init` lists the accounts it finds (pacer-managed folders in the strategy, Orca-managed accounts) and offers to add Orca's.

## Where accounts show

`pacer status`, `pacer route`, the dashboard and the panel show one row per runner with its account's usage (`codex#team · 34% · on pace`); runners that share an account show the same budget and are grouped under it. Routing between runners uses the same pacing policy whatever their agent or account.

## Settings

Settings today are spread across `strategy.yaml`, CLI flags and Orca's per-plugin settings, with no single place to see or change them. This adds one settings model with three front ends (live panel, dashboard, CLI). Every change goes through the same validated command, so all three behave the same and the CLI is what tests exercise.

### Principles

- **One model, one write path.** The CLI commands below are the only writers. The panel and the dashboard call them (the panel via console commands, the dashboard directly).
- **Changes edit `strategy.yaml` in place**, keeping comments and layout, and validate the whole strategy before writing. An invalid result is refused with the validation message; nothing is half-written.
- **Typing and sign-in happen in a terminal.** Panel forms never submit (pacer issue #15) and agent logins are interactive, so anything that needs text or a login opens the pacer terminal with the command filled in and running. Simple choices (pick, toggle, reorder) are buttons.
- **The panel shows what is true now.** The worker re-renders the settings page when the strategy, accounts or plugin settings change (same no-flash rule as the operations page).
- **Orca's own plugin settings** keep only plugin-level options: release source, notification level and automatic console. pacer settings never move there.

### What can be set

| Area | Setting | Panel | Dashboard | Command |
|---|---|---|---|---|
| Planner | Which agent and account plan | Agent picker, then the accounts that agent can use; "Use" button | `,` → Planner | `pacer config set planner <runner id>` (new) |
| Accounts | List with usage, source, signed-in state, runners using it | Card per account | `,` → Accounts | `pacer account list` (new) |
| | Add a pacer-managed account | "Add account" → agent and name chosen in the terminal | `a` | `pacer account add <agent> <name>` (new, runs the login) |
| | Link an Orca-managed account | "Link" next to each Orca account not yet in the strategy | `l` | `pacer account add <agent> <name> --orca <id>` (new) |
| | Remove | "Remove" with a confirm step (second click within 5 s); disabled while in use | `x` + y/N | `pacer account rm <name>` (new) |
| Runners | List: agent, account, model | Row per runner | `,` → Runners | `pacer runner list` (new) |
| | Add | "Add runner" → agent, then the accounts it can use, then model (OpenCode); typing opens the terminal | `a` | `pacer runner add <agent#account>` (new) |
| | Remove | "Remove" with a confirm step | `x` + y/N | `pacer runner rm <agent#account>` (new) |
| Executors | On or off | Toggle per runner | `b` (exists) | `block` / `unblock` console commands (exist) |
| | Order | Up / down buttons | `[` / `]` | `pacer config set pacing.order <a,b,…>` (new) |
| | Which kinds go where | Read-only summary; "Edit routing" opens the strategy builder | `r` → builder | `strategy-build` console command (exists) |
| Pacing | Policy (`priority`, `even`, `burn-before-reset`, `cheapest-first`) | Four-option switch | `,` → Pacing | `pacer config set pacing.policy <priority\|even\|burn-before-reset\|cheapest-first>` (new) |
| | Planner reserve | − / + buttons in 5-point steps (0–50) | `,` → Pacing | `pacer config set pacing.planner_reserve <n>` (new) |
| | Accounts of one agent: spread or fill-first | Two-button switch; fill threshold − / + in 5-point steps (50–100) | `,` → Pacing | `pacer config set pacing.accounts <spread\|fill>` / `pacing.fill_threshold <n>` (new) |
| Strategies | Switch | List with "Use" | `s` (exists) | `use` console command / `pacer use <strategy>` (exist) |
| | Create | "New strategy" opens the builder | `n` | `strategy-build` (exists) |
| Updates | Check, update | Existing Updates card | `c` / `u` (exist) | `check-updates` / `update` (exist) |
| Plugin | Notification level | Three-button switch | — | `notify-level` console command (exists) |
| | Update checks on/off | Toggle | — | `pacer config set update_check <true\|false>` (new) |

New console commands: `config-set` (`{key, value}`, allow-listed keys only: `planner` (a runner id), `pacing.order`, `pacing.policy`, `pacing.planner_reserve`, `pacing.accounts`, `pacing.fill_threshold`, `update_check`), `account-remove`, `runner-remove`, and `open-terminal` (`{command}` from a fixed list: `account add`, `account add --orca`, `runner add`, `init`), which opens or reuses the pacer terminal in the focused worktree and runs the command there. The panel never sends free text to a shell.

### `pacer config`

- `pacer config get [key] [--json]`: the effective value and where it comes from (strategy file, default).
- `pacer config set <key> <value>`: allow-listed keys above; validates, edits the active strategy in place, prints the change and the undo (`pacer config set <key> <old value>`).
- Writes go to the **active** strategy. Switching strategy shows that strategy's settings.

### Panel layout

The live panel gets a third view, **Settings**, next to Setup and Operations, opened from a gear button in the header. Sections, top to bottom: Planner, Accounts, Runners, Executors (order + toggles), Pacing, Strategies, Updates, Plugin. Each section shows its current values even when no console is live; buttons that need the console are disabled with "Open a pacer console to change settings" and a button that opens one.

The marketplace (static) panel has no settings page; it links to the dashboard's settings screen and the CLI.

### Dashboard

`,` opens a settings screen with the same sections; arrow keys move, Enter changes, Esc goes back. Text input (account name) uses the existing prompt line; logins hand the terminal over to the agent's login and return to the dashboard when it exits.

## Not supported in this version

- Cursor and Antigravity accounts: no confirmed way to run them from another config folder. `cursor@x` is rejected with a clear message.
- Windows/WSL account selection.
- Moving a running task between accounts.

## Testing

- Strategy parsing: today's `providers:` strategies load unchanged through the compatibility mapping; `planner: <string>` still works; runner agent/account pairings outside the table refused; `home`/`orca_account` only on allowed kinds; two runners on one account share its budget in pacing; `pacer config migrate` output round-trips.
- Usage readers per account (fixtures for each source, including `orca account list` output with an inactive account).
- Executor environment set only for pacer-managed accounts.
- Install targets the planner account's folder.
- `pacer account` commands, including strategy edits that keep comments and the refusals.
- `pacer config get/set`: allow-list, validation refusals leave the file unchanged, comments kept, undo line printed.
- Console commands `config-set`, `account-remove`, `open-terminal`: unknown keys and commands refused; `open-terminal` only runs its fixed commands.
- Settings page rendering: current values without a console, disabled buttons with the open-console action, re-render only on change.
- Dashboard settings screen: navigation, changes, account-name prompt, return after a login.
- Real run: two Claude Code accounts on one machine, a task routed to the second, its usage shown separately.

## Decisions (2026-10-14)

1. **Account sources: both.** pacer-managed folders and Orca-managed accounts. Running a task on a non-active Orca account stays behind the spike in "Running a task on an account".
2. **Orca rate limits: yes, when Orca is present.** `usage_source: orca` is the default for accounts Orca reports (including Cursor, Gemini, Kimi, OpenCode Go); without Orca those fall back to today's tracking.
3. **Routing between accounts of one agent: configurable per strategy.** `pacing.accounts: spread | fill` (default `spread`: by headroom, same policy as between agents). `fill` uses accounts in `pacing.order` until the current one is behind pace or any window reaches `pacing.fill_threshold` (percent, default 90), then moves to the next. "Behind pace" means the account's pacing verdict is `BEHIND`. Spread and fill apply only among runners of the same agent on accounts of the same kind, never among `endpoint` accounts, which keep `pacing.order` / routing order exactly as today. Account ordering applies only to runners with the same agent and account kind, excludes endpoint accounts, and treats `BEHIND` literally as a reason to yield in `fill` while retaining the `AHEAD` guardrail.
4. **Migration: during `pacer init` and `pacer update`.** A strategy in the old `providers:` form is rewritten into `accounts:`/`planner:`/`runners:`, keeping comments where possible, after saving the original as `<file>.pre-accounts.bak`; the command prints what changed and how to restore. Loading the old form still works in the meantime (and for strategies switched to later); `pacer config migrate` does the same on request.
5. **Settings list: complete as listed.** Every item gets a panel control and a dashboard key; the CLI covers all of it. Added keys: `pacing.accounts`, `pacing.fill_threshold`.
6. **Runner ids are `agent#account@host`** (owner's proposal). No invented runner names; `#account` and `@host` optional; the account is the global budget, the host only where it runs. `@host` is reserved and refused until remote runners are designed.
