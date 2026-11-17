# ADR 0028 — Assistant backends: pacer's own agent or an existing executor

Date: 2026-11-17

Status: Proposed. Accepted when the maintainer merges it.

Source: [assistant backends design](../specs/2026-11-17-assistant-backends-design.md). Supersedes D1 and D3 of the
[assistant extension point ADR](2026-10-28-assistant-extension-point.md). Its D2 and D4–D6 stand.

## Context

The assistant answers only from endpoint accounts whose base URL and key pacer holds. Accounts whose connection lives in
opencode, and subscription accounts reached through Claude Code or Codex, cannot answer, although they already run
pacer's work. Its plugin method, `assistant.respond`, is a single model call with the loop in the host, so an agent CLI,
which runs its own loop, cannot serve it.

## Decisions

- **D1. One turn-level interface.** The `assistant` extension point gains `assistant.turn`: one user turn in, one answer
  out, with optional `assistant.delta` notifications and a backend resume handle (`session`). It replaces the call-level
  `assistant.respond`, which stays until phase 4 of the design.
- **D2. The host owns the tools.** A plugin reaches pacer's data only through `capability.assistant.tool`, valid for one
  `turnId`. Every call runs the host's read pipeline, and `propose_action` becomes a card. The host also keeps admission,
  caps, history and accounting. These guarantees hold whichever backend answers.
- **D3. Two bundled backends.** `assistant-pacer` is pacer's own agent: a Rust plugin on Rig that calls an endpoint
  account with a key pacer holds, and registers no tool except the host's. `assistant-executor` runs an existing executor
  account's agent CLI in ask mode. The user picks the account, and the backend follows from it. Neither switches on its own.
- **D4. Ask mode fails closed.** An adapter offers ask mode only after a canary self-test proves that only pacer's tools
  run: no shell, edits, web fetch, hooks, other MCP servers or instruction files, in an empty run directory with a minimal
  environment. Pacer's tools reach the CLI through `pacer mcp --assistant`, authenticated by a grant valid for one turn.
  The self-test reruns when the adapter or the CLI version changes.
- **D5. Pacer keeps the transcript, and backends keep sessions.** A backend may return a resume handle. When a session
  cannot be resumed, the backend starts again from pacer's transcript, and the user is told.

## Consequences

- Every executor account whose adapter passes the self-test can answer, with no extra key. Opencode is the first such
  adapter.
- For `assistant-executor`, the guarantee becomes "configured not to, and checked" instead of "cannot". A CLI that
  ignored its configuration could read the user's files. It still cannot change pacer, because its grant allows reads
  through the pipeline and proposals for one turn only. The design and `docs/assistant.md` state this trade-off.
- `assistant-pacer` is the first bundled native plugin. Its packaging and signing are open decision 1 of the design.
- The plugin protocol gains a method, a notification and a capability (additive, P14). `assistant.candidates` gains a
  `backend` field (additive, P4).
- Making `assistant-pacer` a general executor is not decided here. If it is decided later, it is limited to light,
  read-only kinds.
