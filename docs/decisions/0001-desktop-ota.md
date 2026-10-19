# Desktop updates as recoverable native transactions

Date: 2026-10-19

Status: Accepted design. Implementation and release validation are tracked separately.

Context: [desktop OTA design](../specs/2026-10-19-desktop-ota-design.md), [clients over the local service](2026-10-16-clients-over-local-service.md).

The macOS desktop, bundled CLI and local service must remain a compatible release. Updating an executable while work is starting can interrupt tasks; replacing the app can also terminate the process responsible for undoing a failed update. Public client registration and an HTTP health response do not establish ownership of a native process or installed service.

## Decision

Ship a complete versioned app containing the desktop, CLI and external update helper. The first OTA-capable release requires manual installation. Support stable releases for Apple Silicon and Intel; Linux, remote hosts and npm/Homebrew installations retain their existing update methods.

The service owns update state and exposes additive `desktop.update.*` operations over protocol v3. Public update status omits installation paths, signing material and native authorization; adoption confirmation identifies the inspected current and replacement service executables. Browser, tray, CLI and TUI controls use these operations. A revision and request receipt bind each action; repeated requests do not create fresh restart permission. The legacy `update.*` operations remain distinct.

Downloads may run automatically. Installation requires an explicit, version-bound restart request. Managed-service updates wait for work and reserve admission with the same cross-process SQLite transaction used by work launchers. Waiting never kills tasks or sessions. The native helper independently verifies the reservation and original restart grant before effects begin.

Native identity uses the current user's exact process incarnation, boot identity, signed executable and service registration. Fresh Unix-domain connections provide kernel peer credentials. An inherited launch socket delivers a private capability, but is not treated as proof of the receiving process's identity. The desktop proves readiness after native authentication, web authentication and a valid v3 state read; heartbeat or public `kind: desktop` registration is insufficient.

An external helper owns a durable private journal and recovery job. It records each effect's intent before execution and its observed completion afterward. It retains an independently verified old bundle and the exact service registration, including the disabled override. It waits for desktop and service readiness for at most 120 seconds of awake time. An uncommitted attempt restores the old package and registration; a durable committed transaction permits cleanup only. User data is never restored from a stale directory copy.

For a managed service, the helper obtains a maintenance acknowledgment, rechecks the idle reservation and exact authenticated job identity, then uses launchd `bootout` for that owned job. It proves both job absence and process exit before replacement. Disabling a loaded `KeepAlive` job is insufficient: live disposable validation observed launchd restart it after natural exit. PID-directed termination is not a substitute, and an attached or unverifiable job is never removed.

The pinned Tauri updater performs package verification and replacement. Its required `no-elevation` feature rejects permission failures, including failures after preflight. Pacer does not request administrator access or substitute another installer. Native filesystem checks, stable locks and recorded backup identities preserve uncertain recovery evidence.

Attached mode replaces only the app and reconnects to the compatible external service. It does not reserve, stop, maintain or rewrite that service. Moving to the bundled service is a separate, explicit adoption transaction with its own durable authority and restoration contract; it must not be represented as a fabricated package update.

Production builds pin the updater public key and Apple Team ID at compile time. The native transport uses a build-time library signed with the same Team as the CLI, checked at its fixed bundle or detached sibling path with ABI1. Native-enabled compiled CLIs never compile C at runtime or disable library validation. Releases use Developer ID signatures, notarization, stapling and a separate version-bound updater signature. The desktop feed advances only after both architectures' immutable artifacts validate. Development and fixture builds cannot authorize production publication. A fixture build additionally binds all native authority to a specific private live-harness lease; runtime environment variables cannot select another installation or signing policy.

## Consequences

Updating requires more than downloading and relaunching: process provenance, launch admission, native recovery and release publication form one contract. Unknown identity, registration shape, state compatibility or cleanup ownership causes a refusal that retains evidence.

An update can be unavailable when another legacy CLI process cannot be covered by the admission protocol. Arbitrarily renamed legacy binaries cannot be identified universally; supported coexistence and actionable refusals must be documented. Unsupported macOS service-manager observations also remain unavailable rather than being inferred from a health endpoint.

Fixture success proves only the surfaces actually exercised. Production signing/notarization, both architectures, process restart, restoration and client reconnection require their own evidence. The live harness reports unexercised surfaces as **UNVERIFIED**. No publication or installed-app mutation follows merely from a successful unit test or unsigned build.

The existing proposed governance rules are unchanged. This ADR records the desktop versioning and signing design associated with OD-5; it does not silently establish the proposed REL-8 rule or change the constitution's amendment process.

## Alternatives considered

- Reuse CLI self-update: cannot replace and restore the complete desktop package consistently.
- Run installation inside the desktop process: loses recovery ownership when that process exits or is replaced.
- Trust public client claims or PID alone: does not prove signed native identity or protect against PID reuse.
- Permit administrator fallback: makes a permission race capable of crossing the approved installation boundary.
- Stop work to install immediately: violates the explicit wait-for-work behavior and risks task state.
