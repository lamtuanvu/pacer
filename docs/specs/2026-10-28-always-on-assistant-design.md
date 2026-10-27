# Always-on assistant

Date: 2026-10-28. Status: proposed, awaiting the maintainer's approval. Applies to: `src/api/ops.ts`, `src/api/caller-policy.ts`, `src/serve/**`, `src/link/envelope.ts`, `src/plugins/**`, `plugins/**`, a new `src/assistant/`, `src/view-model/**`, `app/**`, `docs/protocol.md`, `docs/plugin-protocol.md`.
Builds on:
- [app redesign](2026-10-27-app-redesign-design.md), slice 10, and its `AuroraSheet` component
- [route explanation](2026-10-28-route-explanation-design.md)
- [plugin UI contributions](2026-10-28-plugin-ui-contributions-design.md) and [ADR plugin-host-and-rust-strangler](../decisions/2026-10-19-plugin-host-and-rust-strangler.md)
- [attempt token accounting](2026-10-27-attempt-token-accounting-design.md)
- [endpoint executors](2026-10-15-endpoint-executors-design.md) and [intelligent work dispatcher](2026-10-24-intelligent-work-dispatcher-design.md)

## Problem

People ask pacer questions that its screens answer only in pieces: "Why did this task go to Antigravity?", "What needs me today?", "How much of my Codex week is left?", "Why did runner-forge fail twice?". The answers are spread across the task tree, the dispatch trace, the budget page and the activity log. The redesign has an assistant sheet for this, opened from the top bar and from the ⌘K menu with a "?" prefix, but no spec says what the assistant is, where it runs, what it may read or do, or what it costs.

"Always-on" in this spec means the assistant is **always one keystroke away**. It does not mean a process that runs, reads or spends in the background.

## Goals

1. Answer questions about tasks, dispatch, executors, budgets and pacing, from pacer's own data, and cite where each fact came from.
2. Offer actions only as proposals to run existing operations. Each runs only after the user confirms it in the app, through the app's own authenticated request.
3. Run on an account the user chose, accounted like any other work, and paced by pacer's own rules, so that the assistant never quietly spends the planner's budget.
4. Keep the history the user can see, in pacer's home, with a bounded retention period and a clear action.
5. Fit the redesign: the `AuroraSheet`, the "?" entry in ⌘K, ⌘J, reduced motion and the accessibility rules.

Non-goals:
- Writing code, editing files or running commands. That is delegated work, and the assistant can only propose delegating it.
- Reading native credentials, terminal screens or session transcripts (SEC-1, and see Data access).
- A fixed model or vendor (P3).
- Proactive messages. The assistant answers when asked (see Open decisions).

## Where it runs

The host stays minimal (P13): answering a question with a model is a capability a plugin can provide. The assistant is therefore a new plugin extension point, **`assistant`**, with one method:

| Method | Params | Result | Deadline |
|---|---|---|---|
| `assistant.respond` | `{ conversationId, turnId, messages, tools, context, limits }` | A stream of `assistant.delta` notifications, then `{ message, toolCalls?, usage }` | `limits.deadlineMs`, at most 120 s |

- `messages` is the bounded conversation window, `tools` are the read tools and action schemas below, and `limits` sets `maxOutputTokens`, `maxToolRounds` (at most 6) and the deadline.
- `usage` reports `{ input, output, cacheRead?, cacheWrite? }` tokens, with a coverage of `measured`, `partial` or `unknown`, exactly as token accounting defines it.
- The plugin never calls client ops. It asks for data by returning `toolCalls`. The host runs the read tools itself and calls `assistant.respond` again with the results, up to `maxToolRounds`.

A bundled reference plugin, `pacer-assistant`, implements the extension point over two backends:
- an **endpoint executor** (an OpenAI-compatible endpoint, including local models), using its key reference through `secrets.resolve` (P5);
- a **native agent CLI** that pacer already runs as an executor, in a non-interactive, tool-less mode, in an empty scratch directory outside any repository, with the account's own home.

Other plugins can provide other backends, but not yet (see Trust boundary).

**Version 1 ships the endpoint backend only.** A native agent CLI loads its own hooks, MCP servers and instruction files from the account home, so "tool-less" is a property each CLI would have to prove. The native backend is added per agent only once its adapter declares the exact flags that turn off tools, MCP, hooks and project instructions, runs with a minimal environment (no `PACER_HOME`, no pacer token, no `PACER_*` variables) and a hard timeout, and passes a fail-closed self-test like the enforcement canary: the self-test asks the CLI to use a tool and fails the backend if any tool call, hook or MCP start is observed. Until then the native backend is not offered.

