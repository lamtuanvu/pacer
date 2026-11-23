# The assistant

Ask about your tasks, dispatch, executors and budgets from anywhere in the app with **⌘J** (Ctrl-J elsewhere), or with
`pacer ask "<question>"`. The design is in the [assistant spec](specs/2026-10-28-always-on-assistant-design.md) and the
[decision record](decisions/2026-10-28-assistant-extension-point.md). Backends: [ADR 0028](decisions/0028-assistant-backends.md)
and the [assistant backends design](specs/2026-11-17-assistant-backends-design.md).

## Set up

The assistant is off until you choose an account in **Settings › Assistant**. It runs on one endpoint account whose
connection pacer holds (`connection.api`: `openai-compatible`, `anthropic` or `gemini`) and never moves to another
account. If you choose the planner's account it follows the planner's pacing: it answers in relaxed and normal mode and
pauses in strict and emergency mode.

Anthropic and Gemini accounts need pacer's native `assistant-pacer` binary. When that binary is absent they are reported
unavailable and are never answered through the legacy TypeScript openai-compatible plugin.

The legacy host loop (`assistant.respond` on the bundled TypeScript `pacer-assistant` plugin) is **deprecated**. It remains
only as a fallback for openai-compatible accounts when the native `pacer-assistant-pacer` binary is missing or outdated
(the CLI updater that installs it is merged but not yet in a released build). A newer pacer release will install the
binary; one release after that ships, the legacy method, plugin and host loop are removed. When a turn still uses the
fallback, Activity logs one warning naming the missing or outdated binary.

