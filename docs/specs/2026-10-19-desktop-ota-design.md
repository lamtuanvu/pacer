# macOS desktop OTA updates

Date: 2026-10-19
Status: Approved by the maintainer in conversation on 2026-10-19. Implementation is in progress.

## Intent and agreed scope

Let a person keep the installed pacer desktop app current without terminal commands. An update must protect ongoing work and leave a usable installation if the new release cannot start.

The maintainer selected desktop-first updates, macOS first, automatic downloads followed by an explicit **Restart to update**, and whole-app releases using Tauri's updater. The app, bundled service binary, and embedded web UI ship together. Updates wait for running tasks and live terminal sessions; they never close those sessions automatically. Recovery retains the previous complete release. Existing external services require an explicit migration before desktop takes ownership.

Initial scope includes Apple Silicon and Intel, one stable channel, release signing and notarization, service ownership migration, shared update operations, native installation/recovery, and isolated live validation. Linux/Windows OTA, prerelease channels, delta downloads, unattended installation, remote-host updates, and automatic modification of npm/Homebrew installations are excluded.

Defaults newly made concrete in this document, and subject to written-spec review: a 24-hour background check interval, a 120-second startup verification window measured while the machine is awake, and cancellation of a waiting restart request when the requesting desktop quits or the machine restarts. These are design defaults, not separately confirmed user preferences.

## Existing implementation and constraints

- `src/update/update.ts` and `replace.ts` implement CLI release download, checksum/size verification, a version smoke test, backup, binary replacement, integration refresh, and service restart. npm, Homebrew, and source installations have distinct refusal/guidance paths.
- `src/api/ops.ts` already exposes `update.check` and `update.apply`. Desktop OTA adds a separate target; it does not silently change those existing operations into app installation.
- Desktop discovers bundled or external CLIs, but `desktop/src-tauri/tauri.conf.json` and `.github/workflows/desktop.yml` currently produce unsigned desktop artifacts without a bundled CLI. The workflow does not publish desktop releases.
- The macOS bundle watcher in `desktop/src-tauri/src/main.rs` relaunches after external replacement. OTA must coordinate with it to avoid a second relaunch.
- `scripts/release/prepare.ts` does not currently synchronize desktop package versions.
- The live harness blocks installed-binary updates and real service-manager mutations. Those guards remain in force.

This design follows constitution 0.2.0 and the [context index](../../.project/context.md). Governing rules are ARCH-1–9, API-1–6, SEC-1–9, REL-1–5/7, REPO-1–7, CT-1–6/8/11, and UI-1–6/8–18. Proposed rules are not treated as established requirements. In particular, version synchronization is a choice in this design, not an assertion that proposed REL-8 has already been adopted.

Applicable advisory reviewers: [architecture](../../.project/reviewers/architecture.md), [protocol compatibility](../../.project/reviewers/protocol-compat.md), [security](../../.project/reviewers/security.md), [release](../../.project/reviewers/release.md), [QA](../../.project/reviewers/qa.md), and [UI/accessibility](../../.project/reviewers/ui-accessibility.md). These references and rule IDs must accompany the implementation plan and delegated briefs.

## Approach and responsibility boundaries

Use one versioned app package. Separate app/service update streams would multiply compatibility combinations and partial failures. Extending the CLI binary replacer into a custom macOS application updater would duplicate platform installation work.

The service owns update policy, durable intent, readiness, and admission of new work. Every client requests these through the versioned API. The desktop renders shared state and provides its installation identity; it does not independently decide that the service is idle.

A native update adapter uses Tauri's updater facilities for release discovery, artifact verification, and installation. A recovery helper runs from a private, durable location outside the app bundle and survives replacement of the app and shutdown of the service. It executes a narrowly scoped transaction authorized by the core. It cannot route tasks, edit user configuration, or select arbitrary binaries to install. Normal helper progress returns to the service; during service downtime its journal is the transaction's recovery authority. On startup the service reconciles that journal before admitting work.

This is an adapter responsibility under the service-owned operation, not a second task engine in the desktop. CLI/API users can inspect and request the same operations for a registered desktop installation. Headless installations retain the existing CLI update path. The Orca panel remains information-only.

Tauri supports separate download/install steps and signature verification; pacer must supply task coordination and post-install recovery. The external-helper feasibility probe passed with Tauri 2.12.4 and updater 2.14.0. Pacer carries a pinned updater patch with a required `no-elevation` build feature: macOS permission failures return through existing cleanup and backup preservation instead of requesting administrator access. A real filesystem-denial regression and a signed disposable replacement validate this boundary. The patch preserves upstream signature verification and installation mechanics; it must be revalidated on dependency upgrades. If it cannot satisfy the transaction contract, revise this design before shipping; do not silently drop recovery or replace Tauri with an unreviewed installer.

## Installation identity and migration

