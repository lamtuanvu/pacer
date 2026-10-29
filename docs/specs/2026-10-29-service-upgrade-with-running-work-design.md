# Upgrade the service without interrupting running work

Date: 2026-10-29

Status: Proposed. Decision record: [ADR: service upgrade with running work](../decisions/2026-10-29-service-upgrade-with-running-work.md).

This is part B of three. It covers upgrading the service and its helper processes with `pacer update`, the `update.apply` operation, or `pacer service install`/`restart`, on macOS and Linux. The other parts:
- **[Part A](2026-10-29-desktop-fixture-bundle-identifier-design.md)** gives fixture desktop builds their own bundle identifier, so live validation never needs the user's app quit.
- **[Part C](2026-10-29-desktop-update-with-running-work-design.md)** moves desktop native updates off wait-for-idle. It builds on this part.

## Problem

pacer's upgrade paths disagree about running work:

- **Desktop updates** wait until nothing is running (ADR 0001). On a busy machine they can wait for hours.
- **`pacer update`, `update.apply` and `service install`/`restart`** never check. They replace the binary and restart the service (`src/update/update.ts`, `src/service/index.ts:264`, `src/api/ops.ts`). Nothing records or tests what happens to running work.
- **On Linux**, the systemd unit sets no `KillMode` (`src/service/index.ts:79-94`). The default, `control-group`, kills every process in the service's cgroup on restart, including detached task runners and session hosts. A Linux upgrade loses running work.

Most work already runs outside the service:

| Process | Started by | Version after an upgrade today |
| --- | --- | --- |
| Agent (Claude Code, Codex, Cursor, …) | `run.sh` (headless runs) or the session host (interactive runs) | not pacer code |
| `pacer _run <task>` runner | the service, detached, one per task (`src/tasks/api.ts:93-101`) | old, until it exits |
| `pacer _session <dir>` host | `startRun`, detached, one per interactive run or terminal (`src/supervisor/run.ts:51-57`, `src/session/host.ts`) | old, until the session ends |

The runner supervises both kinds of run through run-directory files. When a runner dies while its run is still alive, the service sweep starts a new runner. `resumeAttempt` then reattaches to the same live agent through `finishRun` (`src/tasks/api.ts:225-233`, `src/exec/direct.ts:543`). Agents report by writing files (`src/session/reports.ts`).

So on macOS, agents already survive a service restart. The gaps are these:
- Nothing defines whether old helper processes and a new service can work together.
- Old runners keep supervising with old code.
- Replacing a runner today has side effects. It takes new leases and revokes work grants and enforcement tokens, and for strict tasks it requeues the run.
- Linux kills everything.
- No upgrade path reports what happened to running work.

## Outcome

An upgrade never stops a running agent or a terminal command:

- The service restarts onto the new version.
- **Runners that can hand over do so.** A new-version runner reattaches to the same live agent without new leases, grants or tokens.
- **Session hosts keep running.**
- **Every upgrade path reports** what kept running.

The guarantee starts with the first upgrade *from* a version that contains this feature. Upgrading *into* it uses the old code paths, and the release notes say so.

## Support window

- **Runners:** a runner hands over only to a service and runner whose handover protocol version it shares. Runners outside that window are never signalled and finish on their own code.
- **Session hosts:** hosts from the **last three minor releases** must be served. CI keeps recorded fixtures for each of those releases.
- **Retiring a field:** a run-file or socket field may be removed only after it has been unused for three minors, per API-2.

Outside the window, a session shows **Reopen to update**. Nothing is stopped.

## Compatibility contract

