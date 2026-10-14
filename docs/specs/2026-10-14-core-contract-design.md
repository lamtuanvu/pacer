# pacer core: one product contract, any client

Status: decisions recorded 2026-10-14 (see Decisions); ready for the phase 1 implementation plan. Nothing is built. This comes before new clients and before remote runners are implemented.

## Vision

pacer's value is deciding **who works on what, within which budget**, and keeping that true while work runs. That rests on four core capabilities, which pacer owns end to end:

1. **Executor control**: start, supervise, stop and retry an agent on a task, in an isolated worktree, on this machine or another.
2. **Progress tracking**: know, while a task runs, that it is alive, what it is doing and what it has changed; know how it ended and why.
3. **Provider limits**: know each account's usage and resets from sources pacer reads itself. This is the core value; it must not depend on another product.
4. **Remote host control**: the same three capabilities on a machine reached over SSH.

Everything else is a **client** of one versioned contract: the CLI, the planner's MCP tools, the terminal dashboard, the Orca plugin, a future VS Code / Open VSX extension, a pacer desktop app. No client gets a capability the contract doesn't have, and the core has no client-specific code.

Success:

- With Orca absent, every capability works, including isolation, live progress and limits.
- Every operation is available on every surface that needs it, with the same semantics.
- A new client can be built from the protocol document alone.

## What exists today (inventory, 2026-10-14)

| Area | Today | Gap |
|---|---|---|
| Operations | delegate, status, route, wait, stop, review, dismiss, retry, block/unblock, report-limit, strategy ops, spread across CLI, MCP and console | Uneven coverage: retry only in the console; MCP has no dismiss or block; dismiss in the console bypasses `taskDismiss`; HTTP has no task operations |
| Executor control | Direct backend: headless agent CLIs (`launchFor`), timeout, kill tree, broken detection. Orca backend: supervised Orca workers in Orca worktrees | Without Orca: **no worktree isolation** (a `new` placement is downgraded to running in place) |
| Progress | Orca backend: `worker_done`, a 40-line tail, idle and busy heuristics. Direct backend: **output in memory, log written once at exit** | No live log, no progress signal, nothing written to the task record until the attempt ends |
| Limits | Claude: status-line cache (only while an interactive Claude session renders its status line). Codex: session logs. BytePlus: `arkcli`. Metered: `opencode stats`. Cursor/agy: reactive only | Codex snapshots never marked stale; `stale` ignored by verdicts; Claude **executors** (`claude -p`) produce no usage data; no per-account or per-host model yet (accounts branch) |
| Client protocol | Envelopes `{v:1, type: budget\|task\|mode\|alert}`. Commands typed into a console's stdin as `: pacer '<json>'`. Output via an outbox file, a `latest.json` snapshot, Orca plugin storage, and `orca plugin send`. `pacer serve`: localhost HTTP with token (`/state`, `/link`, `/events` SSE), read-only | Stdin injection as the only command path; three outbound transports, two Orca-specific; no protocol document; MCP version hardcoded |
| Coupling | No runtime breakage without Orca | `dashboard/model.ts` imports the Orca plugin's source; Orca modules host shared helpers (`withLock`, `gitInfo`); executor-role detection relies on an Orca workspace path |
| Accounts branch (`feat/accounts-0.1.23`) | Decision 2: Orca's `account list` rate limits are the default usage source when Orca is present | **Conflicts with this vision.** See Provider limits. |

## Architecture

```
            clients:  CLI · MCP (planner) · dashboard · Orca plugin · VS Code ext · desktop app
                         │          │            │            │             │
   transports:      argv/stdout   MCP stdio   ── pacer API: HTTP + SSE (localhost), or JSON-RPC over stdio ──
                         └──────────┴────────────┴────────┬───┴─────────────┘
   core API:          one operation set + one event stream, typed and versioned (src/core/api)
                                                  │
   core services:   Tasks (store, runner) · Supervisor (local + SSH hosts) · Progress · Limits · Hosts · Strategy
                                                  │
   adapters:        agent adapters (claude-code, codex, cursor, agy, opencode) · optional Orca executor backend
```