Persist an installation identity tying together the canonical app location, owner, bundle identifier, architecture, managed service registration, `PACER_HOME`, and port. Verify these against the actual service process and registration before every mutation. A matching port or process name alone does not establish ownership. Moved apps, ambiguous ownership, an unrelated registered service, and read-only/translocated app locations produce actionable installation guidance before stopping anything.

Fresh desktop installations use the bundled service. A separately installed CLI remains independent; desktop updates never overwrite it. The bundled executable must refuse standalone self-replacement through both `pacer update` and `update.apply`, because changing one executable would invalidate the signed app and split its release. Return guidance to the desktop update operation. Detect bundle membership even when the binary is invoked directly without installation environment markers.

For an existing external service, offer **Use the bundled service** as an explicit one-time migration. Inspect and display the service being adopted, preserve its data/settings and registration for recovery, wait for active work, reserve it, then switch the registration to the bundled executable and verify startup. Do not rewrite the external CLI, planner hooks, account credentials, or unrelated service jobs. Refuse automatic migration if the existing service cannot establish a safe idle reservation; show an explanation instead of killing it. A newer incompatible data format also blocks migration.

Declining migration keeps the external service and its update method. The complete desktop package can still be updated in attached mode only when the external service's protocol is supported by the target desktop. Such an update replaces the app only, leaves service registration and tasks untouched, and verifies reconnection to the same external service. An incompatible pair requires updating the external service or choosing migration first. This attached-mode compatibility behavior is a concrete proposal for written-spec review.

## API and concurrency contract

Add a `desktop.update.*` operation family rather than changing the established meaning of `update.check/apply`. Proposed operations are `status`, `check`, `download`, `restart`, `cancel`, and `configure`; expose service adoption through a distinct explicit operation. Internal adapter registration, progress, and verification acknowledgements must be bound to an authenticated installation and transaction, not accepted as arbitrary client assertions.

Public requests identify a registered installation, never an executable path, shell command, public key, or download URL. `restart` includes the offered version and observed revision so a newer release cannot replace what the user approved. Repeated requests with the same request ID return the existing transaction; conflicting operations or stale revisions return `CoreError("conflict", ...)`. All update entry points share the installation lock, including legacy binary updates and service adoption.

Status includes installed/target versions, ownership mode, phase, download progress, blockers, permitted actions, and a plain failure reason. Publish additive snapshot fields and progress events; clients can recover from missed events by reading status. Keep existing protocol operations and envelopes backward compatible, regenerate protocol docs, and preserve normal loopback authentication, Origin checks, and client headers. The UI receives no helper credential or signing secret. Keep native updater access behind the adapter; do not grant web content general updater or filesystem permissions. Any required desktop IPC remains scoped to the exact authenticated service origin under SEC-8.

## Download and user experience

While a registered desktop is running, check on launch when the cached check is older than 24 hours, then every 24 hours with jitter. **Check for updates** bypasses the cache with request deduplication. Respect existing update-check opt-outs. Persist an automatic-download preference, default on; disabling downloads does not disable explicit checks or manual download.

Checks and downloads are bounded, cancellable network operations. Failures use bounded backoff and leave the installed app usable. A partially downloaded archive is never eligible for installation. Validate the complete archive again before installation; metadata alone cannot establish its identity. Retain only the selected candidate and the previous recovery release, cleaning abandoned downloads after transaction reconciliation.

Settings → Updates shows current/available version, release notes, progress, last check, and the appropriate next action. Render release notes as untrusted content. Use **Restart to update** only after verification. The tray shows a small update indicator and opens the same update state. Download errors stay in this screen without blocking ordinary work.

Waiting shows the blocking tasks or sessions and **Cancel update**. Cancelling preserves the downloaded candidate but revokes permission to restart. A waiting request also expires when its initiating desktop quits or the machine restarts; reopening may offer the same candidate but cannot restart without a new request. Once installation begins, cancellation is unavailable with a visible explanation.

Preserve the main window's route and visibility across relaunch. Use the shared view model, design-system components, keyboard focus, accessible status announcements, light/dark themes, and reduced-motion behavior. Recovery must have a minimal bundled/native explanation that remains usable if the service cannot serve the web UI.

## Installation transaction

The state progression is: checking → downloading → ready → waiting → reserved → installing → verifying → complete. Failure before replacement returns to a usable ready/error state. Failure after replacement enters rolling-back, then restored or recovery-failed. Each transition carries a transaction ID and revision.

