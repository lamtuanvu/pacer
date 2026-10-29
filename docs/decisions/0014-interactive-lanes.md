# 0014: Interactive lanes keep a backend-owned live worker

Date: 2026-10-29

Status: Proposed (accepted on merge)

## Context

Issue #452 asks for long-lived delegated lanes: a planner sends messages into a running executor, the executor can ask a question without losing its process, and many review rounds happen without rebuilding context. The maintainer's decisions are in the [interactive lanes design](../specs/2026-10-29-interactive-lanes-design.md): `pacer send` refuses while another caller drives the lane and `--force` takes over; answering an interactive lane delivers the answer into the running worker and respawns only once it has exited; `--group` nests lanes under one Orca parent worktree; and `--interactive` extends the `conversation` interaction mode rather than adding a third.

Before this change, every worker belonged to exactly one runner pass. It was settled, its terminal was closed and its slot was freed when the attempt ended. A worker that outlives its attempt needs an owner, or stop, budget and supervision stop applying to it.

## Decision

1. **The task owns a kept-alive worker, through its backend.** When an interactive lane's executor asks a question, the backend leaves the worker running and records it on the task as `TaskRecord.live` (`backend`, `worker`, `terminal`, `executor`, `agent`, `since`). The backend that wrote the record is the only one that can deliver into it or release it.
2. **A live worker holds its executor slot** (`holdsSlot` in `src/engine/slots.ts`) while it waits in `needs_input`. When an answer attempt is created, the slot passes to that attempt.
3. **Release paths.** `task.stop` (including stopping managed work), settlement (any state other than running, queued or waiting on its question), a review verdict, an answer routed to another executor, a retry that is not an answer, a failed answer delivery and four idle hours (`LIVE_IDLE_S`) stop the worker and close its terminal. The service's supervision pass (`reapLiveWorkers`) is the backstop for every path.
4. **Reattach on every round.** An answer reattaches to the live worker and takes over its ownership: `live` moves from the asking task to the answering attempt, and the Orca worker entry is re-keyed. `pacer send` and the next answer therefore find the worker on whichever attempt now owns it.
5. **Free text reaches only the agent.** Two independent guards keep typed text out of a shell, as API-5 and SEC-5 require:
   - The agent is launched with `exec`, so it replaces the terminal's login shell. When the agent exits, for any reason, the terminal's process ends with it. No shell is left behind the agent to read typed text.
   - Before typing an answer or a `task.send` message, the backend checks that the worker is unsettled and that the terminal still reports the lane's agent. On Orca this is `terminal show`'s `agentIdentity` for the recorded terminal incarnation, connected and writable. A different or missing identity, a restarted terminal or a settled worker means nothing is typed: `task.send` returns `unavailable`, and an answer releases the worker and respawns.

   What this does not guarantee: `agentIdentity` is Orca's identity label for the terminal, not proof of the foreground process, and the check and the typing are two separate Orca calls. Neither gap can reach a shell, because the launch leaves none. Text typed into the agent goes to the agent, which treats it as a prompt like any other.
6. **`task.send` is host-neutral.** It is an optional backend capability (`Backend.live`). A backend without it refuses with `unavailable`, and so does a task without a live worker. Only Orca implements it today. It accepts only a running lane: a lane waiting on its question has no runner watching the worker, so it is answered instead (`conflict` pointing at `pacer answer`), and the agent's resumed work is captured by the answering attempt. The state, revision and driving-lease checks run under the task lock with every other task mutation. The lease is claimed before delivery and handed back if delivery fails. Its holder is the caller's identity: a service client's `X-Pacer-Client` label, or the CLI's terminal. Two clients therefore contend (ARCH-3).
7. **Conversation scope.** Routing, verification and review apply to every conversation (decision 4 in the design), announced in the CHANGELOG under Changed. A `session.create` chat still runs on the direct backend, because `session.io` streams only that PTY. A lane runs on Orca only when it is started with `--interactive` (`TaskRecord.interactive`).

## Consequences

- A live worker counts against capacity until it is answered or released. A lane left waiting holds its slot for up to four hours.
- Orca terminals that do not report `agentIdentity` (older Orca releases, or agents Orca does not identify) cannot receive `pacer send` messages, and their answers respawn. The check fails closed.
- A lane's terminal closes when its agent exits, so the agent's last screen is not left in the terminal for a person to read; the attempt log keeps the record.
- `TaskRecord` gains optional `interactive`, `group`, `driving` and `live` fields (API-1 additive). The generated task operation types move to their own `pacer-task-protocol` crate, which keeps `pacer-client-protocol` within CRATE-3.
- Live delivery, reattach and release against a real Orca runtime need CT-11 evidence. Each change that affects them records that evidence or reports it as UNVERIFIED.
