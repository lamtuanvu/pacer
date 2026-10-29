# Upgrade the service by parking and resuming running work

Date: 2026-10-29

Status: Proposed. Accepted when the maintainer merges it.

Context: [service upgrade with running work design](../specs/2026-10-29-service-upgrade-with-running-work-design.md), [ADR 0001](0001-desktop-ota.md), [ADR 0008](0008-built-in-terminal.md).

ADR 0001 makes desktop updates wait until no work is running. Busy users therefore get updates late or never. Meanwhile `pacer update` and `service restart` don't check for running work at all. Tasks and terminal sessions already run in detached processes that keep their state on disk, and each supported agent can resume a conversation by session ID.

## Decision

All upgrade paths share one coordinator in the service. It first holds new work, queueing it rather than refusing it. It then parks each running agent task at a safe point: the agent has finished its turn, is waiting for input, or has gone quiet. Any task still running after a configurable deadline is parked by force. The coordinator then installs and resumes each parked task in the same agent conversation, telling the agent the service was upgraded.

Progress is kept in an upgrade journal on disk. Whichever service starts next finishes the resume, so a crash at any step loses no parked task. Terminal session hosts are not stopped. They keep running through the upgrade, and the new service reconnects to them through a versioned socket handshake. On macOS, desktop updates accept them as recorded, signature-verified survivors. On Linux, the systemd unit uses `KillMode=process`.

## Consequences

Upgrades no longer wait for work to finish. A task that is forced at the deadline may lose its last unfinished action. Its agent is told so when it resumes. Tasks whose agent cannot resume a session are not stopped early. If they are still running at the deadline, they fail with a stated reason and offer Retry.

For a while after an upgrade, terminal hosts from the old version run alongside the new service. This needs a compatibility rule for the session protocol and a second allowed process class in the native process inventory. The admission layer's "refuse while reserved" behaviour becomes "queue while held".

This replaces ADR 0001's wait-for-idle rule for desktop updates. Desktop updates still never kill running work without first recording it for resume.

## Alternatives considered

- **Keep running work on the old version and let it drain.** Mixed versions would last as long as the longest task, and the old binary would have to stay installed until then.
- **Smarter waiting, with scheduling and an ETA.** Simpler, but busy machines still never upgrade.
- **Have each runner park and resume itself.** The runner is old-version code, so it would resume with the old launch logic.
- **Have each installer orchestrate its own parking.** Three copies of the same logic, and the desktop helper cannot see task state.