### Trust boundary

Plugins today are unsandboxed child processes of the service. They run as the user, and their environment includes `HOME` and `PACER_HOME` (`src/plugins/registry.ts`), so a plugin process can read the service's bearer token at `$PACER_HOME/token` and call any op directly, bypassing the confirmation flow below. Sandboxing and capability enforcement for installed plugins are planned for milestone M3 of the plugin system. The guarantees in this spec ("the backend never gets a token", "the plugin never calls client ops") are therefore guarantees of the protocol, which a trusted plugin keeps. Until M3 they are not enforced against a hostile plugin.

So, until installed plugins are sandboxed:
- **Only bundled plugins may serve `assistant`.** The host refuses an installed plugin whose manifest contributes `assistant`, with a clear error. Bundled plugins ship in the reviewed binary.
- **The bundled backend gets a scrubbed environment.** When `pacer-assistant` runs a backend child process, that child gets no `PACER_HOME`, no token path and no `PACER_*` variables.
- **Bundled means no grant prompt.** Bundled plugins skip grants today. The assistant is therefore off until the user chooses an account, and that settings page lists, in plain words, exactly what the assistant reads (the read tools below) and where the answers go (the chosen account's model). The host, not the plugin, runs every read tool, so the plugin can read nothing it isn't handed.

### Which account, and how it is paced

The rules in this section are proposals for the maintainer (see Open decisions 2, 3, 8 and 13), not existing policy.

The user picks the assistant's account in Settings › App preferences › Assistant. The choice is an executor account (`runner` and `account`), not "the planner", so nothing hard-codes a planner (P3, ARCH-5). Until it is set, the assistant is not offered (UI-13), and the "?" entry offers to set it up instead.

Pacing rules for each turn:
- **Admission.** Before each turn, the host checks the chosen account with the same cached status the dispatcher uses. A turn is refused with a plain reason when that account is exhausted or would fall below the dispatcher's `reservePct`. Whether `delegation.pause` also pauses the assistant is an open decision: it pauses delegated work, and the assistant is not delegated work. A turn is never silently moved to another account.
- **The planner's account.** If the chosen account is also the planner's, the assistant follows the planner's pacing mode: it may answer in relaxed and normal mode, and is refused in strict and emergency mode with "{Planner} is in Strict mode. The assistant is paused to save the planner's budget.", where `{Planner}` is the configured planner's name. Whether the planner's account may be chosen at all is an open decision.
- **Accounting.** Each turn's `usage` is recorded as assistant usage, outside any root task, and Insights shows it as its own row, never as executor or planner work. The proposal is a third `root_usage` source, `assistant`, keyed by conversation and turn (open decision 13). Either way, the token accounting spec gains a line when this lands.
- **Limits.** Default caps are 32,000 input tokens and 8,000 output tokens per turn, 6 tool rounds, one turn in flight at a time, and 50 turns a day, all configurable. On a cap, the turn ends with what it has and says why. The input cap is enforced by the host on the context it builds, before the call.
- **Cost before asking.** The sheet's context chip shows which account answers. It does not show a token estimate, for the same reason the route explanation doesn't project percentages: pacer has no measured basis for one.

## Data access

The assistant reads through fixed **read tools**. Each one maps to the core read function behind an existing op, called in-process by the host with a read-only context and `computeStatus(..., { cacheOnly: true })` wherever status is involved. The ops `limits.check` and `routing.status` themselves don't read cache-only, so the tools call the cached status, not the ops. Nothing new is exposed.

| Tool | Op | Notes |
|---|---|---|
| `snapshot` | `snapshot.get` | Counts, attention, mode, pause state |
| `tasks_list` | `dispatch.list`, `task.list` | Titles, states, executors, times; paged, at most 100 |
| `task_get` | `task.get`, `dispatch.tree` | Summary fields, decisions, attempts, review state |
| `task_events` | `dispatch.events` | The timeline after a cursor |
| `route_explain` | `dispatch.explain` | Why a task would go, or went, where it did |
| `budget` | `limits.check`, `routing.status` | Usage, pace, resets per account. The tool uses cached readings only (`computeStatus` with `cacheOnly`), and never triggers a live usage read or `limits.refresh` |
| `analytics` | `dispatch.analytics` | Reviewed outcomes with sample sizes |
| `activity` | `activity.list` | Recent activity log entries |
| `strategies` | `strategy.list`, `strategy.show` | Names and summaries |

Not available, by design:
- **Task output and diffs** (`task.log`, `task.diff`), terminal screens and session transcripts. They can contain anything the agent saw, including secrets in files. Whether to allow a bounded, opt-in excerpt of task output for "why did it fail" questions is an open decision.
- **Files** in repositories or in `PACER_HOME`, account homes, config files and keys (SEC-1, SEC-2, P5).
- **Anything outside pacer**, including the network, except what the backend itself needs to reach its model.

Task requests, context and constraints are free text that users paste into, so they may hold secrets. The read tools therefore:
- **leave free text out by default.** `task_get` returns the title, state, kind, executor, times, decisions and review state, not the goal, context, constraints or acceptance text. Whether to include the goal is an open decision;
- **redact everything they return** with a new redactor, `src/assistant/redact.ts`. It replaces exact values of every secret pacer holds (endpoint keys and resolved secret references), key-shaped strings (common provider key prefixes, bearer tokens, JWTs, PEM blocks and long high-entropy tokens), and the home path. The classifier's `redactState` only shortens strings and replaces the home path, so it is not enough on its own. Strategy YAML and activity-log text go through the same redactor;
- **cap each result** at 32 KiB, and wrap it as data: the host puts tool results and task text in a delimited data block, separate from the instructions it sends. The backend is told that task titles, agent output and plugin text are untrusted content. That reduces prompt injection; it does not prevent it, which is why the assistant cannot act on its own (below).

The user's **context chip** narrows what the tools may read: "Dispatch · 7 days", "This task", or "This repository". Tool calls outside the chosen scope return an empty result with a note.

## Actions

The assistant can suggest an action only by returning a `propose_action` tool call, `{ op, params, why }`, where `op` is on a fixed allowlist:

| Allowed | Why it is safe enough to propose |
|---|---|
| `dispatch.retry`, `task.retry` | Revision-checked, and repeats work the user already started |
| `dispatch.stop`, `task.stop` | Revision-checked |
| `dispatch.answer`, `task.answer` | The answer text is shown in full and editable before sending |
| `delegation.pause`, `delegation.resume` | Reversible |
| `dispatch.submit` | Opens the "New task" composer prefilled, with the route explanation. It never submits directly |
| Navigation | "Open dispatch trace", "Open task" and similar. These are links, not ops |

Never proposed: account, key, secret, plugin, grant, install, update, host, service, config, strategy and routing writes, including `strategy.use` (open decision 7); reviews (`task.review`, `dispatch.review`), because accepting work is the user's judgement; removals; and anything that runs a shell (API-5).

How a proposal runs:
1. The host validates `params` against the op's schema and records `expect_rev` from the state **when the card is created**, never when it is clicked. If the task changes before the click, the op returns `conflict`, and the card says what changed and offers a refreshed card. An invalid proposal is dropped, with a note in the conversation.
2. The app shows an **action card** drawn by the host from the op and its params, in plain words from the view model: "Retry 'ota: stale plan' on Codex, as a new attempt in the same worktree." **Every free-text parameter** (retry feedback, answer text) is shown in full and is editable, and every choice that changes who does the work (a retry's executor) is shown. The assistant's `why` is shown beneath, labelled as the assistant's words and visually distinct from the host's text. The card's description never comes from the model.
3. Nothing runs until the user presses the card's button. The app then calls the op itself, with the user's session and a `requestId` (P6, SEC-4). A `conflict` or other error is shown on the card in plain words.
4. The conversation records the proposal, the user's decision and the result.

The assistant's backend never gets an API token, a grant or a session. It has no way to call an op itself.

## History

- **Where.** In the service's SQLite store, in `assistant_conversations` and `assistant_turns` tables, under `PACER_HOME`. The database and its WAL files are mode 0600 in a 0700 directory (SEC-7), and the connection sets `secure_delete`, so deleted text is overwritten. It is not in the browser's storage, so every window and the tray see the same history (ARCH-1).
- **What.** For each turn, after the redactor: the user's question, the answer, the tool calls with their op names and parameters, tool results reduced to the facts quoted in the answer, action proposals and outcomes, the account, and the token usage. Full tool results are not kept.
- **Retention.** 30 days by default, and at most 200 conversations, oldest first. Both are configurable.
- **Clearing.** "Clear history" deletes the rows. One conversation can also be deleted. Usage rows in token accounting stay, without the text, so budget figures don't change.
- **Sent to the backend.** Only the current conversation's last 20 turns, or 24 KiB, whichever is smaller. Earlier turns stay on this machine.

## Client protocol (v3, additive)

| Op | Params | Result |
|---|---|---|
| `assistant.status` | `{}` | `{ available, account?, reason?, limits }` |
| `assistant.ask` | `{ conversationId?, text, scope, requestId }` | `{ conversationId, turnId }`. The answer streams as events |
| `assistant.cancel` | `{ turnId }` | `{ cancelled }` |
| `assistant.conversations` | `{ before?, limit? }` | A page of conversations |
| `assistant.conversation` | `{ id }` | Its turns |
| `assistant.delete` | `{ id? }` | Deletes one conversation, or all of them without `id` |
| `assistant.settings.set` | `{ runner, account, limits?, retention?, expect_rev }` | The settings |

- **Streaming does not use the event outbox.** The outbox is durable and holds 1000 entries, so streamed deltas would push other events out within minutes and persist answer text outside History's retention and delete controls. Instead, `assistant.ask` is followed by `GET /v3/assistant/turns/<turnId>/stream` (SSE) or a JSON-RPC subscription, an ephemeral, per-turn stream of `{ delta }` frames, coalesced to at most ten a second and closed when the turn ends. It is authenticated like every other route and kept in memory only.
- A new outbox event type, `assistant`, carries only `{ turnId, conversationId, state: "done" | "error" | "cancelled" }`, with no text, so other windows can refresh History. Clients ignore unknown event types (API-1), and `hello.events` lists it. The outbox's event-type union (`src/link/envelope.ts`) is extended additively.
- The plugin's `assistant.delta` notifications need the transport's notification dispatch, which the [plugin UI contributions](2026-10-28-plugin-ui-contributions-design.md) spec adds, and a per-call deadline: `MethodDef.deadlineMs` is static today, so `assistant.respond` takes its deadline from `limits.deadlineMs`, capped at 120 s.
- **Executor sessions** get `not_allowed` for every `assistant.*` op: the caller policy (`src/api/caller-policy.ts`) adds them, so an executor, with or without an API-5 grant, cannot spend the assistant's budget or read its history.
- Errors use existing codes (API-4): `not_allowed` when the assistant isn't set up or the account is refused (with the reason in `hint`), `plugin_unavailable`, `plugin_timeout`, `invalid_input`, `not_found` and `conflict`.
- **CLI (ARCH-8).** `pacer ask "<question>" [--scope ...] [--json]` asks once and prints the answer. Proposals are printed as the equivalent `pacer` commands and are never run.
- **Plugin protocol.** `assistant` is a new extension point with one method and one notification: an additive minor version under P14 (1.2.0 if it ships with plugin UI, otherwise 1.3.0), generated into `docs/plugin-protocol.md` (P11). Rust types are regenerated with `cargo xtask gen` in the same PR.

## Entry points

- **Top bar.** The "Ask pacer" button, with ⌘J, opens and closes the sheet. It is not shown while the assistant is unavailable.
- **⌘K "?".** Typing `?` at the start of the command menu's input switches it to Ask mode. The prefix chip reads "Ask". The first result is "Ask: '…'" with "Answers in the assistant at the bottom of the screen", and related tasks and actions follow. Enter asks in the current conversation and ⌘↵ in a new one. The menu closes and the sheet opens with the question sent. With no assistant set up, the only result is "Set up the assistant", which opens its settings.
- **The footer hint.** "`?` ask assistant" appears in the command menu's footer only while the assistant is available (UI-13).
- **Context.** Opening from a task selects the "This task" scope.

## The sheet and the aurora

The sheet is the redesign's `AuroraSheet`. It anchors to the bottom of the main region, above the status bar and the terminal dock, and is non-modal, so the rest of the app stays usable.

- **Layers.** A decorative aurora layer (`aria-hidden`), then the conversation, then the input. The aurora uses the `aurora-1` to `aurora-3` tokens. It is solid at the bottom edge and fades to transparent toward the top, through a mask, so older messages fade as they scroll up.
- **Readable text.** Message text never sits directly on the gradient. Messages and the input are on solid `surface-card` bubbles, so contrast is that of normal text (4.5:1, UI-2) in light and dark mode. The fade applies to the decoration and to scrolled-away messages, never to the newest answer or the input.
- **Motion.** The aurora drifts slowly, in a cycle of at least 12 seconds, **only while an answer is being generated**. At rest it is still. Under `prefers-reduced-motion: reduce` it never moves, and generation is shown by the "Thinking…" text and a static indicator. Opening and closing the sheet use the motion tokens, and become an instant change under reduced motion.
- **Forced colours.** With `forced-colors: active`, the aurora is not drawn, and the sheet has a plain border.
- **Focus and keys.** Opening moves focus to the input, and Esc or ⌘J closes the sheet and returns focus to the control that opened it. The conversation is a `log` region. Only a finished answer is announced, politely (`aria-live="polite"`), never each streamed delta.
- **Content.** Answers render as text with DS lists and links only. Model output is never inserted as HTML. Citations link to the task, trace or page they came from. Action cards follow UI-14: the card's confirm button is the only primary control in the sheet while a card is pending.
- **Narrow screens.** The sheet becomes a full-height sheet with the same layers.

## Validation

- Unit tests: the read tools are read-only and scope-limited; redaction; tool-result caps; the action allowlist; rejection of an invalid proposal; admission refusals for exhaustion, pause, reserve and planner strict mode; retention and deletion.
- A test that the backend plugin receives no API token, grant or session in any message, and that a backend child process's environment has no `PACER_HOME` or `PACER_*` variables.
- A test that an installed (non-bundled) plugin contributing `assistant` is refused.
- Redactor tests with each key shape, exact secret values and a PEM block, including inside strategy YAML and activity text.
- Prompt-injection fixtures: a task title instructing the assistant to stop all work produces at most a proposal card, and nothing runs without a click. A `why` text that imitates a host card is shown in the assistant's style, not the card's.
- A caller-policy test that executor sessions get `not_allowed` for `assistant.*`.
- UI tests: the ⌘K "?" mode, ⌘J, focus return, the log region announcing only completion, reduced motion (no animation), forced colours, contrast in light and dark mode, and 375 px.
- CT-11 live validation when it ships: ask real questions against a sandbox `PACER_HOME` with real tasks, through both backends where available, confirm one proposed retry, and check the turn's usage in Insights. Backends not exercised live are reported as UNVERIFIED.

## Governance

Constitution 0.15.0. Applicable: P1–P6, P11, P13–P14; ARCH-1–3, ARCH-5, ARCH-8, ARCH-9, ARCH-12–14; API-1–5; SEC-1, SEC-2, SEC-4, SEC-5, SEC-7; UI-2, UI-6, UI-10, UI-12–15, UI-21, UI-26, UI-27; CT-11; REPO-2, REPO-3, REPO-7, REPO-11–14 for whoever implements it. No rule changes are proposed. The constitution's scope lists the service, routing and the thin clients; an assistant inside the service and app arguably fits there, but whether it deserves its own scope line (an amendment) is open decision 14. If the maintainer accepts the assistant extension point, it is a durable architectural choice that gets its own ADR with the first implementation PR (ARCH-9); this spec doesn't add one, because the open decisions below may change it.

## Open decisions

For the maintainer. Each has a proposal, but none is assumed.

1. **Plugin or core.** This spec makes the backend a plugin extension point, following P13. The alternative is a built-in client of endpoint executors, which is simpler but adds a model integration to the host.
2. **Planner account.** May the user choose the planner's account for the assistant at all? The proposal allows it, but refuses turns in strict and emergency mode.
3. **Routing.** Should the assistant use one chosen account (proposed), or be routed by the dispatch ladder with a dedicated `assistant` kind, so it follows spare capacity?
4. **Task output.** Allow an opt-in, bounded excerpt of task output (for example the last 4 KiB of a failed attempt's stderr, redacted) for "why did it fail" questions?
5. **Proactive use.** Should the assistant ever speak first, for example a daily summary? The proposal: no, because unasked turns spend budget.
6. **Retention defaults.** 30 days and 200 conversations, or shorter? Should history be off by default, keeping only the open conversation in memory?
7. **Strategy switches.** Should the assistant be able to propose `strategy.use`? It is reversible, but it changes live routing, so the proposal leaves it out.
8. **Pause.** Should `delegation.pause` also pause the assistant?
9. **Answer actions.** `dispatch.answer` sends text to an executor. Should the assistant be able to draft that text, or only point at the question?
10. **Installed assistant backends.** Keep `assistant` bundled-only until installed plugins are sandboxed (proposed), or allow installed backends earlier with a warning?
11. **Task goal text.** Should `task_get` include the redacted goal, which most "why" questions need, or keep all free text out?
12. **Native CLI backends.** Which agents, if any, should get the certified native backend, given that each needs its own flags and self-test?
13. **Token accounting source.** Add `assistant` as a third `root_usage` source (proposed), or keep a separate usage table, since assistant turns belong to no root task?
14. **Constitution scope.** Add the assistant to the constitution's in-scope list through an amendment, or treat it as covered by the service and thin clients?
