# Assistant backends: pacer's own agent or an existing executor

Date: 2026-11-17. Status: approved by the maintainer on 2026-11-18, with the proposed answer to each decision below. Applies to:
- `src/plugins/protocol.ts` (`CAPABILITIES`), `src/plugins/host.ts` (turn-scoped capabilities), `src/plugins/ui-schema.ts` (`NOTIFICATIONS`), `src/plugins/registry.ts` (notification dispatch) and `docs/plugin-protocol*.{md,json}`
- `src/api/ops-assistant.ts`, `src/api/ops.ts`, `src/api/caller-policy.ts`, `src/serve/http.ts` and `src/core/work.ts` (the assistant grant), `docs/protocol*.md`
- `src/assistant/**`, `src/mcp/**`, `app/src/screens/settings/AssistantSettings.tsx`
- `src/config/accounts.ts` and `src/core/endpoints.ts` (`connection.api` values), with their tests
- `plugins/assistant` and `plugins/bundled.ts` (retired), and the new bundled plugins `assistant-pacer` and `assistant-executor`
- the new Rust plugin crate, `Cargo.toml` and `xtask/crates.toml`
- executor adapters that declare ask mode, starting with opencode
- `docs/assistant.md`, `test/assistant-*.test.ts`

Amends: [Always-on assistant](2026-10-28-always-on-assistant-design.md), sections "Where it runs", "Trust boundary" and "Which account, and how it is paced". Its data access, actions, history, client protocol and sheet are unchanged.
Builds on: [Assistant self-discovery](2026-11-17-assistant-self-discovery-design.md). Both backends use the assistant's current tool set: today's fixed tools, or the generic tools once that spec lands.
Decision record: [ADR 0028](../decisions/0028-assistant-backends.md), which supersedes D1 and D3 of the [assistant extension point ADR](../decisions/2026-10-28-assistant-extension-point.md).

## Problem

1. **Most accounts cannot answer.** The assistant accepts only endpoint accounts whose base URL and key pacer holds (`candidates()` in `src/assistant/service.ts`). An account with `source: opencode` cannot have a pacer connection (`src/config/accounts.ts`), and subscription accounts (Claude Code, Codex) have none. A user with four working opencode executors sees only "Off".
2. **The assistant duplicates executor plumbing.** Accounts, keys, model choice and pacing already exist for executors. The assistant re-implements a model client beside them.
3. **The interface fits only one kind of backend.** `assistant.respond` is one model call, and the host runs the loop. An agent CLI runs its own loop, so it cannot serve that method.

## Goals

1. **Two backends behind one interface.** `assistant-pacer` is pacer's own agent: fastest and cheapest, and it needs an API key pacer holds. `assistant-executor` runs an existing executor account in ask mode: slower, and it needs no extra setup.
2. **The host keeps the tools, the action cards, admission, history and accounting** whichever backend answers. Where a backend weakens a guarantee, this spec says which and how far (§7).
3. **Continuous conversations** on both backends, with a fallback when a session cannot be resumed.
4. **Fail closed.** An executor offers ask mode only after its adapter's self-test passes with recorded evidence.

Non-goals:
- Making `assistant-pacer` a coding executor. If it ever becomes an executor (open decision 4), it serves light, read-only kinds only.
- Moving a conversation between accounts or backends on its own. The user's choice stays fixed, as today.
- Installed (non-bundled) assistant backends. They wait for plugin sandboxing (M3), as today.
- Importing opencode's provider keys into pacer. That is a separate decision; this design lets those accounts answer without it.

## Design

### 1. One turn-level plugin method

The `assistant` extension point gains `assistant.reply` (additive, plugin protocol minor, P14). It is a plugin method, distinct from the existing client op `assistant.turn`, which reads a finished turn.

