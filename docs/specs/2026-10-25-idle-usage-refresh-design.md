# Idle usage refresh

## Intent

Pacer should update account usage while its executor is idle. A user can also ask
for an immediate refresh. The service owns scheduling and publishes the resulting
readings to all clients; each provider adapter owns the actual read.

## Goals and boundaries

- Refresh configured accounts automatically at a bounded interval, and expose a
  manual refresh through the versioned API and CLI. The app's Usage action calls
  that same operation.
- Make the result explicit: a fresh provider observation, an unchanged passive
  observation, an unsupported live read, or a failed read. Preserve the provider's
  observation time; polling time must never make old usage fresh.
- Share coalescing, timeouts, backoff, and per-account concurrency control in the
  service. Read failures retain the last reading as historical and report the
  failure to clients.
- Never start a coding turn merely to check usage, and never read or copy a
  native agent's credential or Keychain entry.

## Approach

The selected design is a provider usage-adapter contract with `read` and
`refresh` capabilities. The service iterates configured accounts, schedules
refreshes, and offers one refresh operation. It does not branch on provider
identity. An adapter declares whether it can actively fetch a live reading,
only reread passive telemetry, or has no numeric usage source. Provider-specific
logic stays behind that contract and, when extracted, behind the versioned plugin
protocol rather than growing a second host-owned provider implementation.

The Codex adapter queries its own app server's read-only rate-limit operation
using the account's selected home, without submitting a turn. Existing BytePlus
and metered provider commands remain their adapters' live sources. Claude reads
its status-line and session telemetry; an idle Claude account with no new data
stays historical. Reactive and unmetered accounts do not invent a percentage.

Automatic refresh runs in the service even when no app window is focused, with a
conservative default interval and provider-specific throttling where required.
Manual refresh coalesces with an in-flight automatic read. A caller sees the
source, observation time, refresh outcome, and any failure without receiving
credentials or raw provider output. Status and routing use the same resulting
evidence and freshness rules.

## Alternatives considered

- **Launch small agent probes:** could obtain Claude telemetry while idle, but
  consumes subscription capacity and may start agent work. Rejected.
- **Read native OAuth credentials and call provider endpoints:** can fetch idle
  Claude usage, as Orca does, but conflicts with Pacer's established credential
  boundary (P5, SEC-1). Rejected.

## Verification

Test adapter capability and failure behavior, concurrent manual/automatic
refreshes, observation timestamps, multi-account isolation, and API/CLI results.
Run typecheck, tests, generated-artifact checks, and CT-11 live validation of
idle Codex and command-backed accounts through the affected clients. UI changes
also need the repository's UI, accessibility, QA, and screenshot evidence.

## Governance

Constitution 0.13.0; P1–P6, P9, P13–P14; ARCH-1–3, ARCH-5, ARCH-8–9,
ARCH-12–14; API-1–5; SEC-1, SEC-5, SEC-7; CT-1–5, CT-11; REPO-2–3, REPO-7,
REPO-10; applicable UI rules. No exception is proposed. The existing plugin
extraction schedule and the host's lack of a usage plugin are open implementation
constraints; implementation must avoid adding a competing permanent host adapter.
