# ADR 0028 — Assistant backends: pacer's own agent or an existing executor

Date: 2026-11-17

Status: Accepted by the maintainer on 2026-11-18, with the design's proposed answers to its decisions.

Source: [assistant backends design](../specs/2026-11-17-assistant-backends-design.md). Supersedes D1 and D3 of the
[assistant extension point ADR](2026-10-28-assistant-extension-point.md). Its D2 and D4–D6 stand.

## Context

The assistant answers only from endpoint accounts whose base URL and key pacer holds. Accounts whose connection lives in
opencode, and subscription accounts reached through Claude Code or Codex, cannot answer, although they already run
pacer's work. Its plugin method, `assistant.respond`, is a single model call with the loop in the host, so an agent CLI,
which runs its own loop, cannot serve it.

## Decisions

- **D1. One turn-level interface.** The `assistant` extension point gains the plugin method `assistant.reply`: one user
  turn in, one answer out, with the tool list, optional `assistant.delta` notifications and a backend resume handle
  (`session`). It replaces the call-level `assistant.respond`, which stays until phase 4 of the design.
- **D2. The host runs every tool.** Pacer's own agent calls `capability.assistant.tool`, and an executor's CLI calls the
  `assistant.tool` op through `pacer mcp --assistant`. Both are valid for one `turnId` and end in the same read pipeline,
  which counts tool rounds; `propose_action` becomes a card. The host also keeps admission, history and accounting. Where
  a backend cannot enforce a cap (an executor CLI owns its own context), the design states the weaker guarantee.
- **D3. Two bundled backends.** `assistant-pacer` is pacer's own agent: a Rust plugin on Rig that calls an endpoint
  account with a key pacer holds, and registers no tool except the host's. `assistant-executor` runs an existing executor
  account's agent CLI in ask mode. The user picks an account and a backend; an account can be offered by both. Neither
  switches on its own.
- **D4. Ask mode fails closed.** An adapter offers ask mode only after a canary self-test proves that only pacer's tools
  run: no shell, edits, web fetch, hooks, other MCP servers or instruction files, in an empty run directory with a minimal
  environment whose `PACER_HOME` is that directory. The test passes only with recorded evidence that each forbidden
  action was attempted and denied, and an inconclusive run fails. Pacer's tools reach the CLI through
  `pacer mcp --assistant`, authenticated by a grant valid for one turn. The self-test reruns when the adapter or the CLI
  version changes.
- **D5. Pacer keeps the transcript, and backends keep sessions.** A backend may return a resume handle. When a session
  cannot be resumed, the backend starts again from pacer's transcript, and the user is told.

## Consequences

- Every executor account whose adapter passes the self-test can answer, with no extra key. Opencode is the first such
  adapter.
- For `assistant-executor`, the guarantee becomes "configured not to, and checked" instead of "cannot". A CLI that
  ignored its configuration could read the user's files and write files in pacer's home directly. Through its grant it
  can only read through the pipeline and propose, for one turn. This changes the always-on spec's trust boundary ("the
  backend never gets a token"); the design and `docs/assistant.md` state the trade-off.
- `assistant-pacer` is the first bundled native plugin. It is built and signed with `pacer-core` (decision 1 of the design).
- The plugin protocol gains a method, a notification and a capability (additive, P14). The client protocol gains the
  `assistant.tool` op, and `backend` and `available` in assistant settings and candidates (additive, P4).
- Making `assistant-pacer` a general executor is not decided here. If it is decided later, it is limited to light,
  read-only kinds.
