# Diagnostics remedies — 2026-11-07

Status: owner decision recorded 2026-11-07.
Source: [diagnostics remedies design](../specs/2026-11-07-diagnostics-remedies-design.md).
Builds on [clients over one local service](2026-10-16-clients-over-local-service.md) and the
[startup setup health](../specs/2026-11-06-startup-setup-health-design.md) design.

## Context

Diagnostics reported problems and left the user to fix them. Clients guarded against
unsafe actions with a rule: never infer an action from a check's fix text. The result was
that almost no check had an action: four check names for the selected planner got Repair,
budget rows linked to Accounts, and every other row printed a CLI command. The Checking
setup gate mapped check names to fixes a second time on the client.

Some warnings came from pacer itself: under the native process owner the TypeScript
plugin registry refused plugin calls, and the doctor reported that refusal as the user's
integration problem.

## Decisions

- **D1. The service decides the fix.** Each warning or failure from `doctor.run` carries a
  typed `remedy` (kind, label, a registered operation and its params, or a restricted URL).
  Clients render it and never derive actions from check names or fix text. The free-text
  `fix` stays for the CLI and older clients.
- **D2. A fixed ladder.** The doctor picks the first applicable kind: `auto` (safe,
  pacer-owned, undoable), `review` (writes into an agent folder; preview and consent),
  `user` (only the person can do it), `agent` (delegate a fix task), `internal` (pacer's own
  failure).
- **D3. Unknown problems go to an agent.** `doctor.fix.delegate` builds the brief on the
  server from the stored result and delegates through the normal task path. The check reads
  Fixed only after the task is accepted and the check passes on rerun.
- **D4. Pacer's failures are labelled as pacer's.** Errors are classified by code. A
  pacer-internal code marks the check "Couldn't check" with an `internal` remedy; it never
  suggests reinstalling the user's agents.
- **D5. Plugin calls under the native owner use the reverse bridge.** With
  `PACER_HOST_SOCKET` set, TypeScript plugin calls go to the native process owner through
  `_host.plugin.call` instead of being refused.

## Consequences

- One remedy source for Diagnostics, the Checking setup gate and the CLI.
- Consent-gated operations keep their consent screens; a remedy never grants consent.
- A test asserts every remedy operation the doctor can emit is registered.
- The doctor gains error-code classification, which other surfaces may reuse.