```
assistant.reply({
  conversationId, turnId,
  account, backend: "pacer" | "executor", model?,
  system,                                // host-built prompt
  digest,                                // see below
  tools: [{ name, description, parameters }],   // the current tool set, with propose_action
  history,                               // pacer's transcript, for backends without a live session
  message,                               // the user's new message
  session?,                              // the backend's resume handle from the last turn, if any
  limits: { maxInputTokens, maxOutputTokens, maxToolRounds, deadlineMs },
}) → { message, session?, usage: { input, output, cacheRead?, cacheWrite?, coverage } }
```

- **Digest.** A host-built summary of at most 2,000 tokens, produced through the same read pipeline as the tools: counts, attention items, the pacing mode and pause state, the chosen account's cached budget, and the task or repository in scope, if any. It lets most questions be answered without a tool round.
- **Streaming.** While a turn runs, the plugin may send `assistant.delta` notifications (`text`, or `activity` such as "Reading tasks…"). They are ephemeral, as in the always-on spec. Today `NOTIFICATIONS` (`src/plugins/ui-schema.ts`) admits only `ui.invalidate`, and the registry's dispatch also returns early for a plugin without UI surfaces, which both assistant plugins are. Phase 1 adds `assistant.delta` for the `assistant` point and gives it its own dispatch branch, ahead of the UI-surface check, that forwards it to the sheet's stream. A backend that cannot stream returns only the final message.
- **Cancellation** aborts the call. The plugin stops its model call or CLI turn and returns nothing.

`assistant.respond` stays until phase 4.

### 2. The host runs every tool

Both backends reach pacer's data only through the host, on one of two paths that end in the same function:

| Backend | Path | Credential |
|---|---|---|
| `assistant-pacer` | Plugin capability `capability.assistant.tool { turnId, name, params }` | The plugin's own manifest declaration (`assistant.tool`), accepted only for the `turnId` of a call in progress |
| `assistant-executor` | The CLI calls `pacer mcp --assistant`, which calls the new client op `assistant.tool { turnId, name, params }` | A per-turn assistant grant (§3) |

The function runs the assistant's read pipeline (permitted op, parameter parsing, scope, projection, redaction, size cap, `<data>` wrapping) and counts the call against `maxToolRounds`. `propose_action` goes through it too and becomes a card. A call after the turn has ended, for another `turnId`, or past `maxToolRounds` is refused.

**The assistant grant is its own identity.** Today every work-grant bearer is mapped to an executor session (`src/serve/http.ts`), which `src/api/ops.ts` refuses for every `assistant.*` op and which `authorizeWorkOperation` (`src/core/work.ts`) limits to dispatch and task ops. So the assistant grant cannot be a work grant used as is, and it must never be a credential that neither gate recognizes, because that would pass both.
- It has its own prefix, added to the HTTP credential gate that today accepts only work and enforcement tokens on `POST /v3/ops/`. The HTTP layer maps it to an **assistant-turn identity**: not the operator, not an executor, and without `PACER_ROLE`.
- `authorizeWorkOperation` gains a first branch for that identity: it allows `assistant.tool` only when the grant is live and the `turnId` matches, and refuses every other op. This branch fails closed: a request with an unrecognized or expired assistant grant is refused, never treated as the operator.
- The executor refusal in `ops.ts` and `caller-policy.ts` stays as it is. It does not apply to this identity, because it is not an executor session.

### 3. `assistant-executor`: an existing executor in ask mode

A bundled TypeScript plugin. It runs the chosen executor account's agent CLI with a restricted configuration that its adapter declares.

**Ask mode, declared by each adapter:**

