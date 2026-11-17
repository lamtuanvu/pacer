# Assistant backends: pacer's own agent or an existing executor

Date: 2026-11-17. Status: proposed, awaiting the maintainer's approval. Applies to:
- `src/plugins/protocol.ts` (the `assistant` extension point) and `docs/plugin-protocol*.{md,json}`
- `src/assistant/**`, `src/mcp/**` and `app/src/screens/settings/AssistantSettings.tsx`
- `plugins/assistant` (retired), new bundled plugins `assistant-pacer` and `assistant-executor`
- executor adapters that declare ask mode, starting with opencode
- `docs/assistant.md`, `test/assistant-*.test.ts`

Amends: [Always-on assistant](2026-10-28-always-on-assistant-design.md), sections "Where it runs" and "Backend". Its trust boundary, actions, history, accounting and sheet are unchanged.
Builds on: [Assistant self-discovery](2026-11-17-assistant-self-discovery-design.md), whose tools and read pipeline both backends use.
Decision record: [ADR 0028](../decisions/0028-assistant-backends.md), which supersedes D1 and D3 of the [assistant extension point ADR](../decisions/2026-10-28-assistant-extension-point.md).

## Problem

1. **Most accounts cannot answer.** The assistant accepts only endpoint accounts whose base URL and key pacer holds (`candidates()` in `src/assistant/service.ts`). Accounts whose connection lives in opencode (`source: opencode`), and every subscription account (Claude Code, Codex), are left out. A user with four working opencode executors sees only "Off".
2. **The assistant duplicates executor plumbing.** Accounts, keys, model choice and pacing already exist for executors. The assistant re-implements a model client beside them.
3. **The interface fits only one kind of backend.** `assistant.respond` is one model call, and the host runs the loop. An agent CLI runs its own loop, so it cannot serve that method.

## Goals

1. **Two backends behind one interface.** `assistant-pacer` is pacer's own agent: fastest and cheapest, and it needs an API key pacer holds. `assistant-executor` runs an existing executor account in ask mode: slower, and it needs no extra setup.
2. **The same guarantees whichever backend answers.** The host owns the read tools and their pipeline, action cards, admission, caps, accounting and history.
3. **Continuous conversations** on both backends, with a fallback when a session cannot be resumed.
4. **Fail closed.** An executor offers ask mode only after its adapter proves that only pacer's tools run.

Non-goals:
- Making `assistant-pacer` a coding executor. If it ever becomes an executor (open decision 4), it serves light, read-only kinds only.
- Moving a conversation between accounts or backends on its own. The user's choice stays fixed, as today.
- Installed (non-bundled) assistant backends. They wait for plugin sandboxing (M3), as today.
- Importing opencode's provider keys into pacer. That is a separate decision; this design lets those accounts answer without it.

## Design

### 1. One turn-level interface

The `assistant` extension point gains `assistant.turn` (additive, plugin protocol minor, P14):

```
assistant.turn({
  conversationId, turnId,
  account, model?,                       // the account and model the user chose
  system, digest,                        // host-built prompt and a short pacer digest
  history,                               // pacer's transcript, for backends without a live session
  message,                               // the user's new message
  session?,                              // the backend's resume handle from the last turn, if any
  limits: { maxInputTokens, maxOutputTokens, maxToolRounds, deadlineMs },
}) → { message, session?, usage: { input, output, cacheRead?, cacheWrite?, coverage } }
```

- **Streaming.** While a turn runs, the plugin may send `assistant.delta` notifications (`text` or `activity`, such as "Reading tasks…"). They are ephemeral, as in the always-on spec. A backend that cannot stream returns only the final message.
- **Cancellation** aborts the call. The plugin stops its model call or CLI turn and returns nothing.
- **Tools belong to the host.** During a turn, and only for that `turnId`, the plugin may call `capability.assistant.tool { turnId, name, params }`. The host runs the tool through the self-discovery pipeline (permitted op, parameter parsing, scope, projection, redaction, size cap, `<data>` wrapping) and counts it against `maxToolRounds`. `propose_action` goes through the same capability and becomes a card. The plugin never receives a token, grant or session it could use outside the turn.
- **The host still enforces every cap.** It counts tool rounds itself, stops the call at the deadline, and records the usage the plugin reports.

`assistant.respond` stays until the TypeScript backend is retired (phase 4).