1. **Additive formats.** Run directory files (`pid`, `exit`, `child`, `interactive.json`, `report.json`, `admission.json`, session logs), task records and the session socket change only additively inside the support window. No new task state is added. Readers ignore unknown fields and stay strict on the ones they rely on.
2. **Session protocol.**
   - The negotiating parties are the **client** (web app, CLI or remote viewer) and the **host**. The service only relays (`src/serve/session-ws.ts`).
   - The client's `hello` keeps `v: 1`, because hosts reject any other value (`src/session/viewers.ts:72`). It gains optional `versions: [min, max]` and `pacer`.
   - A host replies with its own range **only when** the client sent `versions`. The reply is a field on its first `control` frame, not a new frame type, because older web apps throw on unknown frames (`app/src/term/client.ts:58`). No reply means v1.
   - A host never sends a new frame type to a client that didn't advertise support for it.
   - Each host writes `session.version` in its run directory, `{pacer, versions}`, owner-only, with write-then-rename. The existing `session.host` file keeps its current values (`builtin`, `none` or the remote session mode), which older runners compare exactly. The service reads `session.version` to show versions and **Reopen to update** without connecting. A host without that file is v1. `session.version` joins the run-directory reset list (`src/supervisor/run.ts`), the retention list and remote cleanup.
3. **Fixture tests.** For every release in the support window, CI reads recorded run directories, task records and socket transcripts. It also attaches the old web app, the old CLI and the old remote viewer to a new host.

## Runner handover

### Which runs hand over

| Run | Handover |
| --- | --- |
| Direct backend, headless, with a recorded `t.run` | Hands over |
| Direct backend, interactive (agent in a session host), with a recorded `t.run` | Hands over. The host is untouched. |
| Conversation-mode run | Hands over. The replacement resumes the conversation branch of `progressPoller`. |
| Run driving a takeover (`run.takeover`) | Finishes on its old runner |
| Remote-host run | Hands over on the local side only. The remote process is untouched. Remote viewers attached through the old runner reconnect to the replacement, as they do after a runner crash today. |
| Orca backend | Finishes on its old runner. It has no recorded `t.run`, so the sweep would mark it failed. |
| Pre-run phase (no run directory yet) or between attempts | Not eligible yet. Eligible once its run is recorded. |

### Protocol

- **Advertising.** A runner is *eligible* only while it is inside `supervise` for a live attempt with a persisted `t.run`. It publishes this in the task record as `t.handover = {protocol: 1, pacer, identity}`, where `identity` is the runner's own process identity from the existing `processIdentity()` helper, and clears it whenever it leaves that state. The identity comes from the runner itself and is stored in the task store, never in a run-directory file an executor could write.
- **Trigger.** Handover runs only when the upgrade path that restarted the service asks for it. For CLI and service paths, that is the path itself, after the new service's health check. Part C triggers it on the native commit. A service that merely starts, after a crash or reboot, never triggers handover.
- **Signalling.**
  1. When triggered, it lists running tasks with `t.handover.protocol` it supports and an older `pacer` version.
  2. It signals only when the identity's PID equals `t.runnerPid` and `sameProcess()` confirms the live process is the one recorded, checked right before signalling. It never compares executable paths: an update replaces the binary by rename, so an old runner's path no longer matches. On Linux it uses a pidfd where available. A marker left behind by another process, for example after a rollback to a pre-feature version, never matches, so a runner without a handler is never signalled.
  3. It sends `SIGUSR2`.
- **Commit point.** In its `SIGUSR2` handler, the runner checks it is still eligible. If not, it ignores the signal and the service reports "kept on old runner". If it is eligible, it takes the task lock at the next poll boundary and, inside the lock:
  1. re-checks eligibility: the task is still `running`, `t.run` is unchanged, and no stop was requested. If any of these fails, it abandons the handover and keeps supervising;
  2. calls `finishWorkSync` for its `task` and per-attempt `operation` leases. The run stays covered by its `session` lease and run directory evidence (`src/supervisor/run.ts:36,60`), so no admission gap opens;
  3. sets `t.handover.state = "handed-over"`;
  4. leaves `t.run` intact.

  It **does not** call `releaseDispatch`, `revokeWorkGrants`, `revokeEnforcementTokens` or `drainQueue`. It then releases the lock and calls `process.exit(0)` without recording an attempt outcome. The skipped cleanup becomes the replacement runner's job when the attempt ends, or the sweep's if the task is stopped during the gap. Any failure before the lock is taken leaves the runner supervising as before.
