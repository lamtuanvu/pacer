# Automatic integration reconciliation

## Intent

After upgrading Pacer, previously connected agents receive the current bundled
hooks, policy and skill without requiring doctor or a manual reconnect. The
service owns reconciliation. New agent launches check the selected integration
before starting. Existing conversations retain instructions already loaded.

## Approaches

1. Refresh only in each updater. Simple, but misses package-manager upgrades and
   duplicates lifecycle handling across CLI and desktop.
2. Refresh inside agent hooks. Covers some externally started sessions, but adds
   latency and mutates the configuration currently invoking the hook.
3. Reconcile at service startup, with a launch-time freshness check. Selected by
   the maintainer in conversation: it covers all upgrade channels and centralizes
   behavior without making agent hooks perform installation.

## Current behavior and scope

`src/commands/update-refresh.ts` invokes the replacement binary's installer for
four default planner keys. Named-account records are skipped. Doctor checks
recorded file hashes, which proves integrity against the previous installation,
not freshness against the running release. `src/install/txn.ts` provides rollback
and undo records, but currently writes directly and permits optional subprocesses.

Reuse the integration adapters and manifest ownership records. Add one shared
reconciliation implementation under the installation boundary, coordinated by the
service/core. Keep integration-specific file formats in adapters. This is not a
new plugin capability: it maintains integrations already owned by installers.

## Desired state and ownership

- Only manifest-recorded agent integrations are eligible, including named
  accounts. Service and unrelated installation records are excluded. Never
  discover an agent and connect it automatically.
- Preserve each record's agent, account, explicit folder and configuration
  environment. Validate recorded targets against current account configuration;
  ambiguous or changed account identity requires reconnect rather than silently
  moving the installation or writing to the default account.
- Adapters expose a deterministic, file-only desired-state plan. No authentication,
  MCP registration, agent CLI invocation or legacy cleanup subprocess runs during
  automatic refresh. Explicit connect retains its existing consent flow.
- Fingerprint the desired managed assets, adapter/schema revision, target identity
  and resolved Pacer command. A release version alone is not freshness evidence.
  The implementation chooses the precise canonical representation.
- A matching fingerprint still requires a lightweight managed-content integrity
  check before launch. Record success only after writes and manifest persistence
  succeed. Legacy records with no fingerprint are reconciled on first use.

## Safe application

Plan changes before writing. Fully owned files can be replaced when their content
matches the last installed hash, or already matches the desired content. A modified
owned file is a conflict and is preserved. Missing owned files can be recreated.
Shared settings are edited structurally: preserve unrelated fields, hooks and
text; compare the Pacer-owned portion against its previous state. Unrelated edits
must not cause conflicts. Malformed configuration, changed managed content or an
unprovable ownership boundary produces an actionable conflict instead of an
overwrite. Add ownership metadata as necessary; legacy shared files may migrate
automatically only when ownership can be established safely.

Serialize reconciliation, connect and disconnect with the same cross-process
installation lock. Re-read the manifest under the lock. Detect external edits
between planning and application before replacing a file. Use atomic restrictive
file writes and atomic manifest persistence, retaining rollback and uninstall
history. A failed account must not be marked fresh or prevent other accounts from
being reconciled. Crash recovery must leave records retryable; reconciliation is
idempotent. The builder chooses staging/journal details and bounded lock timeouts.

## Lifecycle and failure behavior

At startup, the running service schedules reconciliation of all recorded agent
integrations. Status and diagnostics remain available while this runs. Work
admission must await readiness for the selected local integration, preventing a
launch from racing startup writes. Use the same check for delegated execution,
interactive conversations and local resume/takeover paths wherever they start a
new agent process. Cover direct and Orca local execution through a common
pre-launch boundary where possible. Remote SSH hosts are out of scope and must
not receive configuration writes.

An account without a recorded integration is unaffected and may launch normally.
For a connected account whose required managed assets cannot be refreshed, fail
that launch with a structured error and a specific reconnect/repair hint. Do not
disable unrelated accounts or terminate existing sessions. Recheck failed records
at the next relevant launch or service startup; avoid an unbounded background
retry loop. Concurrent callers share or wait for reconciliation rather than
starting duplicate writes.

Success is silent. Failures remain visible through existing doctor/diagnostic
checks and service logging, with no credentials or full configuration contents.
Doctor remains read-only and reports freshness separately from file integrity;
its existing explicit repair/connect flow uses the shared safe planning/application
logic. No new UI is planned. If the current diagnostic contract cannot represent
this, add compatible diagnostic entries rather than private client file reads.

The CLI updater must use the new binary's reconciliation implementation, since
the updating process embeds old assets. Remove its hard-coded default-only
refresh loop. Honor an explicit update skip flag for that update invocation;
normal subsequent service startup and launch readiness still apply. Desktop and
external package upgrades need no separate asset migration engine: adoption of
the new service triggers the lifecycle check. An upgrade that leaves the old
service running takes effect when the updated service is adopted; do not claim
otherwise.

## Constraints and non-goals

Applicable governance: ARCH-1–5, ARCH-7–9, ARCH-12–14; SEC-1, SEC-5–7;
CT-1–7, CT-11; REPO-1–7, and API-1–5 if API contracts change. References:
`.project/constitution.md`, `.project/context.md`, `.project/rules/architecture.md`,
`.project/rules/security.md`, `.project/rules/code-and-testing.md`,
`.project/rules/repository.md`, `.project/rules/api-protocol.md` and reviewer
definitions for architecture, security, protocol compatibility and QA.

Do not modify native credentials, bypass agent hook trust, install new
integrations, alter remote hosts or retrofit already loaded conversations. Host
trust prompts may still require the user's action after a hook command changes.
Preserve the established plugin and client/service boundaries. Record this durable
lifecycle choice in an ADR during implementation. No governance exception is
requested. Working plans/reviews/evidence stay in untracked `.work/`.

## Validation

Tests must prove upgrade from legacy records, current-content no-op, changed asset
fingerprints, default and named accounts, explicit target folders, missing files,
shared-setting preservation, modified managed content, malformed files, concurrent
reconcile/connect/disconnect, external edit detection, rollback/retry and
diagnostic freshness. Verify pre-launch gating across applicable launch paths,
unconnected accounts and unaffected existing sessions. Assert automatic refresh
does not execute agent CLIs or read credentials.

Run typecheck, the relevant isolated tests and the required full checks. Follow
`docs/testing/live-validation.md` with `bun run live`: demonstrate stale installed
assets converging after service startup, idempotent restart, named-account
targeting, conflict reporting and a real executor launch using refreshed assets.
Record evidence under `.work/live/` and report every unavailable surface as
UNVERIFIED. This document defines behavior; it does not claim implementation or
live validation has passed.