1. **Wait without disrupting work.** Running executors, supervisors, accepted-but-not-yet-started launches, live PTY processes, and work-producing operations block reservation. Completed tasks waiting for review do not. Existing work and its necessary continuations can finish while waiting; do not freeze the system into a dependency deadlock.
2. **Reserve atomically.** Under the same synchronization used to admit work, recheck blockers and install the maintenance gate. Scheduled work remains queued; new interactive starts return a conflict with a retry hint. Every process capable of starting work, including in-process CLI paths, must honor the gate. Read/status/review operations remain available unless they themselves start work. No force-stop action is part of OTA.
3. **Prepare recovery before stopping.** Verify target ownership, writable destination, available disk space, candidate integrity, old bundle backup, service-registration backup, and the external helper. Persist and sync the journal. Arm a user-scoped recovery job for this installation so a helper crash or subsequent login can resume recovery. This is temporary transaction infrastructure, not a general privileged daemon.
4. **Transfer execution.** The helper acknowledges the exact authorized transaction before the service stops. Suppress ordinary desktop lifecycle auto-restarts and bundle-watcher relaunches for this transaction. Stop only the recorded managed service and desktop, verify they exited, then install. A stop timeout aborts replacement and returns to the old release. Attached mode does not stop or reserve an external service.
5. **Relaunch in maintenance mode.** Start the expected service and desktop from the new package at the recorded installation location. The service must inspect pending update recovery before scheduling jobs or admitting sessions, including when launchd starts it independently. Readiness endpoints remain available during maintenance.
6. **Commit after verification.** Within 120 seconds of awake startup time, require authenticated service identity/version, supported protocol, successful new-desktop sign-in, and a valid state read. Bind acknowledgements to this transaction and expected process identities. A health response from an unrelated process is not success. On commit, release the gate, resume queued work, retire the recovery job, and keep one known-good previous package until the next successful update.

Use exclusive file creation, restrictive state permissions, fsync and rename for durable records. Bundle installation and a service restart are not one atomic filesystem operation; the journal records intent before each mutation and completion afterward. Recovery reconciles observed bundle/service identity rather than assuming the last write completed. Locks cover both the installation and its service home; two clients or app copies cannot update the same service independently. Failure before helper handoff releases the reservation only after confirming no installation mutation started; a service restart reconciles abandoned reservations instead of leaving admission closed indefinitely.

In attached mode, steps 5 and 6 reconnect to and verify the existing external service without starting, stopping, or placing it in maintenance mode. All attached-mode recovery restores only the desktop package. If the external service becomes unavailable, the update cannot count as verified, but recovery still must not modify that service.

## Failure, rollback, and data compatibility

If the new release fails verification, keep admission closed, stop only transaction-owned new processes, restore the complete old bundle and service registration, and verify the old service/app before reopening admission. A verified restore shows **The update couldn't start. Your previous version has been restored.** Do not claim restoration if verification fails. Quarantine that target version from automatic installation; retry requires a fresh explicit user action.

A helper crash triggers the armed recovery job. After power loss, recovery resumes on the next user login, before normal work admission. If the old package cannot be restored, keep the record and recovery materials, prevent update loops, and show a repair/reinstall action with diagnostic access. The intended guarantee is a recoverable installation, not a claim that disk failure or removed backups can always be repaired automatically.

Automatic rollback is limited to the uncommitted startup window. Once work is admitted on a committed release, do not roll back later crashes automatically: new work may have changed state. Never restore an old copy of the user's entire data directory as a shortcut.

OTA-eligible releases must preserve backward readability of every state format they change during installation/startup, including configuration, task records, and update journals. The new release must understand the pending journal before migrations or scheduling. Irreversible migrations are not eligible for this OTA path. A future release needing one requires a separate migration design and delivery path. The initial manually installed OTA-capable baseline must already support maintenance/recovery startup so it can serve as the first rollback target.

## Release delivery and trust

Produce architecture-specific complete packages with matching package, Cargo, Tauri, CLI, and UI versions. Extend release preparation to update the desktop versions and relevant lockfile metadata. Bundle the CLI and recovery executable before signing; never mutate signed bundle contents afterward.

Sign nested executables and the app with Developer ID, notarize and staple, then create the final updater archive and its separate Tauri signature. Publish immutable versioned desktop assets through GitHub Releases. Use a dedicated desktop stable feed so a CLI-only release cannot redirect desktop checks to missing artifacts. Promote the feed only after both architectures and their exact signed artifacts pass required validation. Failed/partial publication leaves the prior desktop feed usable; publication retries do not replace already-published versioned assets.

The production updater uses HTTPS, a pinned update public key, expected bundle/signing identity, and matching architecture/version. Verify authenticity before executing downloaded code. Candidate metadata, including compatibility declarations, must agree with information inside the signed artifact; untrusted release metadata cannot relax compatibility checks. A release-base override used by the CLI must not silently change the desktop's production trust source. Restrict test feeds and keys to explicit non-production validation builds.

Private update keys and Apple signing/notarization credentials are protected release inputs, never repository files, client settings, or logs. Establish a backed-up update key before the baseline release. Rotate it through a transition signed by the currently trusted key; a lost key cannot be replaced merely by changing the feed. CI uses SHA-pinned actions and existing repository publication permissions and DCO conventions.