- **Replacing.** The sweep sees a dead runner with `t.handover.state = "handed-over"` and a live run. It starts a new-version runner straight away, using a fresh `task` lease as today. It skips the 60-second throttle once per handover. If that replacement fails to start, the normal throttle applies, so a broken new binary cannot leak a lease every sweep. The handover state lets the new runner's resume path skip three steps:
  - **re-certification and enforcement token issue:** the attempt was certified at launch, and its token stays valid (the fingerprint includes the pacer version, `src/exec/enforcement.ts:101`, so re-checking would requeue the live run). The guard-failure marker check that runs alongside token issue still runs;
  - **work-grant issue:** the attempt's existing grant stays valid;
  - **the requeue branch:** `t.run` is never deleted while its run is alive.

  Once it is supervising, the new runner clears `t.handover`.
- **Supervision state.**
  - `waitKey`, which is a random in-memory value today, becomes a stored field on the attempt (`run.waitKey`). `progressPoller` reads and writes it, so a replacement doesn't repeat "needs input" and "idle" alerts. A replacement starts with `waiting` restored from `run.waitKey`, and the idle-alert flag is stored as `run.idleAlertedAt` for the same reason.
  - `taskStop` during the handover gap stops the live run and records the task as `stopped` with the run's evidence. Three paths that today record "stopped before an executor ran" change to honour `t.handover.state = "handed-over"`: `taskStop` with a dead runner, the sweep, which also scans stopped tasks with a handed-over run, and the replacement runner's resume check. The replacement runner sees the stop and records the attempt outcome; if none starts within 60 seconds, the sweep records it. It never records "stopped before an executor ran".
  - Worst-case gap without a supervising runner: one sweep interval (5 s) plus runner start-up.
- **Rollback.** A runner from an older version that sees `t.handover` ignores it. The field is additive. An older sweep treats a handed-over task as a dead runner with a live run and resumes it with the old side effects, which is today's crash-recovery behaviour. This is no worse than today. One known edge: if a rollback lands inside the handover gap, an older runner re-certifies a strict task and may requeue it while its agent is alive. That is today's cross-version crash-recovery behaviour, and the window is a few seconds.

## Service supervisor settings

- **Linux.** The generated unit gains `KillMode=process`. `pacer update`, `update.apply` and `service install`/`restart` compare the installed unit with the generated one. If they differ, the path rewrites the unit and runs `systemctl --user daemon-reload` before restarting. `pacer service uninstall`, on both platforms, lists running tasks and sessions and asks before removing the service. With `--stop-work` it stops each runner, session host and headless agent process group it can identify from the task store and run directories, each checked with `sameProcess()` before it is signalled, because `KillMode=process` no longer cleans them up on Linux.
- **Linux trade-offs.**
  - With `KillMode=process`, `systemctl --user stop` no longer stops runners and session hosts. That is the point, but a stopped service can leave work running. `pacer status` lists that work, and `pacer service uninstall --stop-work` cleans it up.
  - The first upgrade *into* this version still runs the old update code against the old unit, so on Linux that upgrade kills running work as today. The release notes say so.
- **macOS.** Runners and session hosts start in their own sessions, so `kickstart -k` (restart) and bootout/bootstrap (install) should not signal them. Live validation is the acceptance condition. If either path does signal them, the failure is recorded and the design is revisited. No plist change is made in advance.

## Upgrade paths and callers

`pacer update`, `update.apply` and `service install`/`restart` on a running service each work in three steps:

1. They read active work before restarting.
2. After the restart and a passed health check, the new service runs the handover.
3. For `update.apply`, the new service's job recovery (`recoverJobs`) triggers the handover, and the update job stays running until the counts are in. The CLI paths trigger it directly.
4. They report "Updated to v<version>. N tasks and M sessions kept running; K stayed on the previous runner." The new service returns these counts from the handover call. The path waits up to 60 seconds for runners to hand over and counts the rest as kept on the previous runner. The CLI prints this. For `update.apply` it is the operation result, which the web app shows.

