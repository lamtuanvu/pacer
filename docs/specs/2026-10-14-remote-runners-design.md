# Remote runners: delegating to an agent on another machine

Status: **superseded in part** by `2026-10-14-core-contract-design.md` (remote hosts move to a pacer-run SSH backend; placement, lifecycle and usage here describe the Orca route that was spiked and set aside). Transfer, security and failure modes carry over. Original status: design for review, 2026-10-14. Depends on the accounts design (`2026-10-14-accounts-design.md`, branch `feat/accounts-0.1.23`), whose runner ids reserve `@host`.

## Goal

`pacer delegate` can run a task on a runner such as `codex#team@vudesktop`: the agent works in a checkout on another machine, and the result comes back for the planner to review locally, exactly like a local task (`pacer wait`, `pacer stop`, logs, `pacer review`).

Success:

- A task routed to `codex@vudesktop` produces a local branch with the remote agent's commits. Acceptance runs locally, the report looks like a local task's, and `pacer review` accepts or rejects it.
- Losing the connection never turns into a fake exit or a duplicate run.
- No credentials leave either machine.

Non-goals:

- Moving a running task between hosts.
- Running the planner on a remote host.
- Managing remote machines: installing agents, logging in, cloning. pacer checks and explains these; the user does them.

## What exists today

- pacer's Orca backend (`src/exec/orca/backend.ts`) already supervises **Orca orchestration workers by dispatch id**:
  - `ensureCoordinator` keeps a coordinator terminal bound to a Run.
  - `worker-start` places the worker in a new child worktree or the current one.
  - `wait.ts` waits on `orchestration check` for `worker_done`, polls `worker-show`, reads `worker-read` output for limit, idle and busy signals, and nudges through `terminal send`.
  - `cleanup` does `worker-release` / `worker-stop`.

  Only placement, code transfer and a few terminal-handle uses are local-only.
- Verification (`verifyRepo`: `git status` / `diff --stat` and the acceptance command) runs on a local path. Review is local.
- Usage readers are local files plus Orca's `account list` for the local runtime.

Orca facts, verified on Orca 1.4.224 against SSH host vudesktop (spike, 2026-10-14):

