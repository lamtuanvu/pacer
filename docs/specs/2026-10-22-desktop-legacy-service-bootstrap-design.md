# Enable desktop updates from a CLI-installed service

Status: initial written design and implementation plan approved by the maintainer on2026-10-22. The compatibility amendment at the end is pending separate review after the baseline audit. Existing signed-service adoption and OTA remain unchanged until the complete design is implemented and validated.

## Intended outcome

A user who installed the CLI first can select **Enable automatic desktop updates** in Settings → Updates. Pacer identifies the current and bundled service, waits for active work, switches the one registered service to the bundled signed CLI, verifies readiness and then resumes normal automatic desktop checking/downloading. The user still approves each package installation through **Restart to update**. Settings and data remain in place. The standalone CLI, hooks, credentials and unrelated jobs are preserved.

Connection errors are explicit. Missing desktop update state is not interpreted as permission to present manual download as the normal update path. Manual installation remains a labelled secondary option. Unsupported migration sources receive an explanation; they are never stopped by force.

## Current failure and scope

The signed desktop authenticates the native service with the release certificate. Ordinary standalone CLI releases use ad-hoc signatures and lack the compiled native channel. Requiring that channel before offering adoption makes the existing migration unreachable. Removing one certificate check is insufficient: connection authentication, helper preparation, readiness, original-branch recovery and service composition all enforce signed authority.

Extend the existing adoption system with a separate, transaction-scoped legacy source capability. Do not make unsigned code eligible for the ordinary native session or general OTA authority. Do not use the first-run installer to replace a live external service: its current guards do not establish a reservation or independent recovery.

Applicable rules: P1/P2/P4/P5/P6/P9–12; ARCH-1–3/9; SEC-1/3–5/7/8; API-1–5; CT-1–6/8/11; UI-1–3/6/8–25; REPO-1–7. Existing OTA ADR0001 remains authoritative for admission, no elevation, durable native effects and recovery. An ADR must record the narrowly scoped source-provenance extension before production enablement.

## Legacy source identity

A signed desktop performs read-only discovery of the fixed current-user service registration. It checks the exact loaded job, home, port, argv/environment, plist bytes, executable path, file ownership/type, native UID, PID/birth/boot identity and running code identity. Redirected, ambiguous, foreign or writable-by-others resources are refused.

Publisher provenance for an ad-hoc legacy executable comes from a reviewed compile-time allowlist of exact immutable official release artifact SHA256 values, with version, architecture and admission compatibility. The allowlist is part of the signed destination, never accepted from HTTP, an environment variable or a caller. Verify both the file digest and its running code identity against the inspected process; inspecting a file at the same path alone is insufficient. No arbitrary source executable is run to discover its version.

Audited history includes official macOS standalone releases0.6.2 and0.7.1. These entries remain ineligible: direct self-update does not participate in the admission reservation. Checksums below identify unsupported baselines; they do not activate migration. Candidate checksum records from the official release assets are:

| Version | Architecture | SHA256 |
| --- | --- | --- |
|0.6.2|arm64|df81746902afc4c07a538c9688000403a54b0d7ad75126cbca8897091e66eabe|
|0.6.2|x64|d412b332e75a0714f592774b09730e5497bff115f44e3d5edc4796510fcdbc0e|
|0.7.1|arm64|f37bb3f6c2dd804e69c0651bda6fd4846ab92b00623b4dc95d75e89e64bbb340|
|0.7.1|x64|4f5d5be10f5c7bbe63f6dd31f6645e05e95940981dcf44d6a0064e3486286abb|

Checksums establish a specific baseline, not a general trust exception. The implementation must verify artifact provenance and audited admission coverage before activating any entry. Unknown releases, npm/Homebrew wrappers, altered binaries and incompatible state remain attached with a specific reason. A destination older than the source is refused. Hash/file/process/job identities are rechecked before each effect and original-branch recovery; drift retains evidence rather than executing changed code.

## Core bootstrap coordinator

The signed desktop starts a fixed, canonical bundled CLI bootstrap mode through a fresh inherited channel. The CLI verifies the signed desktop's native peer/parent identity, exact app/bundle, home/port and one-use session before accepting requests. It runs a minimal core service coordinator, not another normal work scheduler. It must not pump tasks, claim to be the old service or bind the old HTTP port.

The coordinator exposes a versioned, typed private API for inspect/status, authorize, cancel and readiness. The UI never opens the database or decides idle. Public requests identify only an opaque inspected candidate, request ID and revision. They cannot provide a path, code hash, signing key, URL, arbitrary command or trust-policy flag. The native shell relays only these bounded operations from the exact authenticated main-window origin. Browser/CLI surfaces retain their ordinary service operations and honest unsupported status when this native bootstrap capability is absent.

The coordinator is a pinned bundled CLI process and remains distinct from the legacy source process. Its source capability binds all inspected identities, release digest, compatibility, fresh nonce, native desktop session and transaction. Native helpers authenticate this pinned coordinator; they do not authenticate the legacy source as a release-signed coordinator.

## Waiting and reservation