**Callers.** Delegated tasks may not upgrade or reinstall the service. This prevents an accidental self-upgrade. It is not an authorization boundary against a same-user agent, which can read the operator token.
- **Server:** `assertCallerCanInvoke` refuses `update.apply`, `service.install` and `desktop.update.*` mutations from work-grant (`pwg_`) callers. These operations, and the new handover-trigger operation, are owner-only on the SEC-13 peer allow-list and refused for delegated callers in `caller-policy.ts`.
- **CLI:** `pacer update` and `pacer service install|restart|uninstall` refuse when `isExecutorSession` is true, with "upgrades are not allowed from a delegated task".

## Visibility

- **Task details** show "Reattached on v<version>" after a handover.
- **`pacer status` and Settings → Updates** list sessions still on an older host and tasks still on an older runner.
- **Sessions outside the support window** show **Reopen to update**.
- **Public status** carries versions and counts, never paths.

## Documentation

These change with the feature (REPO-7):
- `README.md` (updating pacer) and `docs/install.md` (service management);
- `docs/desktop-updates.md`, to state that desktop updates still wait for idle until part C;
- `docs/testing/live-validation.md`, for the new scenarios;
- the CLI help for `pacer update` and `pacer service`;
- a `CHANGELOG.md` entry.

## Out of scope

- Desktop native updates (part C).
- Stopping and resuming agents. Nothing here needs it.
- Upgrading remote host software.

## Validation

**Unit tests:**
- **Handover runs:** for each row of the run table, whether the run hands over, plus the commit point (leases finished, nothing revoked, `t.run` kept, exit 0 with no outcome).
- **Signal ignored:** an ineligible runner ignores the signal.
- **Strict tasks:** a handover across a version bump keeps a strict task running with one attempt and a valid guard token and grant.
- **Signalling safety:** a reused PID is never signalled, and a runner from an older protocol is never signalled.
- **Supervision state:** alert dedupe and `taskStop` during a handover.
- **Rollback:** an older sweep handles a handed-over task.
- **Handshake:** client and host with and without `versions`; the host never sends a new frame type to an older client; `session.version` drives **Reopen to update**.
- **Fixtures:** every release in the support window.
- **Linux unit:** the generated unit contains `KillMode=process`; a differing unit is rewritten and reloaded; uninstall cleans up.
- **Callers:**
  - a work-grant caller is refused by the server;
  - a CLI caller in an executor session is refused;
  - a bearer-token operator is allowed.

**CI:** a Linux job checks that a detached run and a session host survive `systemctl --user restart`, where the runner image supports user systemd. Otherwise it is recorded as UNVERIFIED.

**Live validation (CT-11), with real agents (Claude Code and Codex):**
1. **`upgrade-headless`:** a headless task is mid-turn when `pacer update` installs a newer fixture build. The agent is not interrupted, the runner hands over, and the task completes with its report recorded once.
2. **`upgrade-interactive`:** the same, for an interactive task whose agent runs inside an old session host.
3. **`upgrade-strict`:** a strict managed task survives a handover with its guard still accepting checks.
4. **`upgrade-terminal`:** a terminal running a long command survives, and its window reconnects with output intact.
5. **`upgrade-first-hop`:** upgrading from a pre-feature version signals nothing, and running work finishes on the old code.
6. **`upgrade-rollback`:** after upgrading and reinstalling the previous version, its runners and session hosts still work.
7. **`upgrade-install`:** the same as 1 and 4 through `service install`, which uses bootout/bootstrap on macOS.

Each scenario records the agent's process identity before and after, to show it never restarted. Scenarios 1 and 4 must also run on a Linux machine before the Linux claim is made. Until then, Linux is UNVERIFIED.