- **One operation set.** The CLI, MCP and the API are thin layers over `src/core/api`. Adding an operation means adding it there; each surface then decides only presentation.
- **One event stream.** The core emits typed events (task, progress, budget, alert, host). Every client view (dashboard, panel, extension) is a projection of that stream plus a snapshot.
- **Process model.** `pacer serve` (already a launchd/systemd service) becomes the **pacer daemon**: it owns the supervisor, the polling of limits and hosts, and the API. CLI and MCP calls work without the daemon (direct calls into the core, as today) and use it when running, so nothing requires a long-lived process to be installed.
- **Clients own nothing.** No client writes pacer state files, and none runs agent CLIs or reads provider data on its own.

## 1. Executor control

**Agent adapter**: one module per agent, replacing the switch in `launchFor`. It provides:

| Member | Purpose |
|---|---|
| `launch(task, worktree, account, host)` | argv, env (account folder, `PACER_ROLE=executor`), stdin, output files; always headless |
| `events(stream)` | parses the agent's machine-readable output into progress events (below); falls back to plain lines |
| `outcome(exit, output)` | done / failed / limit / broken / transient, plus the report text |
| `usage(output)` | any rate-limit information the agent prints or logs during the run (feeds Limits) |
| `preflight(host)` | version, logged-in check, known startup prompts |

**Isolation without Orca**:
- pacer creates the worktree itself: `git worktree add -b pacer/<task-id> <pacerHome>/worktrees/<repo>/<task-id> <base>`.
- The same rules as today decide `current` vs `new`.
- The worktree is removed after review (accept or reject), or by `pacer clean`.
- This fixes the "new placement downgraded" gap, and it's what remote hosts do too.

**Supervisor**: one model on every host. The SSH spike verified it on Linux:
- Each attempt runs under a small wrapper in its own session. The wrapper writes `pid`, `started`, `log` (appended live), and `exit` into the attempt's folder.
- A local attempt uses `<pacerHome>/runs/<task-id>/<n>/`; a remote one uses the same layout under the host's pacer folder.
- Stop sends TERM to the process group, then KILL after a grace period; the exit code is recorded.
- The task runner (local `pacer _run`) polls the folder. Because the files are the record, a pacer restart or a dropped SSH connection never invents an outcome.
- This replaces in-memory collection in `execProcess`. The direct backend becomes "supervisor on host `local`".

**Operations** (all in the core API; every client surface gets the ones it needs):

| Operation | Notes |
|---|---|
| `delegate(brief, {kind, runner, placement, timeout, force})` | as today; the runner may be `agent#account@host` |
| `task.get`, `task.list(filter)` | |
| `task.wait(id, timeout)` | |
| `task.stop(id)` | local and remote, pending when unreachable |
| `task.retry(id, {runner?})` | moves from console-only into the core |
| `task.review(id, accept\|reject, {kind, note})` | |
| `task.dismiss(ids)` | one implementation |
| `task.log(id, {from, follow})` | streamed |
| `task.diff(id)` | base..`pacer/<task-id>`, for review in any client |
| `runner.list`, `runner.block/unblock(id, until?)`, `route(kind)` | |
| `limits.status`, `limits.report(account, until)` | report-limit, account-keyed |
| `host.list/check/add/remove` | see section 4 |
| `strategy.*`, `config.get/set` | as designed on the accounts branch |

Agents (MCP) keep a deliberately small subset: delegate, task get/wait/stop/review/log/diff, route, limits.status, report-limit.

## 2. Progress tracking

A task reports progress **while it runs**, from three sources merged by the Progress service:

| Source | Gives | How |
|---|---|---|
| Supervisor files | alive or exited, exit code, log size, last output time | poll the attempt folder every 2 s locally, every 10 s per remote host |
| Agent structured output | steps, tool calls, files touched, final message, token or limit notices | agents' JSON output modes, parsed by the adapter. Flags to verify per agent: `codex exec --json`, `claude -p --output-format stream-json`, `cursor-agent --output-format stream-json`, `opencode run` JSON. Fallback: plain lines |
| Worktree | files changed, commits so far | `git status --porcelain` / `rev-list --count base..HEAD` in the task worktree, every 30 s |

