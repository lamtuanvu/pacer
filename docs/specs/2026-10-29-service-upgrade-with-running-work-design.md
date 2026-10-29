# Upgrade the service without interrupting running work

Date: 2026-10-29

Status: Proposed. Decision record: [ADR: service upgrade with running work](../decisions/2026-10-29-service-upgrade-with-running-work.md).

This is part B of three. It covers the service and its helper processes when updating with `pacer update`, the `update.apply` operation, or `pacer service restart`/`install`, on macOS and Linux. The other parts:
- **[Part A](2026-10-29-desktop-fixture-bundle-identifier-design.md)** gives fixture desktop builds their own bundle identifier, so live validation never needs the user's app quit.
- **[Part C](2026-10-29-desktop-update-with-running-work-design.md)** moves desktop native updates off wait-for-idle and builds on this part.

## Problem

pacer's upgrade paths disagree about running work:

- **Desktop updates** wait until nothing is running (ADR 0001). On a busy machine they can wait for hours.
- **`pacer update`, `update.apply` and `service restart`/`install`** never check. They replace the binary and restart the service (`src/update/update.ts`, `src/service/index.ts:264`, `src/api/ops.ts`). Nothing records what happens to running work, and nothing tests it.
- **On Linux**, the systemd unit sets no `KillMode` (`src/service/index.ts:79-94`). The default, `control-group`, kills every process in the service's cgroup on restart. That includes detached task runners and session hosts, so a Linux upgrade loses running work.

Most work already runs outside the service:

| Process | Runs | Version after an upgrade today |
| --- | --- | --- |
| Agent (Claude Code, Codex, Cursor, …) | external CLI, started by `run.sh` (headless) or by a session host (interactive) | not pacer code |
| `pacer _run <task>` runner | detached, one per task (`src/tasks/api.ts:93-101`) | old, until its attempt ends |
| `pacer _session <dir>` host | detached, one per interactive run or terminal; owns the PTY and the agent (`src/supervisor/run.ts:51-57`, `src/session/host.ts`) | old, until the session ends |

When a runner dies while its run is still alive, the service sweep starts a new runner, and `resumeAttempt` reattaches to the same live agent through `finishRun` (`src/tasks/api.ts:225-233`, `src/exec/direct.ts:543`). Agents report by writing files (`src/session/reports.ts`), not over HTTP.

So agents already survive a service restart on macOS. The gaps are these:
- Nothing defines whether old helper processes and a new service can work together.
- Old runners keep supervising work with old code.
- Linux kills everything.
- No upgrade path tells you what it did to running work.

## Outcome

An upgrade never stops a running agent or a terminal command:

- The service restarts onto the new version.
- **Runners hand over** to new-version runners, which reattach to the same live agents.
- **Session hosts keep running** and stay connected through a versioned handshake.

Every upgrade path reports what kept running. The guarantee starts with the first upgrade *from* a version containing this feature. Upgrading *into* it still uses the old code paths, and the release notes say so.

## Compatibility contract

Runners and session hosts from version N must keep working with a service from version N+1. A service from N+1 must also leave N's processes working after a rollback to N.

1. **Additive formats.** Run directory files (`pid`, `exit`, `child`, `interactive.json`, `report.json`, `admission.json`, session logs), task records and the session socket change only additively in a minor release. No new task state is added. Readers ignore unknown fields, and stay strict about the fields they rely on.
2. **Session socket.** The socket's existing `hello` frame (`src/session/framing.ts`, socket v1) gains `versions: [min, max]` and `pacer: "<version>"`. A peer that doesn't send `versions` is v1. Each side uses the highest version both support. If they share none, the service shows the session as **Reopen to update** and never kills it. Unknown frame types are already ignored (`src/session/viewers.ts`).
3. **Fixture tests.** CI keeps a recorded set of run directories, task records and socket transcripts from the previous minor release. The new version must read and serve them.

## Runner handover

A runner hands over when the new service starts. Before that moment it keeps supervising its run, and the agent never pauses.

1. **Advertising support.** A runner that supports handover writes `runner.json` in its run directory: `{ "pid", "startedAt", "pacer": "<version>", "handover": 1 }`, owner-only, written with write-then-rename.
2. **Finding old runners.** After a new service passes its health check, it lists running tasks whose runner reports `handover: 1` from an older version. For each one, it checks that the live process matches the recorded PID, start time and pacer executable before signalling, so a reused PID is never signalled.
3. **Signalling.** The service sends `SIGUSR2`. The runner then:
   1. stops polling;
   2. finishes any store write it has started, under the task lock;
   3. writes `handover.json` with the attempt and a lease reference its replacement can take, owner-only;
   4. exits with status 0 **without** recording an attempt outcome.
