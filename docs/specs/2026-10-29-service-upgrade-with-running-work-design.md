# Upgrade the service while work is running

Date: 2026-10-29

Status: Proposed. Decision record: [ADR: service upgrade with running work](../decisions/2026-10-29-service-upgrade-with-running-work.md).

## Problem

pacer's upgrade paths treat running work in three different ways, and none of them both upgrades promptly and keeps the work going:

- **Desktop updates** wait for idle. `reserveIdle` (`src/update/desktop/service.ts`) retries until no task, run, job or lease is active, and blocks new work in the meantime (`beginWorkSync`, `src/update/desktop/admission.ts`). With long agent tasks or an open terminal, the update can wait for hours. The native check `assertNativeProcessCoverage` (`src/update/desktop/native-provider.ts`) also refuses whenever any pacer process is running that is not enrolled work.
- **`pacer update`, the `update.apply` operation and `pacer service install`/`restart`** restart the service without checking for running work (`src/update/update.ts`, `src/service/index.ts`, `src/api/ops.ts`).
- **On Linux**, the systemd unit sets no `KillMode`. The default `control-group` mode kills every process in the service's cgroup on restart, including detached task runners and terminal hosts.

Most running work already lives outside the service:

- Each task runs in a detached `pacer _run` process (`src/tasks/api.ts`). Its agent runs from `run.sh` in its own session (`src/supervisor/run.ts`).
- PTYs are held by a separate `pacer _session` host on `session.sock` (`src/session/host.ts`), not by the service.
- Agents report by writing `report.json` (`src/session/reports.ts`), not over HTTP.
- The service's 5-second sweep (`superviseTasks`) restarts a runner for any run that is still alive.

So the missing piece is not keeping processes alive. It is a controlled way to stop agents at a good moment and resume them on the new version.

## Outcome

Every upgrade path upgrades without waiting for work to finish:

1. pacer holds new work.
2. It stops each running agent task at a safe point, forcing any that are left after a deadline.
3. It installs the new version.
4. It resumes every parked task in the same agent conversation, telling the agent the service was upgraded.

Terminal sessions keep running throughout. Nothing is lost silently: every parked task either resumes or ends with a stated reason and a **Retry**.

## Upgrade journal and states

The coordinator records its progress in `~/.pacer/state/upgrade/journal.json`. It is written with write-then-rename and owner-only permissions, and changes before every action. The schema is versioned (`schema: 1`). A reader that cannot parse the journal, or meets an unknown schema, never acts on it. It shows **Upgrade needs attention** and lists the parked task IDs it could still read.

| State | Meaning |
| --- | --- |
| `requested` | The target version and upgrade path are recorded, and the hold is active. |
| `parking` | Tasks are being stopped at safe points. Each parked task has a record. |
| `installing` | The upgrade path's installer is running. |
| `resuming` | A service at startup is resuming parked tasks. |
| `done` | Every parked task has resumed or ended with a reason, and the hold is released. |
| `failed` | Stopped before install. Parked tasks resume on the current version and the hold is released. |

Each parked task gets a record with these fields: `taskId`, `attempt`, `agent`, `sessionId`, `worktree`, `runDir`, `parkedAt`, `forced`, `resume` (`pending`, `resumed` or `failed`) and an optional `reason`.

## Hold

The existing admission layer becomes a general upgrade hold:

- While the hold is active, `delegate` and other task starts **accept and queue** new work instead of refusing it. The queue launcher (`drainQueue`, `src/tasks/drain.ts`) already leaves queued tasks queued while admission is reserved. The hold extends that behaviour to direct starts.
- Queued tasks show **Starts after the upgrade**.
- Background jobs that admission already gates are deferred, not failed.
- The hold is released when the journal reaches `done` or `failed`.

The desktop update keeps its existing admission reservation, now implemented as this hold.

## Safe points and parking

A task is parked when it reaches a safe point:

- **Interactive agent sessions:** the latest report is `turn-ended` or `needs-input`. Or the session has produced no output for 30 seconds and no descendant process of the agent is using CPU. These are the signals `src/exec/direct.ts` already tracks.
- **Headless agent runs** (`-p`, `exec`): no turn boundary is visible. They are parked only at the deadline.

To park a task, pacer does these steps in order:

1. Writes the task's record to the journal.
2. Sends SIGINT to the agent's process group.
3. After 10 seconds, sends SIGTERM.
4. After another 5 seconds, sends SIGKILL.
5. Stops the task's runner and marks the task `parked`. This is a new task state, shown as **Paused for upgrade**.

The agent's session ID comes from the run's existing records. A task without one cannot be resumed. It is never parked early. If it is still running at the deadline, it is stopped and fails with "stopped for an upgrade; it could not be resumed", and offers **Retry**.

**Deadline.** Parking waits up to `upgrade.park_deadline`, 10 minutes by default and configurable. Any task still running at the deadline is parked with `forced: true`.

**Remote runners** run on other hosts and are not stopped. The new service reattaches them through the existing sweep.

## Install

When every local task is parked or excluded, the journal moves to `installing` and the path's existing installer runs unchanged:

- the native helper for desktop updates;
- binary replacement and restart for `pacer update`;
- bootout and bootstrap for `service restart`.

Terminal session hosts are left running.

## Resume

A service starting up runs `resumeParked()` **before** its first `superviseTasks` pass. This keeps the orphan sweep from treating parked tasks as crashed. For each pending record, pacer resumes the same task and attempt with `resumeLaunchFor` (`src/exec/launch.ts`), using the recorded session ID and worktree, and sends one of these first messages:

