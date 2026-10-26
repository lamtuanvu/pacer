# Desktop and service version experience

## Intent

Installing a newer desktop app must never silently display an older service's UI as though the new feature shipped incorrectly. The desktop and its service remain one user-facing product. The service still owns tasks and serves the web UI under the existing loopback authentication model.

The failure that motivates this design is a 0.10 desktop attached to a still-running 0.9 standalone service: the window displays the 0.9 Settings page because `/app/` comes from that service. Replacing the app alone did not replace the independently registered CLI service. The desktop must identify this state before showing the service UI.

## Approaches

1. **Bundle a second copy of the full UI and proxy the service.** The latest screen could open immediately, but every HTTP request, event stream and terminal WebSocket would need a new authenticated native transport. New Dispatcher controls would still be unavailable against a 0.9 service. This adds a second security boundary and does not make the feature work sooner.
2. **Keep the service-owned UI and coordinate the versions. Chosen.** The native shell, which is already bundled with the desktop, checks the service version before displaying `/app/`. It shows a clear update state when the service is older. Existing desktop-managed releases use the signed update transaction and wait for work; separately installed services retain their own update path until they can be explicitly adopted. The app never restarts running work silently. The current 0.9 standalone service is a one-time migration case, not an automatic paired update.
3. **Let the old UI load and add a notice inside it.** An older service cannot render notice code shipped only in the new app. This repeats the failure.

The maintainer selected option 2 after the transport and authorization constraints were surfaced. This preserves P1, P6 and the clients-over-local-service ADR.

## Experience

- A normal matched install opens directly to the current UI. Existing browser and CLI clients continue to use the service UI and API.
- When the service is older than the desktop, the native shell states both versions and that this service supplies the screens. It does not call the old page the latest app. **Continue current work** grants access only to that same live service release for this app session. A native-injected notice in the authenticated service page, plus the window title and tray menu/tooltip, keep the older-version status visible. A service restart on a newer release clears the acknowledgment and the app rechecks the authenticated service version.
- Desktop-managed updates use the existing signed transaction: download and verify the complete app and bundled service, show live blockers, wait for active work, reserve an idle handoff, restart, verify authenticated readiness, and restore the previous release on failure. A long-running conversation remains a visible blocker until its owner ends it or explicitly chooses a separate interruption action. No timeout silently interrupts it.
- A separately installed legacy service is not silently replaced. If it lacks the audited admission capability, the desktop links to the one-time standalone update guidance and warns that its old updater can interrupt work. The user finishes current tasks, installs the new service via the existing installation method, and explicitly restarts it. After that service restarts on a compatible baseline, the app reconnects. Explicit service adoption is offered only where production validation has enabled it; it is currently capability gated. Existing service registration, CLI files, tasks and settings are preserved until that choice succeeds.
- The shell must not falsely call a service current merely because a different executable on disk has been updated. The live authenticated `/v3/hello` service version is authoritative for the displayed UI; the app release version comes from the signed bundle.

## Constraints and failure handling

The native shell may render only public versions, status and short guidance. It never reads service tokens, task content or credentials into a bundled page. It does not grant a new IPC capability to an untrusted service page. Unknown, malformed or prerelease versions show a separate unverified-version page with the same bounded current-work escape; they are never labelled current. A newer service keeps the established protocol compatibility path and does not cause an automatic downgrade.

The attached legacy service in the motivating case can still have active tasks and does not have an audited safe automatic self-update path. Do not add an idle-polling restart around that older updater: another client could start work between the poll and restart. A production one-click adoption action remains gated by the existing signed native/admission proof and its live validation. The shell links to `docs/desktop-updates.md`; it does not send users to the older Settings → Updates button as a safe automatic path. That old button invokes `update.apply` and may restart live work. The shell action is limited to an exact native sentinel and is accepted only while this mismatch page is active.

The version check runs after authenticated hello and before client registration or UI activation. Thus no managed update action can be launched *from* the older service's UI at this point. Normal matched desktop-managed installations continue to use their existing update interface and signed native transaction. An accidentally mismatched managed installation receives the same honest compatibility page and requires support or a separate repair path; it is not represented as eligible for automatic adoption.

While the mismatch page waits, the desktop retries authentication no more often than every 30 seconds. The exact **Continue current work** action wakes the lifecycle immediately, so a user does not wait for that poll. The notice is native display only and adds no service operation; it is rendered only after an exact authenticated origin check, with a parsed and bounded version string.

## Validation

Test exact, older, newer, invalid and missing version states; first launch and reconnection; attached and managed installations; active work and a long-running conversation; no automatic restart of a mismatched live service; return to current work; and replacement followed by a current `/v3/hello` and Dispatcher operation. Run CT-11 on an isolated prior-release service with a newer desktop, plus browser/native screenshots and independent UI, security and QA review. Record production signing or legacy adoption gaps as UNVERIFIED rather than claiming a complete OTA rollout.