4. **Replacing.** The existing sweep sees a dead runner with a live run and starts a new-version runner. That runner claims the handed-over lease and reattaches through `resumeAttempt`. If the runner hasn't exited after 30 seconds, the service leaves it running. A runner that stays is harmless: the old version simply keeps supervising.
5. **Runners without handover support.** Runners from versions without this feature (the first upgrade) are never signalled. A runner without a `SIGUSR2` handler would be killed by it and leave a work lease that can't be reclaimed. Those runners finish their attempt on the old code.

Remote-host runs follow the same rules on the local side. The remote process is never touched.

## Session hosts

Session hosts are never stopped by an upgrade, whether they run a terminal or an interactive agent. They connect to the new service through the handshake. A host ends when its session ends, as it does today. Hosts carry no task-supervision logic: the runner supervises interactive runs too, so an old host keeps only the PTY and the socket.

## Service supervisor settings

- **Linux.** The generated unit gains `KillMode=process`. `pacer update`, `update.apply` and `service restart` compare the installed unit with the generated one. If they differ, the path rewrites the unit and runs `systemctl --user daemon-reload` before restarting. That way existing installs pick up the change on their next upgrade.
- **macOS.** `kickstart -k` and bootout send signals to the job's process group. Runners and session hosts are started in their own sessions, so they survive. Live validation confirms this. If it doesn't hold, the plist gains `AbandonProcessGroup`.

## Upgrade paths

`pacer update`, `update.apply`, `service restart` and `service install` on a running service each work in three steps:

1. **Before restarting,** they read active work: running tasks, open session hosts and remote runs.
2. **After the restart** and a passed health check, the new service performs runner handover.
3. **They report** "Updated to v<version>. N tasks and M terminal sessions kept running." In the CLI this is the command output. For `update.apply` it is the operation result, and the web app shows it.

**Callers.** Executor sessions may not upgrade the service. A request to `update.apply`, `service.restart` or `service.install` made with an executor run's credentials, or from a process carrying `PACER_ROLE=executor`, is refused with "upgrades are not allowed from a delegated task". The CLI checks this before it makes any change.

## Visibility

- **Task details** show "Reattached on v<version>" after a handover.
- **`pacer status` and Settings → Updates** list sessions still running an older host version.
- **Sessions with no shared protocol** show **Reopen to update**.
- **Public status** carries versions and counts, never paths.

## Out of scope

- Desktop native updates, which are part C.
- Stopping and resuming agents. Nothing in this part needs it. A later design may add it for incompatible session hosts if that case occurs.
- Upgrading remote host software.

## Validation

**Unit tests:**
- Runner handover: the right signal, `handover.json` written, no attempt recorded, the new runner claims and reattaches.
- Runners without handover support are never signalled.
- A reused PID is not signalled.
- The handshake chooses the highest shared version, treats a peer without `versions` as v1, and shows **Reopen to update** when no version is shared.
- The generated systemd unit contains `KillMode=process`, and a differing unit is rewritten and reloaded.
- Executor callers are refused.
- The previous release's fixtures are read and served.

**CI:** a Linux job, where systemd user sessions are available, checks that a detached run and a session host survive `systemctl --user restart`. If GitHub runners can't run a user systemd instance, this check is recorded as UNVERIFIED, and live validation covers it on a Linux machine.

**Live validation (CT-11), with real agents (Claude Code and Codex):**
1. **`upgrade-headless`:** a headless task is mid-turn. `pacer update` installs a newer fixture build. The agent is not interrupted, the runner hands over, and the task completes with its report recorded once.
2. **`upgrade-interactive`:** the same for an interactive task, whose agent runs inside an old session host.
3. **`upgrade-terminal`:** a terminal running a long command survives the upgrade, and its window reconnects with output intact.
4. **`upgrade-first-hop`:** upgrading from a pre-feature version leaves running work on the old code, and nothing is signalled.
5. **`upgrade-rollback`:** after upgrading and then reinstalling the previous version, its runners and session hosts still work.

Each scenario records the agent's process identity before and after the upgrade, to show it never restarted. A Linux run of scenarios 1 and 3 is required before the Linux claim is made. Without it, Linux stays UNVERIFIED.
