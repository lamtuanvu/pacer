# 0023: One interactive mode for live sessions

Date: 2026-11-07

Status: Proposed. Accepted when the maintainer merges it.

Supersedes: decision 5 ("Read-only by default. At most one controller.") and the "One controller" bullets of the [live sessions design](../specs/2026-10-16-live-sessions-design.md), and the "exclusive input control" that the [built-in terminal ADR](0008-built-in-terminal.md) reuses. Amends how [0014](0014-interactive-lanes.md) delivers into built-in sessions.

## Context

A live session has one PTY, owned by the session host (`src/session/host.ts`). The control policy runs in `ViewerHub` (`src/session/viewers.ts`). `crates/sessions/src/control.rs` mirrors it for golden tests. Clients attach to the host's Unix socket: the app's xterm.js pane through the `pacer serve` WebSocket bridge, `pacer attach`, and pacer's own automated input for built-in sessions (`typeIntoSession` in `src/messaging/live.ts`). Orca lanes deliver through `Backend.live` instead and are not affected by this ADR. Every client is pacer code, but the host arbitrates between them as independent parties. A client is read-only until it sends `take`. `take` succeeds only when nobody holds control, unless the client sends `force`. Input from anyone else is dropped.

The rule was meant to stop two people from typing into one agent at once and to keep two windows from fighting over the PTY size. In practice it blocks pacer from delivering to itself:

- The app takes control automatically when it connects and nobody holds it (`autoControl` in `app/src/term/client.ts`). It keeps control for as long as the pane stays open, whether or not anyone types.
- Answers, `pacer send` and live messages into built-in sessions type through a non-forced `take`. While the app holds control, the host refuses. `pacer answer` then fails with "Terminal is controlled by another viewer or the run changed", and live messages are stored but never typed (`liveBlocked: "viewer"`).
- The `control` frame tells the app who holds control, but `pacer answer` fails with one fixed message for two different causes (`src/session/send.ts`): another client holding control (`refused`), and the run or question changing before delivery (`busy`).
- Control also drives behavior unrelated to input. Holding control pauses active-time accounting (`src/supervisor/active-time.ts`) and the idle-fail clock (`src/exec/direct.ts`), and releasing control ends a takeover session ("Handed back by …").

In practice pacer has one user, and every party is pacer. The exclusive lock costs more than the collisions it prevents.

## Decision

1. **Every attached interactive client can type.** Live sessions have no controller. The host applies each `input` frame atomically, in arrival order, and attributes it to the client label in the recording markers. The app's terminal pane, `pacer attach` and the built-in shell terminal accept keystrokes as soon as they are live and focused.

2. **Some viewers stay read-only.** A viewer is read-only when it sets `readOnly: true` in its `hello` frame, and in these cases:
   - **`pacer attach` from an executor session.** API-5 already refuses executors' `pacer send` and `pacer answer`, and attaching must not get around that.
   - **Viewers from paired or remote machines,** until a later decision grants them input.

   `pacer attach --read-only` sets the flag explicitly. The flag is set by the client, so executor read-only is cooperative, like the driving lease. It is not a security boundary unless a later change has the host check the caller's role. The host drops a read-only viewer's `input`, `size`, `focus` and `deliver` frames.

3. **The PTY size follows the most recently active client.** A client becomes active when it sends input or a new `focus` frame (sent when its pane gains focus). Its `size` is then applied. Size frames from other clients are recorded but not applied until that client becomes active. With no active client, the PTY keeps its last size, starting at 120×40, as it does today.

4. **pacer's automated input goes through a delivery window, not control.**
   - **Request.** pacer's internal delivery path (answers, `pacer send` and live messages into built-in sessions) sends a new `deliver` request on the Unix socket. The `pacer serve` WebSocket bridge refuses `deliver` from browser clients. The built-in terminal never accepts it, so pacer never types free-form text into a login shell (API-5, SEC-5, [0008](0008-built-in-terminal.md)).
   - **Grant.** The host grants the request once both of these hold:
     - No client input has arrived for a quiet period (default 1.5 s).
     - No human line is pending: since the last Enter, no client has typed printable input.
   - **Window.** On grant, the host holds other clients' input for at most 2 s. Held input is queued, never dropped. Within that window the sender runs its existing guard (`stillIdle`, or the answer's `same` check), then sends the paste and Enter, or cancels.
   - **Failure.** If the grant conditions don't hold within 10 s, the request fails with `conflict` and names the cause, for example "unsent input in the agent from Pacer desktop". The live message path keeps its existing retry for that case. A changed run or question keeps its own distinct `conflict` message.

5. **The host answers terminal queries.** With many interactive clients, every xterm.js would answer the agent's terminal queries. The host now always answers them itself, as it does today with no controller, and strips client replies to queries from input frames. This covers DA1, DA2, cursor position reports and OSC colour queries.