Local openai-compatible endpoints with `connection.key: none` (LM Studio, Ollama, and similar) are called without an
`Authorization` header. pacer's native assistant injects a default `created` timestamp when an openai-compatible server
omits that field on chat-completion responses (Rig's OpenAI client requires it).

## What it can read, and what it cannot

It reads through fixed tools, in-process, from pacer's own data: counts and attention, task titles, states, executors,
times, decisions and review state, cached usage and pace, reviewed outcomes, recent activity, strategy names, and read-only route explanations (`dispatch.explain`) for a repository.
Results keep numbers and short pacer-owned names only. Goals, context, constraints, reports, output, diffs, files, keys,
terminal screens and session transcripts are never sent, secrets and your home path are removed, and each result is cut at
32 KiB. What it reads, and your question, go to the account's model.

Settings › Assistant and each candidate row expose whether that backend has **proved live pacer tools** for this CLI
version (`liveTools`). When it has, the settings card lists the same reads as above. When it has not (digest-only), the
agent answers from the host-built summary for the turn and says when it needs data the summary does not show. A later
unhealthy MCP turn can still fall back to digest-only even after a proving self-test.

## Four backends

### 1. pacer's own agent (`assistant-pacer`)

pacer's Rig agent calls an endpoint account whose base URL and key pacer holds. It always has live tools through the host
capability `capability.assistant.tool`. Fastest path; needs an API key (or a keyless local endpoint).

### 2. opencode over ACP (`assistant-executor`)

An opencode account answers through a restricted `opencode acp` turn. Built-in tools are denied; pacer's MCP read tools
are passed in the ACP `mcpServers` field with a per-turn grant bound only by env reference. After session start, the host
checks that pacer MCP reported healthy tools; if not, that turn falls back to digest-only and says so. Settings shows
live tools once the ask-mode check for this CLI version proved a pacer tool call.

### 3. Claude Code over the control protocol (`assistant-executor`)

A Claude Code account answers through a host-pinned `claude` stream-json control-protocol turn. Built-in tools stay off;
only pacer MCP tools (`mcp__pacer__*`) are allowed; and every `can_use_tool` decision is made by the host. The grant
reaches Claude only through process env (never argv). After initialize, the host checks MCP status for a connected
`pacer` server with the expected tools; if that health check fails, the turn falls back to digest-only for that turn and
says so. Settings shows live tools once the ask-mode check for this CLI version proved a pacer tool call. The allowlisted
`telemetry@builtin` plugin is Claude Code's normal telemetry to Anthropic, which already receives the prompt.

Live Claude checks that need the signed-in subscription use a live sandbox with
`bun run live up --real-keychain` (see [live validation](testing/live-validation.md)).

### 4. Codex over app-server (`assistant-executor`)

A Codex account answers through host-pinned `codex -s read-only -a never app-server`. Thread config turns off shell,
plugins and web search; pacer's MCP is added only via dotted `mcp_servers.pacer.*` keys. The host allows only pacer MCP
tool-call elicitations. Unhealthy MCP preflight forces digest-only for that turn. Live tools appear in Settings after the
ask-mode check proved a pacer tool call for the installed Codex version.

## Ask-mode check (self-test)

An executor account can be saved for the assistant only after it passes the **ask-mode check**, which runs again when the
adapter CLI's version changes. The check runs a first turn and a resumed turn. Depending on the adapter it requires that
forbidden actions were attempted and denied (opencode), that Codex recorded denied shell/file approvals while a pacer tool
worked, or that Claude's control-protocol init shows connected pacer MCP with a completed (or error) `mcp__pacer__*` call
and forbidden tools absent or refused. Nothing may be written outside the run directory, and a planted AGENTS.md canary
must not enter the answer. An inconclusive run (the agent attempted nothing) fails. A passing check that proved a pacer
tool call sets `liveTools` on that candidate.

## Residual risk

These restrictions are each CLI's own configuration (and host approval gates), checked by pacer. They are not an
operating-system sandbox. The CLI runs as you, so if it ever ignored its configuration it could read files you can read.
Settings asks you to confirm this the first time you switch to an agent CLI, and an account cannot be saved for it until
it passes the check. Through its grant the CLI can only read through pacer's pipeline and propose actions, for one turn.
pacer's own agent does not carry this residual risk: it can reach nothing but the data pacer hands it.

## What it can do

Nothing on its own. It can propose a retry, stop, answer, pause (at most 24 hours), resume, a prefilled New task, or a link.
Each appears as a card whose text pacer writes from the operation; the assistant's own words sit beneath it. The app runs
the operation with your session only after you press the card's button.

## Limits, history and cost

Defaults: 32,000 input and 8,000 output tokens per question, 6 tool rounds, one question at a time, 50 a day. History is
stored on this machine in pacer's home, kept 30 days and at most 200 conversations, and **Clear history** deletes it. Each
turn's token usage is recorded as assistant use, apart from your tasks, with a `measured`, `partial` or `unknown` coverage. A cancelled answer is recorded with no usage, though the model's provider may still bill the input.

## Entry points, and what is deferred

⌘J (Ctrl-J elsewhere) and the "Ask pacer" pill open the sheet, which opens with the task's scope when you are on a task.
Not built yet, and recorded here so nobody looks for them: the ⌘K menu's `?` ask mode, its "Ask: …" result and footer hint,
and a top-bar "Ask pacer" button. The command menu is a separate change; it calls `assistantEntry.ask({ text,
newConversation })` and reads `assistantEntry.available()` (`app/src/shell/assistant-entry.ts`), which is the whole contract.
Also deferred: streamed model tokens (the plugin returns the whole answer until plugins can stream), retrying on a different
executor, an Insights row for assistant use, and a native agent CLI backend.

## The per-turn stream

`assistant.ask` returns `{ conversationId, turnId }`; the answer follows on `GET /v3/assistant/turns/<turnId>/stream`
(Server-Sent Events, same authentication as every route, in memory only, at most ten frames a second). Each `data:` line is
JSON: `{ "status": "Thinking…" }`, `{ "delta": "<text>" }` or `{ "done": { "state": "done|error|cancelled", "error"? } }`.
After `done`, read the turn with `assistant.turn`. Other windows learn that History changed from an `assistant` event that
carries no text.

## For plugin authors

`assistant` is a plugin extension point. Prefer `assistant.reply` (turn-level). `assistant.respond` is deprecated and
removed one release after the native updater ships; served only by bundled plugins until installed plugins are
sandboxed. See the [plugin protocol](plugin-protocol.md).
