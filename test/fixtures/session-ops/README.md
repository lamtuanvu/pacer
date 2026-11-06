# Conversation-operation characterization

`test/session-ops-parity.test.ts` captures the current TypeScript behavior in
isolated test homes. Regenerate behavioral captures deliberately with:

```sh
PACER_UPDATE_SESSION_OPS_GOLDENS=1 bun run test test/session-ops-parity.test.ts
```

Run normally without the update variable to check the captures. `contracts.json`
is the separately captured operation-schema inventory (the update command does
not rewrite it); behavioral captures cover:

- Create/retry payload identity, native executor identity, explicit checkout
  reservation, claimed private attachments and attachment preparation.
- Resume revision/active checks, identity refusal, successful queueing and launch
  failure recovery with retained output.
- Local attempt file reads, numeric locations, UTF-8/binary/size errors and denied
  traversal/private-state symlinks.
- Account login command fallback, host SSH argv and strategy planning argv,
  request replay and conflicting details.
- Agent hooks, report authentication and attempt identity, structured transcript,
  conversation turn transitions and headless terminal-report precedence.
- Message delivery into a native resume turn, duplicate requests, turn claiming,
  planner report publication, policy holds or alternate-executor replay, prompt/stop
  hooks, inbox versus consuming wait.

Random draft/file/task/message IDs and disposable home coordinates become named
placeholders. File modification times are checked as ISO timestamps and omitted.
Strategy prompts are compared across replay and checked for their intent, base
and approval instruction; their dynamic status section is not a golden. Report
clocks are omitted. Summary vectors retain exact UTF-16 units for short text and
length plus end excerpts for repeated boundary inputs.

`inputs.json` describes the pure syntax/summary corpus. `pure.json` is generated
from actual TS file reads and report reads/writes, and consumed by
`crates/sessions/tests/ops_goldens.rs`. `params.json` captures Zod param bounds
from `test/session-params-parity.test.ts` and is consumed by
`crates/sessions/tests/params_goldens.rs`. Rust implements only reference syntax,
summary cleaning/validation and param bounds, with UTF-16 input to preserve lone
surrogates and JavaScript length/trim behavior. It opens no files and writes no
state.

All create/resume/admission/attachment/report persistence and `msg.*` turn effects
remain TS-owned. M2-06 owns lifecycle/admission and messaging handoff; this slice
characterizes that seam without registering native operations, changing API
routing or activating a session host. Native mutation waits for the plan's store,
plugin-host and lifecycle prerequisites. Browser/desktop, real agent, SSH and
upgrade live behavior are not certified by these fixtures. CT-11 activation
validation remains required when the owning operation is transferred.
