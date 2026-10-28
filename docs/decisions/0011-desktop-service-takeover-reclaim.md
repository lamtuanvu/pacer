# Reclaiming a taken-over desktop service on confirmation

Date: 2026-10-28

Status: Proposed. Accepted when the maintainer merges it.

Context: [takeover reclaim design](../specs/2026-10-28-desktop-service-takeover-reclaim-design.md), [ADR 0001](0001-desktop-ota.md), [legacy bootstrap design](../specs/2026-10-22-desktop-legacy-service-bootstrap-design.md).

ADR 0001 says an attached or unverifiable job is never removed, and the legacy bootstrap design never stops an unsupported source by force. Both assume the service belongs to someone other than the app. A user who consented to the app's service can lose it when another build replaces the app's `~/.local/bin/pacer` link. The app cannot verify that build or prove it is idle, so under those rules desktop OTA stays unavailable with no way back.

## Decision

When the app's consent record shows the user chose the app's service, and the registered service now runs an unverifiable executable, the desktop may stop that one exact job and move its registration to the bundled signed CLI. It does this only after explicit user confirmation that names both executables and states that running work may be interrupted.

The change is a `takeover` variant of the native adoption journal. It uses the existing independent recovery job and readiness proof. Before commit, failure restores the exact original registration. The source build is never executed by the desktop, deleted, overwritten or granted native-session or OTA authority. The repaired registration names the bundle path, not the terminal link.

## Consequences

User confirmation replaces the admission proof for this one case, so a running task in the old build can be interrupted. The confirmation lists the work the old service reports and labels it as best effort.

Services the app never owned are unaffected: ADR 0001 and the legacy bootstrap design still apply to them. Copying builds into `~/.local/bin` no longer moves the service once the registration names the bundle path.

## Alternatives considered

- Reclaim only when the old service is already stopped: safe, but leaves a running takeover permanently unrepaired unless the user knows to stop it.
- Wait for the legacy bootstrap allowlist: local and modified builds never match an official digest.
- Reuse the first-run `pacer service install`: no reservation or independent recovery on a live service.