**Progress record**: stored on the task and emitted as `task.progress` events:

```ts
interface Progress {
  phase: "starting" | "working" | "idle" | "finishing" | "lost-contact";
  lastOutputAt: number; lastEventAt: number;
  step?: string;              // latest adapter-parsed step, clipped to 200 chars
  files: number; commits: number;
  host: string;               // "local" or the host alias
  logBytes: number;
}
```

- **Idle**: no output and no worktree change for `idle_after` (default 10 min) → phase `idle`, alert. After `idle_fail` (default 30 min) the task is stopped as `failed: idle`. This replaces the Orca-only idle nudge. Headless agents can't be nudged, so pacer stops them instead.
- **Lost contact** (remote only): host unreachable → phase `lost-contact`. No outcome is invented. At the deadline the task becomes `failed` with `lostContact: true`, and it is never automatically retried elsewhere.
- **Outcome detection**: exit code plus the adapter's `outcome()`, then the existing limit/broken/transient classifiers, then verification (files plus acceptance) as today.
- **Logs**: the attempt log is appended live. `task.log --follow` streams it, and every client shows the same text.

## 3. Provider limits (pacer-owned)

**Principle**: pacer reads usage from sources it controls: the agent's own outputs and local files, pacer's own hooks, and providers' own interfaces, chosen per provider. Other products (Orca included) are never a usage source. The accounts branch's decision 2 (`usage_source: orca` by default) is **withdrawn** (owner, 2026-10-14). Orca-managed accounts get usage from pacer's own readers, or reactively.

**Data model** (one shape for every reader):

```ts
interface Snapshot {
  account: string; host: string;            // where it was observed
  windows: { kind: "5h" | "weekly" | "monthly" | "limit"; usedPct: number; resetsAt: number | null }[];
  capturedAt: number;                       // when the provider reported it, not when pacer read it
  source: "status-line" | "session-log" | "agent-output" | "provider-cli" | "provider-api" | "metered" | "reactive";
}
```

- Snapshots are kept per account, and the **freshest wins** across sources and hosts (account windows are global; the spike confirmed identical `resets_at` on two machines).
- **Staleness is uniform**:
  - A snapshot older than `stale_after` (default: 2 h for 5-hour windows, 24 h for weekly) is marked `stale`.
  - The verdict then degrades. `ON_PACE` becomes `UNKNOWN` unless a reactive mark exists, and routing treats `UNKNOWN` per policy (`pacing.unknown: allow | last`).
  - This fixes Codex snapshots never going stale, and `stale` being ignored by verdicts.
- **Reactive marks** (limit errors seen in output, `report-limit`) are account-keyed. They override snapshots until the reset.

**Sources per provider.** Each row is a ladder: pacer uses the highest rung that works.

| Provider | Rung 1 (passive, verified) | Rung 2 (passive, to verify) | Rung 3 (active, needs a decision) | Floor |
|---|---|---|---|---|
| Claude subscription | status-line input captured by pacer's hook (planner sessions) | rate-limit information in `claude -p --output-format stream-json` output from executor runs | Anthropic's usage endpoint for the logged-in account | reactive |
| Codex / ChatGPT | `rate_limits` in `~/.codex/sessions` rollouts (local and over SSH, verified) | rate limits in `codex exec --json` events | — | reactive |
| Cursor | — | anything `cursor-agent` prints about usage | Cursor's usage interface | reactive (today) |
| Antigravity / Gemini | — | CLI status output | provider interface | reactive |
| BytePlus | `arkcli usage plan` (verified) | | | reactive |
| OpenCode endpoints | `opencode stats` metered budget (verified) | | | unmetered / reactive |

**Rung 3: decided provider by provider (owner, 2026-10-14).** Passive rungs are the default for every provider. Rung 3 (the provider's usage interface, called with the agent's stored login) is enabled **per provider** only when the passive data proves insufficient, under these rules:

