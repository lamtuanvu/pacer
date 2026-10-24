# Native fixture request diagnostics

## Intent and constraints

M1 live validation observed a desktop restart request time out with no matching durable restart receipt or native journal. Existing evidence cannot distinguish proxy body reading, compiled fixture ownership checks, forwarding and upstream completion. This change supplies that missing evidence; it does not establish a cause or make a failed update pass.

Only the live harness changes. Keep all D8 checks, exact driver/lease/installation bindings, request matching, native checks, current deadlines, response semantics and teardown rules. Never retry an update, clear a retained request/reservation or choose a different helper as a diagnostic effect. Native tool credentials are never read or logged.

## Approaches

Existing logs and read-only store correlation narrowed the failure but cannot identify delivery. A synthetic Bun HTTP probe did not reproduce the suspected normal clone/cancel hang. Increasing timeouts or changing authorization without stage evidence would not establish the cause. Use fixed, bounded harness stage traces instead; this is an implementation choice under the maintainer's autonomous debugging authorization.

## Trace contract

Record a random diagnostic correlation ID, fixed update operation, fixed stage/outcome, elapsed milliseconds, and a bounded HTTP status when available. Stages distinguish body collection, initial policy, native ownership, final policy, forwarding and upstream completion/error. Do not emit raw request IDs/nonces, body/response contents, tokens, audit tokens, file paths, window titles or arbitrary error strings.

Append to the session's private evidence file `ota-request-trace.jsonl`, capped at1MiB. Refuse symlinked/non-private/multiply-linked or nonregular destinations and unsafe evidence directories. A trace write or callback failure is best-effort and must not change authorization, forwarding, response or refusal. Do not add a public diagnostics endpoint or a caller-selected file/command.

## Verification

Use focused negative tests for missing/invalid/refused body and policy, owned/refused helper checks where existing seams permit, trace callback failure, private-file ownership/symlink/link/mode and cap controls. Compare trace-enabled/disabled HTTP behavior through real synthetic loopback proxy requests; exercise forwarding and upstream errors without native effects. Show that stage order identifies a delayed upstream and that no sensitive supplied values appear in traces.

Actual managed update, native tray and retirement acceptance remain required and UNVERIFIED until exercised. Synthetic diagnostics tests do not certify M1 delivery. Prior failures and the pending request stay preserved.