6. **Activity replaces "controller" in supervision.** Idle-fail (`src/exec/direct.ts`) and active-time accounting (`src/supervisor/active-time.ts`) use the most recent client input (`lastInputAt`) instead of a controller lease. A human who typed within the idle window keeps the task from being treated as idle. A pane left open without typing no longer pauses the task's clocks.

7. **Hand-back is an explicit action.** Ending a takeover session is a new `task.hand_back` operation, exposed as an app button and as a `pacer attach` key (`Ctrl-]` then `h`). It is no longer a side effect of releasing control. Detaching still leaves the agent running.

8. **Protocol compatibility (P4, API-2).**
   - **Session-socket protocol.** It bumps from `[1,1]` to `[1,2]`. Version 1.2 adds `focus`, `deliver`, `granted` and `delivered` and the `readOnly` hello field. Session hosts outlive service upgrades and are supported for `SESSION_SUPPORT_MINORS` (3) minors. So a client chooses its behavior from the version it negotiated with the host:
     - Against a 1.1 host, a client keeps the current take/release behavior.
     - It never sends 1.2-only frames, so a 1.1 host or an older `pacer serve` bridge never sees an unknown frame.
   - **Older clients on a 1.2 host.** The host accepts `take` and `release` from a client that negotiated 1.1. `take` returns `control` `{controller: null, you: true}`, so the client enables input. Its `control` and snapshot frames always carry `controller: null`, so an older app pane never shows a "Take over?" prompt. `pacer attach --control` and `--force` are accepted and ignored. On a takeover session, `release` from a 1.1 client is treated as `task.hand_back`, so older clients can still hand back.
   - **Client API protocol.** `TaskData.session` and the `task.session` result gain an additive `active` field (the label of the most recently active client). `controller` keeps its type and stays as a deprecated field, always `null` for 1.2 sessions. It is removed only in the next major API protocol release, following API-2's compatibility window. The CLI's "controlled from X" line (`src/cli.ts`) reads `active` instead.

9. **The `pacer send` driving lease is unchanged.** [0014](0014-interactive-lanes.md)'s lease arbitrates which *caller* is steering a lane's conversation. It is not PTY access and stays as it is.

## Consequences

- For 1.2 sessions, the app no longer shows "Take control", "Release control", "Watching · read-only" or the "Someone is in control. Take over?" dialog. It keeps that UI for 1.1 hosts until they age out. For 1.2 sessions, the terminal status shows who typed last and when pacer delivered input ("pacer delivered an answer").
- An app pane left open no longer blocks answers or messages into built-in sessions. `liveBlocked: "viewer"` is retired for 1.2 sessions. Its last remaining cause, unsent human input, is reported as a `conflict` that names it.
- Two people typing into the same agent at the same time will interleave at frame granularity. This is accepted, as tmux accepts it.
- The pending-line check is a heuristic. Agent TUIs with multi-line editors, history recall or arrow-key editing can leave text in the input box that the host cannot see. Keystrokes from the user's own terminal UI, outside pacer, remain invisible to it, as noted in `src/session/send.ts`.
- Removing the controller simplifies `ViewerHub`, its Rust golden-test mirror, `typeIntoSession` and the app's terminal client. The delivery window adds a small piece of host state. The 1.1 path stays until the last supported 1.1 host has aged out.
- Removing the app's control UI is a UI change. It needs the UI review, accessibility and QA evidence from amendment 0.4.0.
- Changes to the session host, delivery and the app terminal also need CT-11 evidence from `bun run live`:
  - two clients typing;
  - an answer delivered with the app pane open;
  - a delivery refused because of pending input;
  - size following focus;
  - terminal-query replies not duplicated;
  - takeover hand-back;
  - a new client against a 1.1 host.

  Changes report any surface they could not exercise as UNVERIFIED.

## Alternatives considered

- **Keep the lock and let automated input force it.** Rejected. It turns every delivery into a visible steal from the app. It still needs the pending-input check to avoid pasting into a half-typed line. It keeps take/release, which serves no one in a single-user product.
- **Keep the lock and release control automatically after N idle seconds.** Rejected as the main fix. It narrows the window but keeps the read-only default, the Take control flow, and control coupled to supervision and hand-back.
- **Add a host `inject` frame for pacer's input but keep human control exclusive.** This was the first proposal. It fixes delivery, but it still keeps a read-only default between human clients that pacer doesn't need. Decision 4 keeps its useful part (a quiet, guarded, atomic delivery) without the lock.
- **Make each client choose read-only or interactive when it connects (the old default reversed).** Partly adopted, as decision 2. Making read-only the exception keeps the common case to one mode.