After confirmation, the core coordinator uses the existing cross-process admission/coordinator transaction and the audited legacy baseline's gate. It checks durable task/session/launch/operation leases, known external work and concurrent updates. It waits without stopping work and publishes blockers. Cancellation is available until reservation and preparation become durable.

An allowlisted baseline must actually obey this same admission protocol for every supported work/update entry point. Structural schema similarity is insufficient. Refuse unsupported or uncertain work coverage. The final idle reservation must atomically exclude new work across the old service, direct CLI runners and the bootstrap coordinator. Service restart, user changes to registration, source replacement or conflicting maintenance invalidate authorization.

## Transaction and recovery

Extend the existing adoption journal with an additive discriminated source provenance record: existing records without it retain the signed-source policy; legacy records carry the exact capability and digest. Unknown variants fail closed. TS/Rust schema parity and authorization/manifest hashing cover every field.

1. Reverify the signed app, canonical bundled CLI/helper/shim, source capability, compatible state and idle reservation.
2. Snapshot exact original registration/override, persist preparation and explicit user authorization, and arm the independent signed recovery job before mutation. No user data snapshot is restored later.
3. Compare the current registration to the approved bytes. Stop only that exact job, prove its absence and original process exit, and switch only its executable to the pinned bundled CLI.
4. Start the managed service and verify native identity, registration, fresh process incarnation, authenticated desktop sign-in and valid state read. A heartbeat or HTTP PID claim is insufficient.
5. Commit durably, release admission and retire recovery only after observed readiness.

Before commit, failures restore the exact original registration and verify the identical allowlisted source, process/job and authenticated web/state readiness. Restoring the legacy branch does not require pretending it supports signed OTA. The signed coordinator/helper owns this limited recovery proof. Missing/changed original code, ambiguous jobs, failed readiness or reboot uncertainty preserve the journal and reservation with recovery-failed status. Recovery never substitutes another same-path binary. The original CLI is not overwritten or silently copied elsewhere.

## UI and diagnostics

Settings distinguishes pending native connection, verified native status, failed verification, unsupported build and an eligible legacy migration. The read-only native diagnostic returns public state/reason only, never a capability or paths. Missing/unknown IPC in an older shell gives an honest unavailable message.

An eligible source offers **Enable automatic desktop updates**. Confirmation names the independently inspected current/replacement service paths, version, label and port, says data/settings stay in place, and explains that active work finishes first. It binds the opaque candidate/revision. **Cancel service change** remains visible while waiting. After success, show normal desktop status and automatic-download preference. After failure, show restored or recovery-needed status and retain diagnostic evidence. Manual download is a labelled secondary disclosure.

## Validation and rollout

TDD must cover signed/legacy discriminator compatibility, exact digest and running-code binding, UID/PID reuse, same-path edits, symlink/foreign/writable registration, altered argv/environment/home/port, source/destination downgrade, state incompatibility, missing work coverage, stale/replayed/expired consent, duplicate requests, concurrent updates and work, unsigned destination/helper and recovery drift. Source exceptions must be rejected on every normal OTA path.

Use the live harness with an immutable compiled fixture baseline whose standalone CLI has an ad-hoc signature and no native OTA channel. Its digest and scope come from the build lease; production cannot accept runtime fixture hashes. Exercise wait/cancel, migration, data/settings preservation, native readiness, every crash/restore boundary and retained failure. Verify the original CLI bytes/hooks and unrelated registrations stay unchanged. Run Rust offline tests, TS/typecheck/UI policy, regenerated assets and independent security/QA/UI reviews. Native and VoiceOver gaps remain UNVERIFIED until exercised.

A newly installed signed desktop containing this bootstrap is required; an already-running old desktop cannot acquire a new native capability from an updated web page. Do not claim this fixes old installed binaries without one explicit installation of that baseline. Do not enable the production legacy capability before the complete live matrix passes. Never alter the user's real service as a substitute for isolated validation.

## Alternative considered

Signing future standalone CLI releases alone does not repair already-running old services and requires changing their installation. Weakening global signature checks or reusing first-run replacement skips the admission/recovery guarantees. Both alternatives are rejected for this migration.


## Proposed compatibility amendment after audit

The existing direct standalone updater bypasses admission and can change the executable, integrations and registration while migration holds a reservation. Therefore shipped0.6.2/0.7.1 sources are not eligible under the approved exclusion guarantee. File/process/registration drift detection is necessary but not a substitute for exclusion.

Ship a new standalone CLI baseline whose mutating self-update and service install/restart/uninstall paths acquire the same admission/maintenance gate. Existing users explicitly select the normal **Update service and restart** operation once to install that baseline, then select **Enable automatic desktop updates**. The bootstrap still preserves the CLI it adopts; an ordinary user-requested CLI update is a distinct operation, not a hidden bootstrap side effect. Unsupported npm/Homebrew installations retain their own explicit updater guidance.

The release pipeline builds that ordinary standalone baseline first, hashes its immutable artifact, then compiles the digest and audited compatibility into the signed desktop/helper/bundled coordinator. The standalone build does not embed its own hash, avoiding a circular build. Unknown or older baselines stay unavailable with an actionable explanation. This extends the implementation plan with baseline gate regressions and production packaging evidence before any candidate is activated.