| Part | Requirement |
|---|---|
| Tools | Only pacer's assistant MCP server. Every built-in tool is denied, including shell, edit, write, file read, search, list and web fetch |
| Configuration | No hooks, no other MCP servers, no project or user instruction files |
| Working directory | A fresh, empty directory under the service's `runs/assistant/`, never a repository or worktree |
| Environment | `PACER_HOME` set to that empty run directory, so neither the CLI nor the MCP server resolves the service token or the default home by default. `HOME` stays real, so this is not a barrier against a CLI that ignores its configuration (§7). No `PACER_ROLE` and no other `PACER_*` variables. The MCP server receives only the service address and the grant |
| Launch | A warm server where the CLI has one, otherwise one run per turn |
| Continuity | The CLI's own session, returned as `session` and resumed on the next turn |

**The per-turn grant** is issued by the host when a turn starts and revoked when it ends, is cancelled or reaches its deadline. It authorizes `assistant.tool` for that `turnId` only (open decision 5 covers its mechanism).

**Fail-closed self-test.** Ask mode is offered for an adapter only after a canary passes. The canary is a turn in ask mode that tells the model to run a shell command, read a planted file outside the run directory, and fetch a URL.
- **Evidence needed to pass:** the CLI's own event record (for opencode, the session's message parts) shows that the model attempted each action and that each attempt was denied, and no tool other than pacer's ran.
- **Claude Code evidence:** every turn (self-test and live) is driven by the host over the CLI's stream-json CONTROL protocol (`claude-control` spawn mode). After `initialize`, the host queries `mcp_status` and requires a connected `pacer` server with the expected tools; otherwise it continues digest-only for that turn and says so in the prompt. The stream-json `system`/`init` event must still show `mcp_servers` exactly `[{name:"pacer",status:"connected"}]`, `tools` exactly the host's `mcp__pacer__*` set (no built-ins), empty `slash_commands` / `skills`, and `plugins` only the allowlisted builtins (`agents-md@builtin`, `telemetry@builtin` at path `builtin`). The issued `permissionMode`, realpathed `cwd` and bare `claude_code_version` must match; success is recorded as `{tool:"claude:init",status:"pacer"}`. Every tool call is decided in host code via `can_use_tool` (allow only the exact issued `mcp__pacer__*` names; deny everything else with a reason). The self-test also requires a completed harmless `mcp__pacer__*` call (e.g. snapshot) while shell/read/webfetch are absent, refused, or `can_use_tool`-denied. Built-in `agents` names on init are ignored (unreachable without the Agent tool). A missing init, a wrong surface, a failed pacer MCP connect (unless digest-only), any hook lifecycle event (via `--include-hook-events`), or any non-pacer tool completion fails the turn. Cancel/deadline sends an `interrupt` control request, then SIGTERM/SIGKILL.
- **Inconclusive is a failure:** if the model attempts nothing, the canary repeats once with a direct instruction, and fails if it still attempts nothing.
- **Also watched:** no file is created or changed outside the run directory, and the planted file's contents never appear in the answer.
- **When it runs:** when the adapter or the CLI version changes, on both a first turn and a resumed turn.

