# Update the desktop app around running work

Date: 2026-11-25

Status: Proposed. Accepted when the maintainer merges it.

Context: [desktop updates with running work (part C outline)](../specs/2026-10-29-desktop-update-with-running-work-design.md), [service upgrade with running work](2026-10-29-service-upgrade-with-running-work.md) (part B), [ADR 0001](0001-desktop-ota.md), [interim self-signed OTA releases](../specs/2026-10-20-interim-self-signed-ota-design.md).

## Problem

Part B lets `pacer update` and the service's **Install** button restart the service while agents keep running: each runner that speaks the handover protocol passes its agent to a runner on the new version. Desktop updates do not. They still follow ADR 0001's wait-for-idle rule:

- `reserveIdle` (`src/update/desktop/admission.ts`) refuses the reservation while any work lease or stored running task exists.
- `assertNativeProcessCoverage` (`src/update/desktop/native-provider.ts`) refuses the install while a pacer process is not enrolled work.
- `triggerHandover` (`src/tasks/handover-service.ts`) runs only on the CLI upgrade path and `update.apply` recovery, never after a desktop install.

On a busy machine the desktop update therefore waits indefinitely. Any record that wrongly stays `running` blocks it forever (fixed for one cause in #1261). Users then install the new app by hand, and work started on the old version keeps running on old code with no handover.

The part C outline left one blocker open: releases are not signed with a Developer ID, so a surviving process seemed to have no trust anchor. That is no longer true. Release builds compile a signer pin (`PACER_SIGNING_CERT_SHA1` for the project's self-signed certificate, or `PACER_APPLE_TEAM_ID`, `release.yml`). The native helper already checks a running process against that requirement by audit token (`OtaTrust::verify_process`, `desktop/src-tauri/src/ota/trust.rs`). The interim signing spike confirmed that `certificate leaf = H"<sha1>"` holds for a running PID and rejects an ad-hoc impostor with the same identifier.

## Decision

Desktop updates keep running work, using part B's handover. The reservation covers the swap, not the wait for idle.

0. **Manual installs hand over too.** When the desktop starts a service whose version is newer than the one it last ran (the user installed a new app by hand, or through Homebrew), it calls the existing owner-only `service.handover` op once, exactly as the CLI upgrade path does. Older runners that speak the handover protocol move to the new version; others finish on old code, as today. This needs no admission or helper change and ships first.
1. **Survivor leases.** A work lease gains `class: "survivor"` when its process supports handover: a runner with the current `HANDOVER_PROTOCOL`, or a session host from the supported window. The class is written on any local claimed lease of such a process (older services and helpers strip or ignore it); it takes effect only in a reservation where every party declares support (point 3). A session host counts only when the update target is within its support window (checked with `hostSupported` against the target version but this running service's session protocol range, since the target's range is not known before install; the approximation holds inside the three-minor window), and a run whose host has not claimed its lease yet is a start. Survivor leases do not block `reserveIdle`. Every other lease, every queued start and every stored running task without a survivor lease still blocks, exactly as today. A survivor lease never lets new work start during the reservation.
2. **Native trust decides survivors.** The service only proposes candidates. Before install, the helper verifies each candidate by audit token against the compiled signer requirement for the CLI role (`verify_process` with `CodeRole::Cli`; runners and session hosts run the bundled `pacer`/`pacer-core`), the same check the helper applies to the service. The check uses the running process's dynamic code identity, so it still holds after the update replaces the files on disk. A candidate that fails, or whose PID now belongs to a different process, counts as a blocker; a candidate whose process has exited runs no code and is accepted. Every pacer-named process in a survivor's process tree must verify the same way, so a foreign or development pacer started by an agent still blocks, in the helper and in the service's coverage check. `assertNativeProcessCoverage` accepts only verified survivors, in addition to what it accepts today. No digest list written by the service grants authority.
3. **Fallback to waiting.** Survivor leases are written only when the installed helper, the running service and the update target all declare support. The rollback target is the installed version, so it must declare support too. Otherwise the update waits, as today. Support is declared by version: the installed bundle (its helper, its service and the rollback target) and the update target must both be at least 0.18.7, the first release with this helper code. A field in the helper manifest or the update record was rejected because older helpers parse the update record strictly (`wire::parse_record`), so a new field would break them; the installed app's version identifies its helper and rollback target exactly. OTA fixture builds (`dev.pacer.desktop.fixture`, compiled fixture policy) are exempt from the version floor; a release build cannot set that policy and there is no runtime override. The admission state records `survivors: true` on a reservation that admitted survivors; an older helper refuses any lease alongside a reservation, so it never accepts one.
4. **Handover on commit only.** Survivors are not signalled during the swap or the 120-second rollback window. After the native transaction commits, the desktop starts the new service, and the new service calls `triggerHandover` once on the native commit signal (the verified `committed` outcome, after it releases the reservation), not on every startup. While an install is in flight, `service.handover` signals nothing and answers `deferred: true`; the desktop's step-0 call then keeps its remembered version and calls again on its next connect. The same deferral applies while any admission reservation or reconciliation fence is held, so a stale reservation that was never released also defers `pacer update`'s handover until reconciliation or repair releases it; this is intended, because replacement runners could not start while it is held. If the update rolls back, nothing is signalled and survivors keep running against the restored service.
5. **Unchanged rules.** Desktop service adoption, takeover reclaim and attached installations keep their current rules until a later decision. A revoked release's runners are not refused here: the revocation list has no running-process form yet.

## Consequences

- Installing a new desktop version no longer waits for agents or terminals to finish, and work moves to the new runner the way `pacer update` already does. "Still on an older version" becomes rare and temporary.
- The admission state and helper manifest grow one additive capability. Compatibility tests across the three-minor window become release requirements for both.
- Wait-for-idle stays as the fallback, so mixed or old installations behave exactly as today.
- The trust boundary moves from "no pacer process may run" to "only processes signed by the release signer may run". An unsigned or foreign pacer process still blocks the install.

## Alternatives considered

- **Pause agents, update, resume them.** Rejected again for part B's reasons: headless runs cannot be resumed with a message, a new task state breaks rollback, and a forced stop can leave half-finished actions.
- **Wait for Developer ID signing.** The self-signed pin already gives a dynamic identity check, so waiting would only delay the fix.
- **Trust survivors from a service-written list of cdhashes.** Rejected: the service is not the native trust root, and a build cannot pin its own hash.

## Implementation order

0. Desktop: call `service.handover` once after starting a newer service; live-validate a manual app replacement with a headless task running.
1. Admission state: capability flag and `survivor` lease class, with schema compatibility tests for every service in the window.
2. Helper: verify survivors by audit token, extend process coverage, record support in the manifest.
3. Service: call `triggerHandover` on the native commit signal; keep plain start-up unchanged.
4. Live validation in the desktop fixture: an update while a headless task, an interactive task and a terminal run, with all three surviving and handing over; a forced rollback with nothing signalled; an older helper falling back to waiting; a foreign pacer process still blocking.
