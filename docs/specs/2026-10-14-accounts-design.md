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
- **Runner**: an agent paired with an account, plus a model where the agent needs one. The **planner is one runner**; **executors are runners**. Routing and pacing choose runners.

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
  claude:        { kind: claude }                                   # default ~/.claude
  claude-work:   { kind: claude, home: ~/.claude-work }             # pacer-managed
  codex:         { kind: codex }
  codex-team:    { kind: codex, orca_account: <orca account id> }   # Orca-managed
  cursor:        { kind: cursor, usage: reactive, cooldown: 6h }
  byteplus:      { kind: endpoint, usage: quota, quota_source: arkcli }
  ollama:        { kind: endpoint, usage: unmetered }
  acme:          { kind: endpoint, usage: metered, budget: { weekly_tokens: 50M } }

planner: { agent: claude-code, account: claude-work }

runners:
  codex-team: { agent: codex, account: codex-team }
  cursor:     { agent: cursor, account: cursor, model: auto }
  seed:       { agent: opencode, account: byteplus, model: coding-plan/dola-seed-2.0-code }
  local:      { agent: opencode, account: ollama, model: ollama/qwen3 }
  acme:       { agent: opencode, account: acme, model: acme/gpt-x }

pacing:  { policy: priority, order: [codex-team, cursor, seed, local], planner_reserve: 15 }
routing: [ { default: [codex-team, cursor, seed, local] } ]
```

Rules:

- `planner` is `{agent, account}`; `planner: <string>` (today's form) still loads and means the agent on its default account.
- `runners` keys are what routing, pacing, `delegate --executor`, status and the panel name. A runner's `account` must exist and be allowed for its `agent` (table above); `model` is required for OpenCode.
- `home` is valid for `claude` and `codex` accounts; `orca_account` for kinds Orca manages; usage settings (`usage`, `quota_source`, `budget`, `cooldown`, `allow_paid`) live on the account.
- **Backward compatibility**: a strategy with today's `providers:` and no `accounts:`/`runners:` loads by mapping each provider to one account plus one runner of the same name (native ids to their agent and default account; `via: opencode` entries to an endpoint account and an OpenCode runner). `pacer config migrate` rewrites a strategy into the new form, keeping comments where it can; nothing is rewritten without that command.

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

- pacer-managed: pacer sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME` in the executor's environment, for both the direct and the Orca backend (the Orca backend passes it in the terminal command). Never set for the default account.
- Orca-managed: **spike result (2026-10-14, read from Orca's source; not yet run against a real second account):** Orca runs each managed account from its own config folder, exactly like a pacer-managed account:
  - Claude: `<Orca data>/claude-profiles/<accountId>/home`, launched with `CLAUDE_CONFIG_DIR` set to it. Claude names the account's Keychain entry from that exact path, so the same path reaches the same login.
  - Codex: `<Orca data>/codex-accounts/<accountId>/home`, a self-contained `CODEX_HOME`.
  - Orca leaves an explicitly set `CLAUDE_CONFIG_DIR` / `CODEX_HOME` alone ("the user's own CLAUDE_CONFIG_DIR wins over the selection"; custom `CODEX_HOME` overrides are honoured), so a runner launched inside an Orca terminal stays on the account pacer chose.
  - **Gap:** `orca account list --json` returns account summaries without the folder path (the full records with `managedHomePath`/`managedAuthPath` stay inside Orca). pacer therefore derives the path from Orca's layout, checks the folder exists before using it, and otherwise treats the account as usage-only. This is a workaround with its own `upstream: orca` issue (ask Orca to include the folder in `account list --json`, or a per-launch account option).
  - pacer never reads or copies credentials from these folders or the Keychain; it only sets the environment variable.

## Planner runner

The planner is one runner: an agent and the account it runs on. pacer installs the planner integration for that agent (skill, hooks, status line) into that account's config folder when the account is pacer-managed. In a planner session, the hook reports the budget of the account the session actually runs on, found from `CLAUDE_CONFIG_DIR` / `CODEX_HOME` in the hook's environment; a folder that matches no account falls back to the default account with a warning in `pacer status`. Changing the planner (`pacer config set planner <agent>:<account>`) moves the integration: installs it for the new runner and offers to remove it from the old one.

## Commands

- `pacer account list [--json]`: every account with kind, source, folder or Orca id, usage, which runners use it, and whether it looks signed in. Never prints credentials; shows Orca's label rather than the email.
- `pacer account add <claude|codex> <name> [--home <dir>] [--no-login]`: creates the folder (0700), adds the account to the active strategy (keeping comments), runs the matching agent's own login with the env var set.
- `pacer account add <kind> <name> --orca <orca account id>`: links an account Orca already manages.
- `pacer account add endpoint <name> --usage <quota|metered|unmetered> [...]`: an API, local or company endpoint.
- `pacer account rm <name> [--delete-home]`: refuses while the planner or any runner uses it; deletes a folder only with `--delete-home` and a y/N confirmation.
- `pacer runner list [--json]`, `pacer runner add <name> --agent <agent> --account <account> [--model <m>]` (validated against the agent/account table), `pacer runner rm <name>` (refuses for the last runner; removes it from routing and pacing order).
- `pacer config set planner <agent>:<account>`: picks the planner runner and moves the planner integration (see Planner runner).
- `pacer init` lists the accounts it finds (pacer-managed folders in the strategy, Orca-managed accounts) and offers to add Orca's.

## Where accounts show

`pacer status`, `pacer route`, the dashboard and the panel show one row per runner with its account's usage (`codex-team · Codex on codex-team · 34% · on pace`); runners that share an account show the same budget and are grouped under it. Routing between runners uses the same pacing policy whatever their agent or account.

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
| Planner | Which agent and account plan | Agent picker, then the accounts that agent can use; "Use" button | `,` → Planner | `pacer config set planner <agent>:<account>` (new) |
| Accounts | List with usage, source, signed-in state, runners using it | Card per account | `,` → Accounts | `pacer account list` (new) |
| | Add a pacer-managed account | "Add account" → agent and name chosen in the terminal | `a` | `pacer account add <agent> <name>` (new, runs the login) |
| | Link an Orca-managed account | "Link" next to each Orca account not yet in the strategy | `l` | `pacer account add <agent> <name> --orca <id>` (new) |
| | Remove | "Remove" with a confirm step (second click within 5 s); disabled while in use | `x` + y/N | `pacer account rm <name>` (new) |
| Runners | List: agent, account, model | Row per runner | `,` → Runners | `pacer runner list` (new) |
| | Add | "Add runner" → agent, then the accounts it can use, then model (OpenCode); typing opens the terminal | `a` | `pacer runner add …` (new) |
| | Remove | "Remove" with a confirm step | `x` + y/N | `pacer runner rm <name>` (new) |
| Executors | On or off | Toggle per runner | `b` (exists) | `block` / `unblock` console commands (exist) |
| | Order | Up / down buttons | `[` / `]` | `pacer config set pacing.order <a,b,…>` (new) |
| | Which kinds go where | Read-only summary; "Edit routing" opens the strategy builder | `r` → builder | `strategy-build` console command (exists) |
| Pacing | Policy (priority or spread) | Two-button switch | `,` → Pacing | `pacer config set pacing.policy <priority\|spread>` (new) |
| | Planner reserve | − / + buttons in 5-point steps (0–50) | `,` → Pacing | `pacer config set pacing.planner_reserve <n>` (new) |
| | Accounts of one agent: spread or fill-first | Two-button switch; fill threshold − / + in 5-point steps (50–100) | `,` → Pacing | `pacer config set pacing.accounts <spread\|fill>` / `pacing.fill_threshold <n>` (new) |
| Strategies | Switch | List with "Use" | `s` (exists) | `use` console command / `pacer use <strategy>` (exist) |
| | Create | "New strategy" opens the builder | `n` | `strategy-build` (exists) |
| Updates | Check, update | Existing Updates card | `c` / `u` (exist) | `check-updates` / `update` (exist) |
| Plugin | Notification level | Three-button switch | — | `notify-level` console command (exists) |
| | Update checks on/off | Toggle | — | `pacer config set update_check <true\|false>` (new) |

New console commands: `config-set` (`{key, value}`, allow-listed keys only: `planner` (`<agent>:<account>`), `pacing.order`, `pacing.policy`, `pacing.planner_reserve`, `pacing.accounts`, `pacing.fill_threshold`, `update_check`), `account-remove`, `runner-remove`, and `open-terminal` (`{command}` from a fixed list: `account add`, `account add --orca`, `runner add`, `init`), which opens or reuses the pacer terminal in the focused worktree and runs the command there. The panel never sends free text to a shell.

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
3. **Routing between accounts of one agent: configurable per strategy.** `pacing.accounts: spread | fill` (default `spread`: by headroom, same policy as between agents). `fill` uses accounts in `pacing.order` until the current one is behind pace or any window reaches `pacing.fill_threshold` (percent, default 90), then moves to the next.
4. **Migration: during `pacer init` and `pacer update`.** A strategy in the old `providers:` form is rewritten into `accounts:`/`planner:`/`runners:`, keeping comments where possible, after saving the original as `<file>.pre-accounts.bak`; the command prints what changed and how to restore. Loading the old form still works in the meantime (and for strategies switched to later); `pacer config migrate` does the same on request.
5. **Settings list: complete as listed.** Every item gets a panel control and a dashboard key; the CLI covers all of it. Added keys: `pacing.accounts`, `pacing.fill_threshold`.