| Fact | Consequence |
|---|---|
| `orca host list` lists `local`, SSH targets (id `ssh-<…>`, name, `connected`, `platform`) and paired servers. SSH names may contain `/`, spaces, capitals. | Host names don't always fit the id grammar: pacer needs an alias. |
| `project setup-clone` **refuses SSH hosts**. `project setup-existing-folder --host ssh:<id> --path <dir> --kind git` works and joins the existing project (same `github:<owner>/<repo>` project id). | A remote checkout is a one-time manual clone plus a pacer-run registration. |
| Without `--on`, `worker-start --worktree new-top-level` is refused. `orca worktree create --repo id:<remote repo id> --name <n> --base-branch <ref>` creates the worktree on the SSH host, and `worker-start --worktree id:<exact id>` runs the worker there **from the local runtime and Run**. | SSH placement is two calls: create the worktree, then start the worker in it. |
| `worker-start --on <environment>` accepts only paired Orca servers, with `--worktree new-top-level --repo <exact remote repo>`; the Run stays local. | Paired-server placement is one call. Not exercised (nothing paired). |
| `worker_done` from the remote worker arrives at the local coordinator with `{taskId, dispatchId, outcome, filesModified}`. `worker-show`, `worker-read`, `worker-release`, `worker-list --include-remote` work by dispatch id and report `host: {kind: remote, id}`. | `wait.ts` works unchanged for completion. |
| `worker-read` returns `source: transcript` (messages) rather than `terminal.tail`. | Limit, idle and busy detection must read the transcript (or ask for `--source terminal`). |
| An agent with an interactive startup prompt (Codex's update menu) fails at `agent_readiness` ("Agent startup blocked: agent-update-prompt"), and `terminal send` is refused (`agent_prompt_blocked`). | Remote agents must start without prompts; pacer reports this as a broken runner with the fix. |
| `account list` refuses `--environment`; an SSH host has no Orca CLI (Orca reaches it through a relay). | No remote rate limits through Orca. |
| Orca has no file-transfer verb; Orca's SSH connection doesn't mean pacer's `ssh <alias>` works. | The bundle fallback needs an explicit SSH alias. |
| Commits made on the host carry the host's git identity. | Identity is checked on the host before anything leaves it. |

## Concepts

- **Host**: a machine runners execute on: this machine, an Orca SSH target, or a paired Orca server. Defined in the accounts design; this design makes `@host` work.
- **Host alias**: the `<host>` part of a runner id, a name the user declares in the strategy's `hosts:` table and maps to an Orca host.
- **Remote checkout**: a clone of the task's repository on the host, registered with Orca as a setup of the same Orca project as the local repo.
- **Transfer mode**: how a finished task's commits reach this machine: `push` (default) or `bundle`.
- **Task branch**: `pacer/<task-id>`. It's the only branch pacer creates on a host and the only ref it ever pushes.

The account stays the budget and stays global: `codex#team` and `codex#team@vudesktop` draw on one budget. Pacing, limits and exhaustion are charged to the account.

## How `@host` resolves

The grammar doesn't change: `<agent>[#<account>][@<host>]`, each part `[a-z0-9][a-z0-9-]*`.

1. `@local`, or no `@host`, means this machine. `local` is reserved and normalized away, so `codex@local` and `codex` are the same runner.
2. Otherwise `<host>` must be a key in the strategy's `hosts:` table. Unknown aliases are refused with the aliases that exist and a hint (`pacer host add`).
3. The entry's `orca:` field names the Orca host:
   - an SSH target id (`ssh-<…>`),
   - an exact SSH target name from `orca host list`,
   - or `env:<name>` for a paired server from `orca environment list`.

   pacer resolves it with `orca host list --json` at use time, so a renamed host still works by id. A name matching two targets is refused.
4. `pacer host add` suggests the alias as a slug of the Orca name (`Home/Server` → `home-server`), and the user can choose another. No implicit slugging happens at resolve time: an id only means what the strategy says.

## Strategy format additions

```yaml
hosts:
  vudesktop:
    orca: ssh-<id>               # SSH target id or exact name, or env:<paired server name>
    transfer: push               # push (default) | bundle
    ssh: vudesktop-ssh           # bundle only: an ssh alias pacer can use non-interactively
    acceptance: local            # local (default) | host
    max_tasks: 2                 # optional, concurrent tasks on this host (default 2)
    repos:                       # optional overrides; normally discovered from Orca project setups
      github.com/lamtuanvu/pacer: ~/src/pacer

runners:
  codex#team@vudesktop: {}       # a runner exists when its id appears here, in planner or in routing (as today)

routing: [ { default: [codex#team, codex#team@vudesktop, cursor] } ]
pacing:  { order: [codex#team, codex#team@vudesktop, cursor] }
```

Rules:

- A runner id with `@<alias>` is valid only when the alias is in `hosts:` and its agent is one Orca can launch on that host. The agent/account table from the accounts design applies unchanged.
- **Accounts on a host**: the remote agent uses whatever login that host has for it. The account part of the id is a claim pacer can't check by reading credentials, so `pacer host check` compares it the only safe way it can: the rate-limit window identity (`resets_at` and window length) from the host's latest usage snapshot against the account's. A mismatch is a warning.
  - pacer-managed `home:` folders and `orca_account:` don't carry over: those paths are on this machine.
  - A remote runner on a non-default account needs `hosts.<alias>.accounts.<account>.home: <path on the host>`, which pacer passes as `CLAUDE_CONFIG_DIR` / `CODEX_HOME` the same way as locally.
  - Until the host-side environment is verified, only the host's default login is allowed (see Questions).
- The planner can't be remote (`planner: claude-code@x` is refused).
- **Repository mapping**: pacer finds the remote checkout from Orca. It takes the local repo's Orca project id (`orca project list`, matched by `gitRemoteIdentity`), then that project's setup on the host (`orca project setups --project <id> --host <selector>`). `repos:` only overrides the path, keyed by the remote's canonical key (`github.com/<owner>/<repo>`). No mapping means the runner is excluded for that task.

## Placement

A remote runner is eligible for a task only when all of these hold. Otherwise it is excluded with the reason, which `pacer route` shows:

| Check | Exclusion reason |
|---|---|
| Orca runtime ready and the host `connected` (SSH) or reachable (`orca host name --environment`) | `host vudesktop offline` |
| The task's repo has a setup on that host | `repo not set up on vudesktop (pacer host setup vudesktop)` |
| Placement resolves to `new`. Remote never uses `current` and never sees local uncommitted work. | `remote runners need a new worktree` |
| The base commit is reachable by the host: for `push`, the base branch is published (local `<base>` equals `origin/<base>`); for `bundle`, it is sent with the task | `base main has unpushed commits; push it or use a local runner` |
| Host below `max_tasks` | `vudesktop busy (2/2)` |

A task's brief that asks for `--worktree current` is never routed remote, even with `--executor codex@vudesktop`. That combination is refused with the reason.

Start sequence (SSH target):

1. **Prepare the checkout**: in a short-lived Orca terminal in the remote checkout, run `git fetch origin <base>` (push mode) or receive the base bundle (bundle mode), then `git rev-parse <base sha>^{commit}`. This is one fixed, quoted command; brief text never goes into it.
2. **Create the worktree**: `orca worktree create --repo id:<remote repo id> --name pacer-<task-id>-<runner> --base-branch <base sha> --setup <repo policy> --no-parent`. Name the branch `pacer/<task-id>`, or rename it in step 1's terminal.
3. **Start the worker**: `orca orchestration worker-start --spec <prompt> --agent <agent> [--model …] --worktree id:<exact id> --run <run> --from <coordinator>`. That's the current `workerStartArgs` with an `existing` placement.

Paired server: steps 1 and 2 collapse into `worker-start --on <env> --worktree new-top-level --repo <exact remote repo> --name … --base-branch <sha> …`, after the same base check through a terminal on that server. Untested; built after the SSH path, and gated on a spike against a paired server.

The worker prompt (`buildPrompt`) adds remote-specific lines:

- Work only on `pacer/<task-id>` and commit there.
- Don't push, don't change git config, don't touch other branches.
- Report `worker_done` with the final sha.

pacer does the push itself (next section).

## Code transfer

After `worker_done` (or a settled worker with commits), pacer collects the result through a short-lived Orca terminal in the task worktree on the host. It runs fixed commands only.

**Pre-flight on the host** (both modes). Refuse to transfer and report, leaving the remote branch in place, when:

- `pacer/<task-id>` isn't a descendant of the base sha.
- The worktree has uncommitted changes. They're listed, and the worker is asked once to commit them while it's still alive.
- Any commit in `<base>..pacer/<task-id>` has an author or committer email, or a `Signed-off-by`, that isn't the **local repo's `user.email`**.
  - The fix: `pacer host setup` sets the remote checkout's repo-local `user.name`/`user.email` to the local repo's values, with confirmation, so agents commit with the right identity from the start.
  - Option: `transfer_identity: rewrite` lets pacer amend the task branch's commits to the local identity before transfer. That's safe because the branch is pacer's own.
- The range is empty (nothing to review; status `failed` with "no commits").
- The range is over 50 MB or 500 commits (a guard against runaway output).

**push** (default):

1. On the host: `git push origin pacer/<task-id>:refs/heads/pacer/<task-id>`, with no force, no tags and no other refspec, using the host's own git credentials.
2. Locally: `git fetch origin refs/heads/pacer/<task-id>:refs/heads/pacer/<task-id>`. Then add a local worktree for that branch (same location as a local `new` task), where `verifyRepo` and the acceptance command run.
3. After `pacer review --accept|--reject`, pacer deletes the remote `pacer/<task-id>` branch, unless `hosts.<alias>.keep_branches: true`. The local branch stays for the planner to merge or drop.

Push mode publishes the task branch on the shared remote for the duration of the review. For public repositories that is a real publication: `pacer host add` asks once per host and repository, and records `push_ok: [<canonical key>]`. Without it, push mode refuses for that repository and suggests `bundle`.

**bundle** (no shared remote, or one the user doesn't want task branches on):

1. Base: when the host lacks the base commit, pacer sends it. That's `git bundle create` locally for `<host's newest common commit>..<base>`, or the whole branch the first time, copied with `scp` through the configured `ssh:` alias and fetched on the host into `refs/pacer/base/<task-id>`.
2. Result: on the host, `git bundle create <tmp> <base sha>..pacer/<task-id>`, then pacer copies it back with `scp`. Locally, `git bundle verify` and `git fetch <bundle> pacer/<task-id>:refs/heads/pacer/<task-id>`. The temporary bundles are deleted on both ends.
3. `ssh:` must work non-interactively (`ssh -o BatchMode=yes <alias> true`). `pacer host check` tests it. Orca's own connection is no evidence: in the spike, Orca was connected while `ssh vudesktop` was refused.

**pacer refuses to**:

- push any ref other than `pacer/<task-id>`, force-push, or push tags;
- push or fetch anything before the pre-flight passes;
- write into the user's local branches other than creating `pacer/<task-id>`;
- copy files outside git (no rsync of working trees, no copying untracked files);
- transfer through a channel other than git push/fetch and git bundles;
- run without a transfer path: no shared remote and no working `ssh:` alias means the runner is excluded, not run hoping to fetch later.

## Lifecycle via dispatch ids

pacer's runner process stays local, so `pacer wait`, `pacer stop`, `taskStatus` (runner pid checks) and the task store work as today. Changes inside the Orca backend:

| Today | Remote |
|---|---|
| Waits for `worker_done` via `check --wait` on the coordinator | Unchanged (verified). |
| Reads `worker-read … terminal.tail` for limit, idle and busy detection | Reads with `--source terminal` when the worker has a terminal; otherwise takes the last N transcript messages as the tail. The same fix applies locally if local workers also default to the transcript. |
| Nudges and resends with `terminal send --terminal <agent handle>` | SSH target: unchanged (the handle belongs to the local runtime). Paired server: `orchestration send --to dispatch:<id>`; terminal verbs are never used. |
| `worker-stop` / `worker-release` by dispatch | Unchanged. |
| Records `{dispatchId, taskId, executor, worktree, terminal}` in `orca.json` | Adds `host` (alias and Orca host id) and `remoteWorktree` (Orca worktree id). `pacer orca status` lists workers with `worker-list --run <run> --include-remote`. |
| Readiness failure detection: `/agent[ _-]?launch/` | Also `agent_readiness`, with `lastError` (e.g. `agent-update-prompt`) → broken runner with "the agent on vudesktop shows a startup prompt; run `codex` there once (update or dismiss) and retry". |

**`unverifiable`** (connection lost, relay gone, timeout):

- The task stays `running`, with the report line "lost contact with vudesktop at 14:02; the worker may still be running there". pacer keeps polling `worker-show` on the normal slice.
- If the host comes back and the worker settled or sent `worker_done`, the task continues normally: transfer, verify, finish.
- If the task's deadline passes while unverifiable, the task finishes `failed` with `remote: {state: "unverifiable", dispatchId, host}`. The worker is **not** retried on another runner, the same rule as `uncertainStart` today, because a second run could duplicate work. The planner decides: `pacer stop` (pacer records a pending `worker-stop` and sends it when the host returns), or `pacer delegate --retry-of`.
- `exited` without `worker_done` maps like today's `settled`.

**`pacer stop`** on a remote task sets `stopped` (as today). The runner sees it, calls `worker-stop --dispatch`, and if that is unverifiable records it as pending in `orca.json`. Any later pacer command that touches Orca retries pending stops.

**Logs**: the task log holds the worker log lines plus the transcript tail, as today. `pacer task log <id>` can fetch more with `worker-read --dispatch --source transcript`, by dispatch, after release (the transcript is archived on release).

**Cleanup**: after transfer, pacer does `worker-release` and then `orca worktree rm --worktree id:<remote worktree>`, but only when the transfer succeeded or the task was rejected. On any failure the remote worktree stays for inspection, and `pacer host clean <alias>` lists and removes leftover `pacer-*` worktrees.

## Usage for remote runners

The account is global, so a remote runner's usage is its account's usage. What changes is where pacer learns it.

1. **Snapshots from any host, freshest wins.** Claude's and Codex's windows are account-wide, so a snapshot taken on any machine is valid for all of them. When the account is also used locally, today's readers already give a current number (the spike: the same `resets_at` on both machines). Usage readers return `capturedAt`, and pacer keeps the newest per account.
2. **Reactive tracking for remote-only accounts (v1).** A limit seen in a remote worker's output exhausts the **account** until its reset, everywhere, like `markExhausted` today but keyed by account. An account used only remotely shows `usage: reactive (remote)` in status until a snapshot exists.
3. **Host probe (v2, optional).** After each remote task, still in the task worktree's short-lived terminal, pacer runs a fixed read-only command. It prints the last `rate_limits` line of the newest Codex session file, or the agent's own status output. That gives a snapshot with `capturedAt`. No files are copied and credentials are never read.
4. **Orca upstream.** If Orca adds `account list` for a paired server or an SSH host, `usage_source: orca` uses it and the probe is dropped.

Remote hosts never get pacer's status-line hook: there is no pacer on the host.

## Prerequisites on the host

| Needed | Checked by `pacer host check <alias>` |
|---|---|
| Orca can reach it (SSH target `connected`, or a paired server) | `orca host list` |
| git ≥ 2.30 | short-lived terminal: `git --version` |
| The agent CLI, logged in, on the **login-shell** PATH | `command -v codex` in an Orca terminal (Orca terminals use the login shell) |
| The agent starts with no interactive prompt: current version, folder trusted, no update menu | a dry start: `worker-start` with a no-op spec in a scratch worktree, released at once; or the version compared with the local one |
| The remote checkout, registered with Orca | `orca project setups --host …` |
| push mode: credentials that can push `pacer/*` to the shared remote | `git push --dry-run origin HEAD:refs/heads/pacer/check` |
| bundle mode: a non-interactive `ssh:` alias | `ssh -o BatchMode=yes <alias> true` |
| The repo-local git identity equals the local repo's | `git config user.email` in the checkout |

**Not needed**: pacer, Bun, or the Orca CLI on the host.

- Supervision, verification and review stay local.
- Acceptance runs locally on the fetched branch by default. `acceptance: host` runs it in the remote worktree through a short-lived terminal and records the result as "ran on vudesktop". It's useful when the toolchain only exists there. It runs after the worker has finished, before transfer.
- The executor role is enforced by the brief's instructions. Nested delegation is impossible without pacer on the host.

`pacer host setup <alias> [--repo <local repo>]` walks through the checkout. It can't clone through Orca onto an SSH target, so it:

- prints the clone command to run on the host;
- or, with a working `ssh:` alias and the user's confirmation, runs that clone itself.

Then it runs `orca project setup-existing-folder`, sets the repo-local identity (confirmed), and runs `pacer host check`.

## Failure modes

| Failure | Behaviour |
|---|---|
| Host offline at routing time | Runner excluded (`host … offline`); routing falls to the next runner. |
| Host goes offline mid-task | `unverifiable`: wait, no retry elsewhere, `failed` at deadline with the dispatch id (above). |
| Agent startup prompt (update, trust) | Dispatch fails at `agent_readiness` → broken runner for that host with the exact fix; next runner tried. |
| Agent not logged in on the host | Broken runner (existing `brokenReason` heuristics on output); fix shown. |
| Account mismatch (host logged into a different account) | `pacer host check` warns; at run time, limits are charged to the account in the id (documented risk). |
| Base not published (push) | Runner excluded before start. |
| Pre-flight refuses transfer (identity, ancestry, size) | Task `partial` with the reason; the remote branch and worktree are kept; `pacer host clean` removes them later. |
| Push rejected (no credentials, protected namespace) | Task `partial`, "push of pacer/<id> from vudesktop failed: …"; the remote worktree is kept. |
| Fetch or bundle verify fails | Task `partial`; nothing written to local branches; the bundle is kept in `<pacerHome>/tasks/<id>.bundle` for inspection. |
| Limit hit remotely | Account exhausted globally; next runner tried (existing loop). |
| Orca too old or missing a capability (no `--include-remote`, no transcript source) | Remote runners excluded with "needs Orca ≥ <version>"; local runners unaffected. |
| Two tasks on the same host and repo | Separate worktrees and branches; `max_tasks` caps concurrency. |

## Security

- **No credentials copied between machines.** pacer never reads, copies or forwards auth files, keychains, tokens, SSH keys or `gh` credentials, on either machine. Remote agents and git use the host's own logins. Host config paths in `hosts.<alias>.accounts` are only passed as environment variables, as locally.
- **Nothing pushed without the task's explicit branch.** The only push is `pacer/<task-id>` from the task's worktree, after the pre-flight, without force or tags, and only for repositories in `push_ok`. pacer never pushes from this machine on the remote runner's behalf.
- **Identity.** Commits that leave the host must carry the local repo's identity. This keeps personal or machine emails out of public repositories, and it's what the DCO check expects.
- **Fixed commands only.** Every command pacer runs on a host is a template with quoted arguments (task id, sha, branch, paths from Orca). Brief text goes only into the worker spec, never into a shell command.
- **Briefs leave the machine.** The brief and prompt are stored in the local Orca Run and shown in the host's agent session. The `delegate` docs say so: don't put secrets in briefs.
- **Bundles** are verified before fetch, fetched into `pacer/<task-id>` only, and deleted afterwards. `scp` uses the user's own SSH alias; pacer adds no keys and no host entries.
- **Records** keep the host alias and Orca host id, never emails, usernames from git config, or remote paths in anything published (the dashboard and panel show the alias).

## Implementation outline (for the plan, not decided here)

1. Host model: `hosts:` parsing and validation, `@host` resolution, routing exclusions, and the `pacer host add|list|check|setup|clean` commands.
2. Orca client additions:
   - `hostList`, `projectSetups`, `worktreeCreate` on a host, `worktreeRm`;
   - `workerList --include-remote`;
   - `workerRead --source`;
   - short-lived command terminals with output capture.
3. Remote placement in the Orca backend (SSH target first) and the readiness-failure mapping.
4. Transfer: pre-flight, push mode, local worktree from the fetched branch; then bundle mode.
5. Lifecycle: the `unverifiable` handling, pending stops, cleanup.
6. Usage: account-keyed exhaustion and freshest-snapshot merge; the host probe later.
7. Paired-server placement after a spike against a paired server.

## Testing

- Strategy: `hosts:` validation (unknown alias, `local` reserved, `env:` form, an ambiguous name refused), runner ids with `@alias`, a remote planner refused, `push_ok` required for push.
- Resolution against recorded `orca host list` / `project setups` output, with fixtures from the spike scrubbed to `$HOME` paths.
- Routing exclusions: offline host, missing setup, `current` placement, unpublished base, `max_tasks`.
- Orca backend with recorded receipts:
  - worktree create plus worker-start on an exact remote id;
  - the `agent_readiness` failure → broken runner;
  - `worker_done` → transfer;
  - `unverifiable` → task kept running, then failed at the deadline with no retry;
  - a pending stop sent on reconnect;
  - `worker-read` transcript parsing.
- Transfer with real git in temp dirs (a bare repo stands in for the shared remote, a second clone stands in for the host):
  - pre-flight refusals: foreign identity, non-descendant, empty, oversized, dirty;
  - push of only `pacer/<id>`;
  - bundle round-trip;
  - local branches untouched.
- Command templates: brief text with quotes, `$()` and newlines never reaches a shell.
- Usage: freshest-snapshot merge across sources; account-keyed exhaustion affects local and remote runners of the account.
- Real run (manual, documented): `codex@vudesktop` task end to end in push mode, then in bundle mode, then with the SSH connection dropped mid-task.

## Questions for the owner

1. **Push on a public repo.** Is a temporary `pacer/<task-id>` branch on github.com/lamtuanvu/pacer acceptable (deleted after review), or should pacer's own repo default to `bundle`?
2. **Identity on the host.** May `pacer host setup` set the remote checkout's repo-local `user.name`/`user.email` (to the noreply identity)? Or should pacer rewrite the task branch's commits before transfer (`transfer_identity: rewrite`)? Or both?
3. **Non-default accounts on a host.** Allow `hosts.<alias>.accounts.<account>.home` in v1, or only the host's default login until it's verified on a host?
4. **Acceptance.** Is local acceptance as the default right, with `acceptance: host` as the opt-in?
5. **Usage.** Reactive-only for remote-only accounts in v1, with the host probe later? Or build the probe now?
6. **Paired servers.** Worth pairing one machine (`orca serve` plus `environment add`) for a second spike before building, or SSH targets only for the first release?
7. **Upstream issues.** May I open `upstream: orca` issues for the limitations found (setup-clone on SSH, remote `account list`, startup prompts blocking dispatch, worktree creation via `worker-start` on SSH repos, no file transfer) and link them from #17?
