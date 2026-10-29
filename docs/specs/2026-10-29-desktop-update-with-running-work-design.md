# Desktop updates with running work

Date: 2026-10-29

Status: Proposed outline. This is part C of the [service upgrade with running work design](2026-10-29-service-upgrade-with-running-work-design.md). It needs its own ADR as a scoped exception to [ADR 0001](../decisions/0001-desktop-ota.md), written before implementation.

## Problem

Desktop native updates wait until no work is running. The work-lease reservation (`src/update/desktop/admission.ts`) and the native helper's admission check (`desktop/src-tauri/src/ota/recovery_authority.rs`) treat "reservation" and "leases" as mutually exclusive. `assertNativeProcessCoverage` also refuses any pacer process that is not enrolled work. Part B keeps agents and session hosts running across a restart. The desktop path cannot do the same until both of those rules change.

## Direction

1. **Reservation for the swap only.** The reservation covers the swap, not the wait for idle. Admission gains a lease class `survivor` for session hosts and runners that support handover and outlive the update. Any other lease still blocks.
2. **Native trust root.** The native side decides survivors, not the service. The helper verifies each survivor itself, using the running process's code signature against the release signing requirement. That is the same check it applies to the bundled CLI, not a list of digests the service wrote. A survivor from a release older than the installed one is accepted as long as it is release-signed.
3. **Old helpers.** Recovery uses the helper pinned into the original transaction, and that helper refuses unknown admission state. The admission state therefore carries a version, and survivor leases are written only when the installed helper supports them. Otherwise the update falls back to waiting, as today.
4. **Rollback window.** Runner handover from part B starts only after the native transaction commits. Survivors are never signalled during the 120-second rollback window.
5. **Adoption and takeover.** Desktop service adoption and takeover reclaim keep their current rules until this part's ADR addresses them.

## Open questions for the ADR

- Whether survivors from a release that has since been revoked are refused.
- How long a survivor may outlive several later updates.
- How attached installations, which skip the gate today, report their survivors.

## Validation

Live validation in the fixture from part A:
- an update while a headless task, an interactive task and a terminal are running, with all three surviving;
- a forced rollback during the window, with nothing signalled;
- an older helper, which falls back to waiting.