- **Normal:** "pacer was upgraded to v<version> while you were working. Continue where you left off."
- **Forced:** the same, followed by "Your last action may not have completed; check its result before continuing."

A resumed task keeps its attempt number and does not count against retry limits.

If resuming fails because the agent CLI is missing, the session has expired or the worktree is gone, that task's record becomes `failed` with the reason. The task fails with "could not resume after the upgrade: <reason>" and offers **Retry**. Other tasks still resume.

Resume runs on whichever version is running after the install: the new version, or the old one if the installer rolled back. After the last record, the journal moves to `done` and the hold is released.

## Terminal sessions

Terminal and session hosts keep running through the upgrade, along with any command running in them.

- **Version handshake.** `session.sock` gains one at connect time. Both sides state the protocol versions they support and use the newest one they share. If they share none, the new service shows that terminal as **Reopen to update** and never kills it.
- **Desktop updates on macOS.** Session hosts run the bundled CLI from the previous app bundle. The coordinator records each surviving host in the journal: its PID, start time and executable cdhash, verified as the app's own signed CLI. `assertNativeProcessCoverage` and the native process inventory accept recorded, verified survivors as a second allowed class. They keep refusing any other pacer process.
- **Linux.** The systemd unit gains `KillMode=process`, so restarting the service no longer kills detached task runners or terminal hosts.

## Upgrade paths

Every path calls the same operation on the running service, then installs:

- **Desktop updates** call `upgrade.prepare(target, "desktop")` in place of the wait-for-idle loop. They install once it returns ready.
- **`pacer update` and the `update.apply` operation** call `upgrade.prepare(target, "cli")` before replacing the binary.
- **`pacer service restart` and `service install` on a running service** call `upgrade.prepare(current, "restart")`.

If no service is running, there is nothing to park and the path proceeds as today.

There are three operations: `upgrade.prepare`, `upgrade.status` and `upgrade.abort`. They are service operations with the same authentication as other control operations. `prepare` handles concurrent requests as follows:

- A second request with the same target **joins** the one in progress.
- A request with a different target is **refused** with the target in progress.

`abort` is allowed before `installing`. It moves the journal to `failed`, resumes parked tasks on the current version and releases the hold.

## Failure handling

| Failure | Result |
| --- | --- |
| Service crashes during parking | The next service start reads the journal, resumes the tasks already parked, leaves running ones alone and releases the hold. |
| Installer refuses or fails before changing anything | The journal moves to `failed`. Parked tasks resume on the current version. |
| Installer rolls back | Resume runs on the restored version. |
| Resume fails for one task | That task fails with the reason and a **Retry**. The others still resume. |
| Unreadable or unknown journal | Nothing is resumed automatically. **Upgrade needs attention** lists what is known, with **Resume parked tasks** and **Discard**. |
| Task without a resumable session | It is not parked early. At the deadline it fails with a stated reason and **Retry**. |

## Visibility

- **The desktop, the web app (Settings → Updates and the task list) and `pacer status`** show:
  - the phase;
  - the time left to the deadline;
  - each task's state: **Waiting for a safe point**, **Paused for upgrade**, **Resumed** or **Could not resume**.
- **Notifications** fire when parking starts, when tasks resume, and on any failure.
- **Public status** carries states and counts only, never paths.

## Out of scope

- Moving running work between machines.
- Upgrading remote host runners.
- Checkpointing an agent mid-tool-call. A forced park is announced to the agent instead.
- Automatic scheduling such as "upgrade at night". Paths keep their current triggers.

## Prerequisite

Fixture desktop builds get their own bundle identifier, for example `dev.pacer.desktop.fixture`. Live validation then never hands off to the user's installed app through Tauri's single-instance plugin. Today every live desktop run requires quitting the real app. This prerequisite is delivered first and validated on its own.

## Validation

**Unit tests (TypeScript):**

- **Journal:** every transition, fail-closed parsing, and a record from an earlier schema still readable.
- **Safe points:** a `turn-ended` report, a `needs-input` report, 30 seconds of silence with an idle subtree, and a headless run with no safe point.
- **Parking:** the record is written before the stop; signals escalate from SIGINT to SIGTERM to SIGKILL; `forced` is set at the deadline.
- **Hold:** new work queues instead of being refused, and the hold is released on `done`, `failed` and `abort`.
- **Resume:** `resumeLaunchFor` gets the correct note; attempt and retry counts are unchanged; one task's failure doesn't block the others.
- **Startup order:** `resumeParked` runs before the first sweep, and the sweep never touches parked tasks.
- **Operations:** concurrent `prepare` joins or is refused, and `abort` is allowed only before `installing`.

**Rust and desktop tests:**

- The process inventory accepts recorded, verified surviving session hosts and still refuses unknown pacer processes.
- The desktop update calls `upgrade.prepare` instead of waiting for idle.

**Linux:**

- A unit test that the generated systemd unit contains `KillMode=process`.
- A CI test that a detached run survives `systemctl --user restart`.

**Live validation (CT-11):** new scenarios with a fake agent that supports session resume:

1. **`upgrade-safe-point`:** a task reaches the end of its turn and is parked, the upgrade installs, and the task resumes on the new version and completes.
2. **`upgrade-forced`:** a task that never goes quiet is forced at a short test deadline and resumes with the incomplete-action note.
3. **`upgrade-terminal`:** an open terminal running a command survives the upgrade, and its window reconnects.
4. **`upgrade-crash`:** the service is killed during parking, and the next start resumes the parked tasks and releases the hold.
5. **`upgrade-desktop`:** the same flow through the desktop's native update in the signed fixture, including survivor enrollment.

Each scenario records the task's agent session ID before and after, to show the same conversation resumed.
