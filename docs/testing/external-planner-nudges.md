# External planner nudge validation

Use this procedure to check whether external planners receive delegated-agent
reports and questions, and whether unattended conversations reach human attention.
It describes validation to perform; it does not record a successful validation run.

Read the [messaging decision](../decisions/0011-agent-messaging.md) and
[live-validation guide](live-validation.md) first. Keep separate verdicts for
configuration, hook handlers, actual host invocation, planner response and
human-visible attention. A configured hook or passing handler test does not prove
that a real host invokes it.

## Automated checks

Run the focused suite from the repository root:

```sh
bun run test test/messaging-hooks.test.ts test/messaging-broker.test.ts test/messaging-liveness.test.ts test/messaging-attention.test.ts test/messaging-identity.test.ts test/messaging-store.test.ts test/messaging-regressions.test.ts test/doctor-hooks.test.ts
```

Map the following expectations to existing tests before adding coverage. Use
isolated state and controlled time for timing boundaries.

| Scenario | Expected result |
| --- | --- |
| Unread report with default Stop policy | First two calls block and include the message; the third allows stopping and records escalation. |
| Changed or empty pending set | A new set resets the block counter; an empty set clears it. |
| Acknowledged report | Marking it read removes it from hook context. |
| Read but unanswered question | It remains in hook context until a linked answer exists. |
| Prompt hook | Host-specific output includes pending context and reply instructions; an idle inbox produces no output. |
| Two planner sessions | Private messages remain session-specific; the documented generic planner-kind inbox is shared. |
| Disabled hooks or malformed input | Off/inject-only do not block Stop; executor sessions skip; malformed input fails open. Check prompt behavior separately. |
| Large inbox or message | Hook excerpts remain bounded and point to the inbox; stored messages are retained. |
| Normal/relaxed escalation | No early escalation; unread external messages escalate after the configured delay, default 900 seconds, on a broker tick. |
| Strict/emergency escalation | Escalation occurs without starting a paid nudge turn for the external planner. |
| Stop release followed by reconciliation | Third Stop, broker tick and attention read preserve the escalation rather than losing it between components. |
| Resolution | Acknowledgment or linked answer clears the corresponding stall after reconciliation; unresolved questions remain actionable. |
| Reopened state | Messages, reply links and Stop counters persist; replaying a request ID does not duplicate its message. |

Report discrepancies between documented expectations and source behavior as
findings. Do not weaken an assertion solely to make the suite pass.

## Live host checks

Inventory Codex and Claude Code separately, including host versions, selected
accounts, integration configuration and actual hook support. A handler accepting a
planner name is not proof of that host's support.

Use an unseeded live sandbox, its disposable repository and guarded commands.
Use a supported isolated or project-local host configuration. Never rewrite the
operator's real integration settings or copy credentials into fixtures. The
harness refuses integration installation through D3/D8; do not bypass it. If no
safe host-launch path exists, mark that host UNVERIFIED.

1. Launch a real external planner and capture its genuine session identity.
   Do not substitute a pacer-owned executor with an impersonated planner identity.
2. Have one harmless delegated executor send a uniquely marked report or question.
   Capture task, message, sender and recipient IDs. An executor driving this
   scenario needs the applicable work grant to delegate; otherwise use an
   authorized planner.
3. Let the external planner attempt to finish. Capture the actual Stop event,
   hook result and planner reaction. Observe acknowledgment or a linked answer,
   then a clean stop. If the planner responds immediately, do not claim that a
   third Stop was observed; repeat-block behavior can remain a handler test.
4. In a separate case, leave a message unread and submit the next user prompt.
   Capture actual prompt-hook invocation and consumed context. Calling the hook
   CLI directly is insufficient evidence of host invocation.
5. Close only the disposable planner session with a report still unread. Verify
   retained inbox contents and human-visible attention after the configured delay.
   Observe one normal-mode default-delay run, allowing for broker scheduling
   latency. Keep waits interruptible. Record effective sandbox mode; it need not
   match the operator's mode. Check strict-mode escalation separately.
6. Resume the same external session where supported and verify pending context
   returns on the next prompt. A new session has a different identity and is not
   equivalent. Record generic inbox behavior separately.
7. Capture the actual human-facing attention item and its task/message link.
   Verify resolution clears it. A stored liveness timestamp alone does not prove
   visibility to a human.
8. Exercise service interruption and reopening retained isolated state only where
   supported by the harness lifecycle. A fresh empty sandbox does not establish
   restart persistence. Otherwise mark live restart UNVERIFIED.

The closed-planner expectation is retained work and human escalation. These hooks
do not independently wake a closed external planner application.

## Cleanup and evidence

Inventory sandbox-owned tasks before teardown. Stop each active executor with
`bun run live pacer --id <id> -- stop <task-id>` and verify termination.
`live down` does not stop independently running executors. If termination cannot
be verified, preserve the sandbox and report cleanup incomplete.

After executor cleanup, generate `bun run live report --id <id>` and tear down
with `bun run live down --id <id> --keep`. Retain sanitized transcripts and
timestamps under `.work/`; never commit working evidence or credentials.

The result matrix should name the source revision and working-tree fingerprint,
host/version, effective configuration, scenario, handler result, host invocation,
planner response, human visibility, evidence reference and PASS/FAIL/UNVERIFIED
verdict. Obtain independent review of any test changes and the final evidence.

Validation requires passing targeted checks, an observed real external
planner/executor exchange, visible unattended-work escalation and verified
resolution. If the required live exchange or human attention cannot be exercised,
the result remains incomplete/UNVERIFIED even when automated tests pass. Identify
each unexercised host and recovery surface separately; do not claim a guarantee
that external planners can never lose track.