Writable user-owned app installations are the initial supported OTA destination. Preflight rejects read-only media, app translocation, and destinations requiring privilege escalation with relocation/reinstall guidance; no silent elevation or root helper is introduced. Validate an ordinary writable Applications installation and a user Applications installation explicitly.

Developer ID credentials, notarization access, the update signing key, and native validation capacity for both architectures are prerequisites whose availability has not been verified. The first OTA-capable release requires manual installation. Unsigned development artifacts never enter the production feed.

## Validation and acceptance

Implementation is complete only with the project checks plus live evidence, not merely passing updater unit tests.

| Area | Required evidence |
| --- | --- |
| Admission and concurrency | A task/session cannot start between idle detection and reservation; competing clients get conflicts; scheduled work resumes once; cancelled waiting requests never install |
| Active work | Real executor task completes before an update; a real live session blocks it without being killed; tasks awaiting review do not block |
| Trust and downloads | Invalid signature, corrupt/truncated archive, wrong architecture/version/identity, unsupported compatibility, offline operation, and disk/permission errors leave the old installation usable |
| Transaction | Real complete N → N+1 install; intended service/version and desktop reconnect; route/visibility preserved; no duplicate watcher/lifecycle restart |
| Recovery | Failed new service and failed desktop sign-in restore N; helper termination and interruption at each journal boundary recover; post-login recovery runs before work; failed restore reports failure honestly |
| Ownership | Explicit external-service migration and its rollback; decline preserves the external install; another home's/port's registration is never modified; direct bundled CLI self-update is refused |
| State | Settings/history/credentials preserved; startup migration remains readable by N; no restored data snapshot erases newer records |
| UI | Settings/tray and bundled recovery states, keyboard and VoiceOver checks, required light/dark/responsive screenshots under `.work/` |
| Distribution | Both native architectures, final signatures/notarization, package versions, feed promotion, publication failure, and repeat publication behavior |

Run `bun run typecheck`, `bun run test`, `bun run build`, affected generated-asset checks, and desktop `cargo test --offline`. Use `bun run live` for changed API/client behavior and real execution evidence, following [live validation](../testing/live-validation.md).

Add isolated OTA validation as an explicit harness facility: disposable old/new app installations, an isolated home and port, a test-only signing identity/feed, and uniquely named disposable service/recovery registrations. Register every resource for teardown and constrain mutations to the recorded sandbox identities. Existing D3/D8 guards must continue refusing production update/service targets, including new OTA operations. Do not bypass guards or use the user's installed app as a fixture.

Native tests must additionally exercise final production-signed packages in an isolated macOS environment. Developer test signatures do not prove notarization or production-feed delivery. Real installation, rollback, architecture, or surface coverage that cannot be exercised stays **UNVERIFIED**. Record reports under `.work/live/` and summarize their verdicts in the implementation result and PR.

## Delivery boundaries and governance follow-through

One implementation plan can sequence four dependent work areas: complete signed packaging; core update/ownership/admission operations; native transaction and recovery; shared UI and end-to-end validation. The early native feasibility check must precede committing to the recovery adapter's internal mechanics. No production feed is enabled until the complete path is validated.

Implementation must update distribution/desktop documentation and CHANGELOG, generate API docs and assets, and record a durable ADR explaining service ownership, helper delegation, and maintenance during a managed service update. This refines the clients ADR's promise that ordinary UI closure/update never owns or kills work: a managed service update is an explicit idle maintenance operation, while ordinary app closure remains harmless to running work.

OD-5 (desktop bundling/versioning/signing) is resolved by this proposal only after maintainer acceptance and the appropriate decision record. Do not silently amend REL-8 or the constitution in this docs-only change. Follow the constitution's amendment process for any rule changes. For a new ADR, follow the supplied numbered naming convention unless OD-2 is separately settled. Other open governance decisions are outside this feature.

This spec records design requirements, not verification results. No runtime code, credentials, service registration, or release feed has been changed by writing it. The maintainer approved the written spec; implementation follows review of the separate implementation plan and selection of its execution method.

## References

- [Clients over one local service ADR](../decisions/2026-10-16-clients-over-local-service.md)
- [Distribution](../distribution.md), [desktop README](../../desktop/README.md), [governance decisions](../../.project/decisions.md)
- [Tauri updater](https://v2.tauri.app/plugin/updater/): signed update artifacts, separate download/install, and platform archive formats.
- [Tauri macOS signing](https://v2.tauri.app/distribute/sign/macos/): Developer ID signing and notarization configuration.
- [Tauri updater Rust source](https://github.com/tauri-apps/plugins-workspace/blob/v2/plugins/updater/src/updater.rs): native updater integration reference; implementation must validate against its pinned dependency version.
