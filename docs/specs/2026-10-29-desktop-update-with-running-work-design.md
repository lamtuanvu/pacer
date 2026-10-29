# Desktop updates with running work

Date: 2026-10-29

Status: Proposed outline. This is part C of the [service upgrade with running work design](2026-10-29-service-upgrade-with-running-work-design.md). It needs its own ADR as a scoped exception to [ADR 0001](../decisions/0001-desktop-ota.md), written before implementation.

## Problem

Desktop native updates wait until no work is running. The work-lease reservation (`src/update/desktop/admission.ts`) and the native helper's admission check (`desktop/src-tauri/src/ota/recovery_authority.rs`) treat "reservation" and "leases" as mutually exclusive. `assertNativeProcessCoverage` also refuses any pacer process that is not enrolled work. Part B keeps agents and session hosts running across a restart. The desktop path cannot do the same until both of those rules change.

## Direction

1. **Reservation for the swap only.** The reservation covers the swap, not the wait for idle. Admission gains a lease class `survivor` for session hosts and runners that support handover and outlive the update. Any other lease still blocks.
2. **Native trust root.** The native side decides survivors, not the service. The helper verifies each survivor itself from the kernel's dynamic code identity of the running process (audit token and cdhash), checked against the release signing requirement. It never uses a static check of the file on disk, which the update replaces, and never a list of digests the service wrote.
3. **Old helpers and services.** Recovery uses the helper pinned into the original transaction, and older helpers and services both refuse unknown admission state. Survivor leases are therefore written only when every helper and service version that could read the state, including a rollback target, supports them. Otherwise the update falls back to waiting, as today. The ADR defines how that support is recorded and checked.
4. **Rollback window.** Part B's handover is triggered only on the native commit. Survivors are never signalled during the 120-second rollback window.
5. **Adoption and takeover.** Desktop service adoption and takeover reclaim keep their current rules until this part's ADR addresses them.

## Open questions for the ADR

- **Rollback of the TypeScript service.** An older service parses admission state strictly (`schema: 1`, a closed blocker enum) and refuses all new work on anything else. Survivor leases must therefore stay readable by every service version in the support window, or the version change must be gated.
- **Identity of a replaced survivor.** An update replaces a survivor's executable on disk, so a static signature check of the file fails. Verification needs the kernel's dynamic code identity of the running process: its audit token and cdhash.
- **Unsigned releases.** Desktop artifacts ship unsigned until Developer ID signing (REL-8), so a "release-signed survivor" has no anchor yet. Until then, the update falls back to waiting.
- **Trigger.** Part B's handover starts only after the native transaction commits, and the service starts it on the native commit signal, not on its own startup.
- Whether survivors from a release that has since been revoked are refused.
- How long a survivor may outlive several later updates.
- How attached installations, which skip the gate today, report their survivors.

## Validation

Live validation in the fixture from part A:
- an update while a headless task, an interactive task and a terminal are running, with all three surviving;
- a forced rollback during the window, with nothing signalled;
- an older helper, which falls back to waiting.