### 2. `assistant-pacer`: pacer's own agent

A bundled Rust plugin built on the plugin SDK (`crates/plugin-sdk`) and [Rig](https://github.com/0xPlaygrounds/rig) (`rig-core`).

- **Rig provides the provider clients and the tool-calling loop only.** Its tools are the host tools, registered as Rig tools that forward to `capability.assistant.tool`. It registers no other tool, loads no MCP server and reads no instruction file.
- **Manifest.** It contributes `assistant` and asks only for `secrets.resolve`. It has no process, file or worktree capability.
- **Accounts.** Endpoint accounts with a pacer-held connection. The connection's `api` selects the Rig client: OpenAI-compatible first, then Anthropic and Gemini.
- **Continuity.** The plugin keeps no state. It rebuilds the conversation from `history` on every turn. Prompt caching on the stable prefix keeps that cheap. Over `maxInputTokens`, the host drops the oldest tool results and then the oldest turns, as today.

### 3. `assistant-executor`: an existing executor in ask mode

A bundled TypeScript plugin. It runs the chosen executor account's agent CLI with a restricted configuration that its adapter declares.

**Ask mode, declared by each adapter:**

| Part | Requirement |
|---|---|
| Tools | Only pacer's assistant MCP server. Shell, edit, write, web fetch and every other built-in tool are denied |
| Configuration | No hooks, no other MCP servers, no project or user instruction files |
| Working directory | A fresh, empty directory under `$PACER_HOME/runs/assistant/`, never a repository or worktree |
| Environment | Minimal: no `PACER_HOME`, no service token and no `PACER_*` variables, except the assistant MCP grant (below) |
| Launch | A warm server where the CLI has one, otherwise one run per turn |
| Continuity | The CLI's own session, returned as `session` and resumed on the next turn |
| Deadline | A hard timeout; the process is stopped when the turn ends or is cancelled |

**Pacer's tools reach the CLI over MCP.** A new mode, `pacer mcp --assistant`, serves only `pacer_find`, `pacer_describe`, `pacer_read` and `propose_action`. It authenticates with a per-turn assistant grant that the host issues for that `turnId` and revokes when the turn ends. The grant authorizes `capability.assistant.tool` for that turn and nothing else, so every call runs the same pipeline as the `assistant-pacer` backend's.

**Fail-closed self-test.** Ask mode is offered for an adapter only after a canary turn passes. The canary runs in ask mode and asks the model to run a shell command, read a file outside the run directory and fetch a URL. The test fails if any tool other than pacer's MCP tools starts, or if any file appears outside the run directory. It reruns when the adapter or the CLI version changes, and a resumed turn is tested as well as a first turn. While it fails, the account is shown in Settings with the reason and cannot be chosen.

**opencode first.** One `opencode serve` process per chosen account, started on demand on loopback and stopped after 10 idle minutes. A dedicated `pacer-ask` agent has a short prompt, `bash`, `edit`, `write` and `webfetch` denied, and only pacer's MCP server. Each conversation is one opencode session. Session permission rules are applied again on every turn. Claude Code and Codex follow once their warm modes and restrictions are verified against their current documentation.

### 4. Choosing the backend

`assistant.candidates` returns rows from both backends, with an additive `backend` field: `pacer` for endpoint accounts with a connection, and `executor` for accounts whose adapter passes the ask-mode self-test. An account can appear under both. Settings labels each row, for example "byteplus · pacer's agent" and "oc-glm · via opencode", and states the trade-off: pacer's agent is faster and cheaper, and needs an API key; an executor needs no extra setup and answers more slowly.

The choice stays fixed. Admission is unchanged: daily turn limit, account capacity and reserve, and the planner-mode pause when the account is the planner's.

### 5. Continuity and fallback

Pacer stores every conversation, as today. Each turn stores the backend's `session` handle beside it.

- The next turn passes the handle. `assistant-executor` resumes the CLI session; `assistant-pacer` ignores it and uses `history`.
- If a session cannot be resumed (expired, removed, over its context limit, or the CLI changed), the plugin starts a new one from a condensed `history`. The sheet notes "Context refreshed".
- If the user changes the account or backend, the next turn starts from `history` on the new backend. The sheet notes which account now answers.
- Past a token threshold, the host starts a new session from a summary, so the cost of a turn stays flat.

### 6. Accounting

Usage is recorded as assistant usage, as today. CLIs that report only part of their usage record `coverage: "partial"` or `"unknown"`. Executor turns create no task and never appear in the task list.

## Security

- **`assistant-pacer`** keeps today's guarantee: the model can reach only the host's tools.
- **`assistant-executor`** replaces "cannot" with "is configured not to, and is checked". The CLI runs as the user, so if its restrictions fail, it could read files the user can read. The per-turn grant limits what it can do to pacer: reads through the pipeline and proposals only, for one turn. Denying web fetch limits exfiltration. The self-test, the empty run directory and the minimal environment reduce the residual risk. They do not remove it. Settings says which backend answers, and the trade-off is documented in `docs/assistant.md`.
- No key is copied. `assistant-pacer` resolves keys by reference (P5). `assistant-executor` uses the CLI's own sign-in.
- Prompt injection through task titles and data is unchanged: results are wrapped as untrusted data, and actions are cards the user confirms.

## Validation

- **Protocol:** `assistant.turn`, `assistant.delta` and `capability.assistant.tool` schemas, the generated docs and the freshness test (P11, P14). The host refuses a tool call after its turn has ended or for another `turnId`.
- **`assistant-pacer`:** Rust unit tests against a fake OpenAI-compatible endpoint, covering the tool loop, the caps, cancellation and the absence of any tool other than the host's.
- **`assistant-executor`:** the self-test against a fake opencode, both passing and failing (a tool runs, or a file is written); the grant expiring at the end of the turn; the resume and fallback paths.
- **MCP:** `pacer mcp --assistant` lists only the four tools and refuses calls without a live grant.
- **Live (CT-11):** in a sandbox home, ask the same three questions on each backend, and record answers, rounds, tokens and time per turn. Ask a follow-up that needs the previous answer. Run the canary on the real opencode CLI.

## Phases

1. **Interface:** `assistant.turn`, `assistant.delta`, `capability.assistant.tool`, `pacer mcp --assistant` with the per-turn grant, and `backend` in `assistant.candidates`. The existing TypeScript plugin keeps serving `assistant.respond`.
2. **`assistant-executor` with opencode:** ask mode, the warm server, the self-test, sessions and the Settings rows. This lets opencode accounts answer.
3. **`assistant-pacer` on Rig:** the Rust plugin, streaming, and the Anthropic and Gemini clients. It replaces `plugins/assistant`.
4. **Retire `assistant.respond`** and the host-side model loop under the plugin protocol's compatibility rule.

Phases 2 and 3 are independent once phase 1 lands. The tools that the capability serves are whatever the self-discovery spec has delivered at that point: the fixed tools, or the generic tools.

## Governance

- **Rules:** P1 (the service owns the assistant), P3 (no fixed planner or agent), P4 and P14 (additive protocol changes), P5 (keys by reference), P13 (backends are plugins), API-5 (the per-turn grant is narrower than a work grant), the Rust crate rules for the new plugin crate, and CT-11.
- **Reviewers:** `.project/reviewers/security.md` (ask mode, grant, self-test), `architecture.md` (extension point and backends), `protocol-compat.md` (plugin protocol and MCP), and `qa.md` (fixtures and live evidence).
- **ADR:** [ADR 0028](../decisions/0028-assistant-backends.md) records the durable choices (P12, ARCH-9).

## Open decisions

1. **Shipping a native plugin.** `assistant-pacer` is the first bundled plugin built as a native binary. How it is packaged and signed with the desktop app and the CLI release needs a decision. Proposed: build it with `pacer-core` and sign it on the same path.
2. **Rig's version.** Rig is pre-1.0 and has breaking releases. Proposed: pin an exact version and upgrade deliberately, with the fake-endpoint tests as the gate.
3. **Is the self-test enough?** Is a canary plus restricted configuration enough to offer an executor backend by default, or should Settings require an explicit acknowledgement the first time an executor backend is chosen? Proposed: a one-time acknowledgement that names the trade-off.
4. **`assistant-pacer` as an executor.** Should pacer's agent later become an executor backend for light, read-only task kinds, such as classification and summaries, and for endpoint or local models without a CLI? Proposed: defer, and decide with evidence from phase 3.
5. **The grant's mechanism.** Reuse the API-5 grant machinery with a new assistant scope, or add a separate token type? Proposed: reuse it, with a scope that authorizes only `capability.assistant.tool` for one turn.