- It is opt-in per account: `accounts.<name>.usage_api: true`. It is off by default, and `pacer limits check` says when an account would benefit.
- Credentials are read only at call time, in memory, from the agent's own store. They are never written, cached, logged or sent anywhere but the provider.
- pacer uses only interfaces the provider documents or that its own CLI calls for the same purpose. Each provider's rung 3 gets its own small design note before it is built, recording the endpoint, the auth location, the polling interval (no faster than every 5 minutes) and the failure behaviour.
- A failing rung 3 falls back to the passive rungs, then reactive; it never blocks routing.
- In parallel, agent vendors are asked for a "print usage" command (option c). Where one exists, it replaces rung 3 for that provider.

**Verification matrix**: a fixture test per reader and per rung, plus a manual `pacer limits check` command. It shows each account's source, `capturedAt`, staleness and the rung used, so wrong numbers are visible.

## 4. Remote host control

Over **SSH, owned by pacer** (spike 2026-10-14, part 2: detach, disconnect survival, live log mirroring, stop, identity and bundle transfer verified with a shell workload; headless agent launch pending the owner's permission).

- `@host` resolves through a `hosts:` table: alias → SSH alias (must work with `BatchMode=yes`), plus checkout paths, transfer mode (`push` | `bundle`) and `max_tasks`. The runner-id grammar is unchanged.
- The same supervisor, adapters and worktree layout as locally. Commands run through `ssh <alias> bash -lc <fixed template>`, and the brief goes over stdin, never into a shell command.
- Results come back as `pacer/<task-id>`: pushed from the host or streamed as a git bundle over SSH stdout. The host-side checks first: ancestry, commit identity matching the local repo's, size.
- Limits: the Codex session-log probe over SSH. Claude on a host is reactive-only until rung 2 is verified.
- Host prerequisites: git, a logged-in agent CLI that runs headless without prompts, and an SSH alias. Not pacer.

`docs/specs/2026-10-14-remote-runners-design.md` (the Orca-based version) is superseded by this section for placement, lifecycle and usage; its transfer, security and failure-mode sections carry over. It will be rewritten on top of this contract.

## 5. Client protocol (v2)

**Transport**:
- **HTTP + SSE on localhost**, from the daemon. This extends today's `pacer serve`, with token auth.
- **JSON-RPC over stdio** (`pacer api --stdio`) for clients that would rather spawn pacer than find a daemon, such as an editor extension.
- Both carry identical messages.

| Endpoint / method | Purpose |
|---|---|
| `GET /v2/hello` · `hello` | protocol version (semver), pacer version, capabilities list |
| `GET /v2/snapshot` · `snapshot` | budget, runners, tasks (recent N), hosts, mode, alerts, strategy summary; with `seq` |
| `GET /v2/events?since=<seq>` (SSE) · `subscribe` | typed events with `seq`; resume with `Last-Event-ID`; a gap triggers a snapshot |
| `POST /v2/ops/<operation>` · `<operation>` | any operation from section 1, same names, JSON in and out, typed errors `{code, message, hint}` |
| `GET /v2/tasks/<id>/log?follow=1` | streamed log |
| `GET /v2/tasks/<id>/diff` | unified diff for review |

**Events**: `budget`, `task` (state changes), `task.progress`, `task.log` (only when subscribed per task), `alert` (with notification kind, as today), `host`, `strategy`, `mode`.

**Rules**:
- **Versioning**: semver for the protocol. Additive fields don't bump it. Clients ignore unknown fields and events. Removing or renaming anything bumps the major version, and the daemon serves the previous major for one minor release of pacer.
- The existing limits stay: clip lengths, 20 tasks in a snapshot by default, paginated `task.list`.
- **Retired after migration**:
  - stdin command injection (`: pacer '<json>'`);
  - the outbox/`latest.json` files as a client interface (the dashboard moves to the API);
  - Orca plugin storage and `orca plugin send` as transports.

  The Orca plugin becomes an ordinary API client.
- **Security**:
  - localhost only;
  - token file `0600`;
  - every operation validates its input in the core;
  - no operation runs free text in a shell (the existing fixed-command rule).
- **Protocol document**: `docs/protocol.md` is generated from the core API types, with JSON Schemas for every message. It is the only thing a client author needs.

## 6. Clients afterwards (out of scope here, listed for direction)

- **Dashboard (TUI)**: an API client. Its view model moves into core (`src/view-model`), removing the import of `orca-plugin/` sources.
- **Orca plugin**: a thin API client. The optional **Orca executor backend** stays as an adapter for users who want agents in visible Orca terminals. It is opt-in (`execution.backend: orca`) and never a usage source.
- **VS Code / Open VSX extension**: an API client providing:
  - a status-bar budget meter;
  - a tree of tasks and runners;
  - log follow;
  - review in the built-in diff view;
  - settings.
- **pacer desktop app**: a native desktop client in the spirit of VS Code or Orca (not a web UI), built on the same API over stdio or localhost. It has its own design spec; the technology (Electron, Tauri, …) is chosen there.

Client priority after the core (owner, 2026-10-14): dashboard (TUI), Orca plugin, VS Code / Open VSX extension, pacer desktop app. All four are wanted; the order is the build order.

## Migration (phases, each shippable)

1. **Core API extraction**: `src/core/api` with the operation set. CLI and MCP become thin layers over it. Retry, dismiss and block are consolidated. Shared helpers move out of `exec/orca`. Behaviour is unchanged.
2. **Supervisor + pacer-owned worktrees**: the direct backend gets isolation and live logs, and the progress record lands. `backend: auto` defaults to direct; Orca becomes opt-in.
3. **Limits service**: the snapshot model, uniform staleness, account-keyed reactive marks, `pacer limits check`, and rung-2 verification per agent. Reconcile with the accounts branch (withdraw decision 2).
4. **Protocol v2**: daemon endpoints and stdio JSON-RPC, the protocol doc, the dashboard moved to the API, the Orca plugin moved to the API. The old transports are retired one release later.
5. **Remote hosts over SSH** on top of 2–4: the rewritten remote-runners spec.
6. Clients, in order: dashboard on the API (part of phase 4), Orca plugin on the API (phase 4), VS Code / Open VSX extension, pacer desktop app.

Accounts (`feat/accounts-0.1.23`) lands before or alongside phase 3. Its runner ids, accounts and settings model are inputs to this contract.

## Testing

- Core API: every operation is tested once in the core, and each surface only gets a thin adapter test (argv mapping, MCP schema, HTTP status codes).
- Supervisor:
  - real processes in temp dirs: detach, live log, stop by group, exit recording;
  - a pacer restart mid-run picks the attempt up from its files;
  - SSH paths with a local `sshd` stand-in or recorded command fixtures.
- Progress: adapter parsers against recorded JSON output of each agent (fixtures under `test/fixtures/`, scrubbed); idle and lost-contact transitions with a fake clock.
- Limits: fixtures per source and rung; freshest-wins across sources and hosts; staleness thresholds; reactive override; verdict degradation.
- Protocol:
  - schema tests for every message;
  - SSE resume after a gap;
  - a golden "client from the doc" test, where a minimal client is built only from `docs/protocol.md`'s schemas and exercises snapshot, subscribe and one operation.
- No Orca: the full suite runs with `orca` absent from PATH.

## Decisions (2026-10-14)

1. **Limits: provider by provider.** Passive rungs by default for every provider. Rung 3 (provider usage interface with the agent's stored login) is opt-in per account, under the rules in section 3. Agent vendors are asked for a usage command in parallel.
2. **Accounts branch decision 2 withdrawn.** Orca's `account list` is not a usage source, not even by default when Orca is present. To be applied on `feat/accounts-0.1.23` before 0.1.23 ships.
3. **Daemon: works without, better with.** CLI and MCP call the core directly. `pacer serve` adds the API, live events and background polling.
4. **Orca executor backend: opt-in adapter.** The default is pacer's own supervisor. `execution.backend: orca` keeps agents in visible Orca terminals for those who want it. Orca is never a usage source.
5. **Headless agent verification: local runs approved** (one tiny task per installed agent on this Mac, in a scratch repo). Remote agent runs need a separate OK.
6. **Phase order 1→6 as listed.**
7. **Clients after the core**: dashboard (TUI), Orca plugin, VS Code / Open VSX extension, and a **pacer desktop app** (native, like VS Code or Orca; no web UI).