**opencode first (ACP).** Each ask-mode turn runs host-pinned `opencode acp` (Agent Client Protocol over stdio, with `OPENCODE_CLIENT=acp` and `OPENCODE_ENABLE_QUESTION_TOOL=false`). The host builds the session: a `pacer-ask` agent with built-ins hidden by agent-permission deny, `tool.use` denied except `pacer_*`, and pacer's MCP server passed only in ACP `session/new` / `session/load` `mcpServers` (`pacer mcp --assistant`, grant only as env pairs—never argv or a config file). The host answers `session/request_permission` fail-closed: allow only when the tool identity is a pacer MCP tool **and** `kind` is missing or MCP-safe (`other` / empty)—never `execute`, `edit`, `delete`, `move`, `fetch`, or unknown kinds. Before the first prompt, a health check requires the agent's own MCP reporting to list pacer tools; if not, that turn is digest-only: the host opens a **replacement session without `mcpServers`** (so the grant is not attached), treats tools as off (permissions deny `pacer_*` as well), and the prompt says so. A secondary `tools/list` probe against the same MCP entry uses only the issued turn env (PATH/HOME/TMPDIR/LANG plus the ask MCP keys)—never a spread of the service `process.env`. Text deltas stream as `assistant.delta`; continuity uses `session/load` with the stored session id. **Visible-but-denied canaries:** `shell`, `read`, and `webfetch` stay on the agent tool list so the fail-closed self-test can record attempts; they remain blocked by `tool.use` policy and by host permission deny (unlike Orca's hide-first read-only profile). Code Mode `execute` and other non-canary builtins stay hidden. Claude Code ask mode is one `claude -p` CONTROL turn per message (`claude-control` spawn mode): `--input-format stream-json --output-format stream-json --verbose --permission-prompt-tool stdio` with `--permission-prompts host` (host decides `can_use_tool`), plus the flag belt `--tools ''`, `--allowedTools mcp__pacer__*`, `--strict-mcp-config` with one `pacer` server (`pacer mcp --assistant`; grant only via process env `${VAR}` expansion), `--settings '{"disableAllHooks":true}'`, `--setting-sources ''`, `--permission-mode dontAsk`, empty `CLAUDE.md`, deterministic `--session-id` / `--resume=<uuid>`.

**Codex (app-server).** Each ask-mode turn runs host-pinned `codex -s read-only -a never app-server` (the same argv as live usage). The host drives JSON-RPC: `initialize`, `config/read` (disable every listed MCP server; refuse if any managed/non-overridable layer sets MCP or the ask-mode tool/feature keys), `thread/start` or `thread/resume` with `excludeTurns`, thread config that turns off shell/plugins/web search and related features, and pacer's MCP via dotted `mcp_servers.pacer.*` keys (grant env-only). Approvals are answered fail-closed (allow only pacer MCP tool-call elicitations; decline commands, file changes and other elicitations). Before `turn/start`, assert thread `approvalPolicy`/`sandbox` match ask mode. `mcpServerStatus/list` must show pacer connected with tools; if not, the turn is digest-only (no MCP attached for the prompt; host declines pacer elicitations). Agent message deltas stream as `assistant.delta`; cancel uses `turn/interrupt` then terminate. Continuity stores the Codex thread id. Unified exec cannot be feature-disabled on current Codex; ask mode relies on approval decline plus the read-only sandbox.

### 4. `assistant-pacer`: pacer's own agent

A bundled Rust plugin built on the plugin SDK (`crates/plugin-sdk`) and [Rig](https://github.com/0xPlaygrounds/rig) (`rig-core`).

- **Rig provides the provider clients and the tool-calling loop only.** It registers the `tools` passed in each call as Rig tools that forward to `capability.assistant.tool`. It registers no other tool, loads no MCP server and reads no instruction file.
- **Manifest.** It contributes `assistant` and declares `secrets.resolve` (endpoint scope), `net.http` and `assistant.tool`. It has no process, file or worktree capability. `assistant.tool` is a new entry in `CAPABILITIES` (`src/plugins/protocol.ts`), with a `capability.assistant.tool` entry in `CAPABILITY_METHODS` (`src/plugins/host.ts`). It is answered only under the authority of the `assistant.reply` call in progress, which is revoked when that call ends, so a call outside a live turn is refused.
- **Accounts.** Endpoint accounts with a pacer-held connection. Today `connection.api` accepts only `openai-compatible`. Adding `anthropic` and `gemini` is an additive config change, made when their Rig clients ship, with the endpoint validation tests updated.
- **Continuity.** The plugin keeps no state. It rebuilds the conversation from `history` on every turn. Prompt caching on the stable prefix keeps that cheap. Over `maxInputTokens`, the host drops the oldest tool results and then the oldest turns, as today.

### 5. Choosing the backend

The user chooses an **account and a backend**. `assistant.settings.set` gains `backend` (`pacer` or `executor`), and `assistant.candidates` returns one row per available pair, with `backend`, `available` and, when unavailable, `reason`. Both fields are additive (P4).

- An endpoint account with a connection is offered with `backend: pacer`.
- An executor account is offered with `backend: executor`. When its adapter has no ask mode, or its self-test fails, the row has `available: false` and the reason, and cannot be chosen.
- An account can have both rows.

Settings labels each row, for example "byteplus · pacer's agent" and "oc-glm · via opencode", and states the trade-off: pacer's agent is faster and cheaper and needs an API key, while an executor needs no extra setup and answers more slowly. Existing settings without `backend` are read as `pacer`.

The choice stays fixed. Admission is unchanged: the daily turn limit, account capacity and reserve, and the planner-mode pause when the account is the planner's.

### 6. Continuity and fallback

Pacer stores every conversation, as today. Each turn stores the backend's `session` handle beside it.

- The next turn passes the handle. `assistant-executor` resumes the CLI session; `assistant-pacer` ignores it and uses `history`.
- If a session cannot be resumed (expired, removed, over its context limit, or the CLI changed), the plugin starts a new one from a condensed `history`, and the sheet notes "Context refreshed".
- If the user changes the account or backend, the next turn starts from `history`, and the sheet notes which account now answers.
- When a turn's reported input exceeds `maxInputTokens`, the host drops the session handle, so the next turn starts a new session from a summary of the conversation.

### 7. What each backend guarantees

| Guarantee | `assistant-pacer` | `assistant-executor` |
|---|---|---|
| Only pacer's tools run | Yes, by construction | Configured and self-tested, not enforced by an OS sandbox |
| Tool rounds capped | Yes: the host refuses calls past `maxToolRounds` | Yes: the same refusal on the grant path |
| Deadline | Yes: the host aborts the call | The host revokes the grant, stops the CLI turn, and stops the warm server if the turn has not stopped 5 seconds later |
| Output tokens capped | Yes: passed to the model | Where the CLI accepts a limit; otherwise best effort |
| Input tokens capped | Yes: the host builds the context | No: the CLI owns its context. The host starts a new session past the threshold (§6) |
| Usage | Measured from the provider | As the CLI reports it, with `coverage` |
| Pacer's token | Never reachable | Not in its environment or its home. A CLI ignoring its configuration could still read files the user can read |

Accounting is otherwise unchanged: usage is recorded as assistant usage, and executor turns create no task.

## Security

- **The trust boundary changes for `assistant-executor`.** The always-on spec says the backend never gets a token. Here the CLI's MCP server gets a grant. It is valid for one turn and allows only tool calls through the pipeline and proposals, so it can neither run an op nor act after the turn.
- **Residual risk.** For `assistant-executor`, "only pacer's tools run" means "configured not to, and checked", not "cannot". If a CLI ignored its configuration, it could read the user's files and could write files in pacer's real home directly, outside any grant. The self-test, the empty run directory, the redirected `PACER_HOME` and the minimal environment reduce this risk. They do not remove it, so `docs/assistant.md` and Settings state it, and open decision 3 asks for a one-time acknowledgement.
- **Keys.** `assistant-pacer` resolves keys by reference (P5). `assistant-executor` uses the CLI's own sign-in, and no key is copied.
- **Prompt injection** through task titles and data is unchanged: results are wrapped as untrusted data, and actions are cards the user confirms.

## Validation

- **Protocol:** schemas for `assistant.reply`, `assistant.delta`, `capability.assistant.tool` and the `assistant.tool` op, the generated docs and the freshness tests (P11, P14). The host refuses tool calls after a turn, for another `turnId`, past `maxToolRounds`, or with an expired grant.
- **`assistant-pacer`:** Rust unit tests against a fake OpenAI-compatible endpoint, covering the tool loop, caps, cancellation, and that only the passed-in tools are registered.
- **`assistant-executor`:** the self-test against a fake opencode: pass, fail (a tool runs, or a file changes) and inconclusive. Also grant revocation at the deadline, and the resume and fallback paths.
- **MCP:** `pacer mcp --assistant` lists only the assistant's tools and refuses calls without a live grant. It finds no token in its redirected `PACER_HOME`.
- **Settings:** before-and-after evidence for the Assistant page (UI-24).
- **Live (CT-11):** in a sandbox home, ask the same three questions on each backend, and record answers, rounds, tokens and time per turn. Ask a follow-up that needs the previous answer. Run the canary on the real opencode CLI.

## Phases

1. **Interface:** `assistant.reply`, `assistant.delta` and its dispatch, `capability.assistant.tool`, the `assistant.tool` op with the assistant grant, `pacer mcp --assistant`, and `backend` and `available` in settings and candidates. Routing rule: the host calls `assistant.reply` on the plugin that serves the chosen backend and provides it, and otherwise `assistant.respond`. The existing `plugins/assistant` keeps serving `assistant.respond` for `backend: pacer`. No `backend: executor` row is offered until phase 2, and a stored `executor` setting without a serving plugin is reported as unavailable through admission, as a missing account is today.
2. **`assistant-executor` with opencode:** ask mode, the warm server, the self-test, sessions and the Settings rows. Opencode accounts can then answer.
3. **`assistant-pacer` on Rig:** the Rust plugin, streaming, and the added `connection.api` values. The host sends `backend: pacer` turns to it. `plugins/assistant` stays installed but unused.
4. **Retire** `assistant.respond`, `plugins/assistant` and the host-side model loop, under the plugin protocol's compatibility rule.

Phases 2 and 3 are independent once phase 1 lands.

## Governance

- **Rules:** P1 (the service owns the assistant), P3 (no fixed planner or agent), P4 and P14 (additive protocol changes), P5 (keys by reference), P13 (backends are plugins), API-5 (it recognizes only task and attempt grants today; the assistant grant is a new, narrower credential, proposed through the amendment process with this change), CRATE-5 and CRATE-9 (`rig-core` as a dependency of a new crate, with build-timing evidence), UI-24 for the Settings change, and CT-11.
- **Reviewers:** `.project/reviewers/security.md` (ask mode, grant, self-test, the trust-boundary change), `architecture.md` (extension point and backends), `protocol-compat.md` (plugin and client protocol, MCP), `ui-accessibility.md` (Settings) and `qa.md` (fixtures and live evidence).
- **ADR:** [ADR 0028](../decisions/0028-assistant-backends.md) records the durable choices (P12, ARCH-9).

## Decisions

Approved by the maintainer on 2026-11-18 with the proposed answers.

1. **Shipping a native plugin.** `assistant-pacer` is the first bundled plugin built as a native binary. How it is packaged and signed with the desktop app and the CLI release needs a decision. Proposed: build it with `pacer-core` and sign it on the same path. **Addendum (2026-11-21):** the CLI manifest lists it under optional per-asset `nativePlugins` (not `companions`), so older updaters ignore the field; new updaters and self-repair install and version-guard it next to `pacer-core` ([ADR 0031](../decisions/0031-native-plugin-release-manifest.md)).
2. **Rig's version.** Rig is pre-1.0 and has breaking releases. Proposed: pin an exact version and upgrade deliberately, with the fake-endpoint tests as the gate.
3. **Is the self-test enough?** Should choosing an executor backend require a one-time acknowledgement that names the residual risk in §7? Proposed: yes.
4. **`assistant-pacer` as an executor.** Should pacer's agent later become an executor backend for light, read-only task kinds, such as classification and summaries, and for endpoint or local models without a CLI? Proposed: defer, and decide with evidence from phase 3.
5. **The grant's mechanism.** Store the assistant grant with the API-5 grant machinery, or in a separate store? Either way it is a distinct credential type with its own identity (§2). Proposed: the existing grant store with a distinct prefix and kind, and an API-5 amendment that names it.
