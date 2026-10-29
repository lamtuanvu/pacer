# Upgrade the service around running work

Date: 2026-10-29

Status: Proposed. Accepted when the maintainer merges it.

Context: [service upgrade with running work design](../specs/2026-10-29-service-upgrade-with-running-work-design.md), [ADR 0001](0001-desktop-ota.md), [ADR 0008](0008-built-in-terminal.md).

Agents run as external processes. pacer's own helpers already run outside the service: one detached runner per task, and one session host per interactive run or terminal. The service sweep already reattaches a new runner to a live agent. Still, `pacer update` and `service restart` don't define what happens to running work. On Linux, systemd kills it. Desktop updates wait for idle.

## Decision

The CLI and service upgrade paths never stop running agents or terminal sessions:

- The service restarts onto the new version.
- **Runners that support it hand over.** At a lock-held commit point, the runner releases its own leases without revoking the attempt's work grant or enforcement token, then exits without recording an outcome. The sweep starts a new-version runner, which reattaches to the same agent without re-certifying the attempt or requeueing it.
- **Session hosts keep running.** Clients and hosts negotiate through optional fields on the existing `hello` frame and the host's first state frame. Hosts from the last three minors are supported.
- **Older runners** that predate handover finish on the old code.
- **Run files, task records and the session socket** change only additively within a three-minor support window. This keeps older processes working with a newer service, and after a rollback.
- **The Linux unit** uses `KillMode=process`, and upgrade paths rewrite and reload an outdated unit.
- **Delegated tasks** may not upgrade the service. This guards against accidental self-upgrade. It is not an authorization boundary.

Desktop native updates are not changed by this decision. They keep ADR 0001's wait-for-idle rule until a separate ADR (part C) records a scoped exception with a native trust root for surviving processes.

## Consequences

Upgrades no longer interrupt agents or terminal commands. For a while, older session hosts and pre-handover runners run alongside a newer service, bounded by the life of their session or attempt. The compatibility contract and fixture tests for every release in the support window become release requirements.

The guarantee starts one upgrade after this ships. Stopping and resuming agents is not needed and not built.

## Alternatives considered

- **Stop agents at safe points and resume them on the new version.** Rejected after review:
  - headless runs cannot be resumed with a message;
  - a new task state breaks rollback;
  - the desktop reservation cannot coexist with the parked work;
  - every forced stop risks a half-finished action.
- **Smarter waiting with scheduling.** Busy machines would still never upgrade.
- **Kill old runners without a handover.** Pre-handover runners leave work leases that can't be reclaimed, and those leases block later desktop updates.
