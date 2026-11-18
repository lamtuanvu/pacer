# Task liveness: pacer keeps every delegated task moving until it is final

Status: proposed, 2026-11-17. Extends the liveness broker in [agent messaging](2026-10-28-agent-messaging-design.md).

## Problem

A delegated task can stay `running` forever. The case seen in production: an OpenCode executor whose provider is exhausted or failing shows `⚠ Retrying in 120s · attempt 3 · Provider request failed with HTTP 524` or `Retrying in 900s · attempt 6 · Rate limit exceeded`, and keeps retrying. pacer sees a healthy run:

1. Live session limit detection (`src/exec/limits.ts`, `SESSION`) has patterns only for Cursor, so an OpenCode screen is never checked.
2. That check runs only after `LIMIT_QUIET_S` (15 s) without output. The retry screen animates, so it is never quiet.
3. Idle detection (`src/supervisor/progress.ts`) treats any output as activity. The spinner resets it, so the 10 min idle alert and the 30 min idle stop never fire.

On the caller side, a finished, failed or asking task reaches the planner only through the `Stop` and `UserPromptSubmit` hooks, or a `pacer wait`. When the planner session is idle at its prompt or closed, nothing reaches it. The broker marks the participant escalated and the task waits.

## Intent

The maintainer's words: pacer is not only in charge of dispatching a task. It keeps the communication between the agents going so that nothing is stuck forever. It pings both the caller and the executor until the task reaches a final state, and asks the caller to review and decide.

The existing broker invariant ("some participant holds the next move, and it is making progress or a human has been told") becomes active: pacer drives the party that holds the next move until the task is final.

## Goals

1. A task whose executor makes no real progress is pinged, then stopped and moved, within a bounded time. Screen output alone is not progress.
2. An OpenCode retry loop is recognized while it animates. A rate limit moves the task to the next executor at once. A transient provider error moves it after a bounded retry window.
3. When a task needs a decision (review a result, answer a question, decide after a failure or limit), pacer asks the caller that dispatched it and keeps asking, choosing the delivery path per caller.
4. Every ladder ends: either the task reaches a final state or you (the human) have been told it is your move, with reminders.

## Non-goals

- pacer never accepts or rejects work itself. Review verdicts stay with the caller or you.
- No new messaging system. This extends the broker, stall detection and planner integrations that exist.
- No MCP push into live sessions in this version (see Later).
- No fresh reviewer session that stands in for the caller (approach C below) in this version.

## Anti-goals

- Typing into a terminal while you are typing in it, or while the planner is mid-turn in a way that corrupts input.
- Resuming a planner session in the background while the same session is open in a terminal. That forks the conversation: the open session never sees the background turn.
- Killing slow but legitimate work. A long build, test run or a long think that produces commits, reports or messages is progress.
- Spending planner budget on wake-ups in `strict` or `emergency` mode.

## Terms

- **Final state**: accepted, rejected or stopped (the task's origin closed it). `done`, `partial`, `failed`, `limit` and `needs_input` are not final; they need a caller decision.
- **Caller**: the participant that started the task, recorded today as `TaskRecord.origin` (`external:claude-code:<session>`, `external:codex:<thread>`, `human`) or the work parent.
- **Progress**: a file change or commit in the worktree (the existing git fingerprint), an outgoing message, question, report or outcome. Terminal output is not progress.

## Approaches

How pacer reaches a caller that owes a decision:

| | Approach | Trade-off |
|---|---|---|
| A | Resume the caller's own session in the background (`claude --resume <id> -p …`, `codex exec resume <id> …`) | Full original context. Uses planner budget. Forks the conversation if that session is open in a terminal. |
| B | Type the ping into the caller's live terminal | You see it and the planner answers in place with full context. Works only for terminals pacer can control (Orca, tmux, pacer's own terminal). |
| C | Start a fresh review session from the brief, diff and acceptance results | Always possible, no conflict. Loses the planner's reasoning. |

**Chosen (maintainer, 2026-11-17): pick per caller.** B when the caller's session is open in a controllable terminal; A when the caller's session is closed; hooks plus a notification to you when the session is open in a terminal pacer cannot control. C is left out of this version.

Executor side, when a retry loop or no-progress run is found: **move the task automatically** to the next eligible executor (my call, in line with the intent; the runner already does this for a detected limit, `src/tasks/runner.ts` `limitHit`). You hear about it only when no executor is left, as today's `limit`/`failed` outcome, which then goes to the caller ladder.

## Design

### 1. Executor side

**Retry banner detection.** Add OpenCode session patterns anchored to its own banner line, `⚠ Retrying in <n>s · attempt <n> · <reason>`. Classify the reason with the existing tables: `GENERIC` limit phrasing (`Rate limit exceeded`, quota, 429) is a limit; HTTP 5xx, 524, `overloaded` and `TRANSIENT_PROVIDER_PATTERNS` are transient. The check reads the latest screen frame (the current transcript tail after ANSI stripping), not only after a quiet period, but only for agents with an anchored banner pattern so that source code on screen cannot match.

- Limit: end the attempt with `limit` as today. The runner marks the account exhausted and continues to the next executor.
- Transient: start a window when the banner first appears. If the banner is still present, or reappears, with no progress for `execution.transient_retry_min` (default 10), end the attempt as broken with the provider reason. The runner marks the executor broken for its normal cool-down and continues to the next executor.

**No-progress backstop.** For any run, track the last progress time separately from the last output time. When an executor has made no progress for `execution.no_progress_min` (default 30) while output continues, the broker records a new stall reason `no_progress` and pings the executor through its delivery driver (live driver types into the executor session; resume driver nudges after the turn): "pacer: no progress for 30 min. Report progress, ask your parent, or report a blocker." A reply of any kind is progress. After `liveness.max_nudges` pings without progress, the broker stops the run and the runner retries the task on the next executor once; if that also stalls, the task ends `failed` with reason `unresponsive`. The existing output-based idle stop stays for silent runs.

Conversation-mode runs keep their current exemption from the deadline but are covered by the no-progress backstop, because a conversation that loops on a provider error is stuck too.

### 2. Caller reach, recorded at dispatch

When a planner runs `pacer delegate` (CLI or MCP), the client records a **caller reach** alongside the existing origin:

- native session id (`CLAUDE_CODE_SESSION_ID`, `PACER_PLANNER_SESSION`, Codex thread id);
- planner process id and start time (to tell whether the session is still open, robust to PID reuse; the existing `ProcessIdentity` shape);
- terminal handle and kind, in the order `src/session/send.ts` already reads them: Orca (`ORCA_TERMINAL_HANDLE`, `ORCA_PANE_KEY`), tmux (`TMUX_PANE`), pacer's own terminal, else `uncontrolled` (for example `TERM_SESSION_ID` from Terminal.app or iTerm).

The reach is a delivery hint, not identity: identity still comes from the existing derivation (ADR 0011, `callerParticipant`). The service accepts a reach only for the caller's own participant and only stores it on that caller's tasks.

### 3. Caller ladder

A task in `done`, `partial`, `failed`, `limit` or `needs_input` with no verdict, or a stalled node escalated to its caller, owes the caller a decision. The broker sends one `kind: "report"` or `question` message (as today) and then works the ladder on its backoff:

1. **Hooks** (existing): `Stop` blocks the planner from ending its turn with the message pending; `UserPromptSubmit` adds it to the next turn.
2. **After `liveness.caller_wake_after_s`** (default 300 s) with the message unread:
   - Caller session open, terminal controllable: type a one-line ping into the terminal — "pacer: task <id> is <state>. Review and decide: `pacer review <id> --accept|--reject`, or `pacer msg inbox`." Only when the terminal host reports the agent idle at its prompt and there was no human input in the last `caller.typing_quiet_s` (default 30 s). Otherwise wait for the next tick.
   - Caller session closed: resume it in the background through the planner adapter with the same text as the prompt. The resumed turn sees the full context and has the same authority as an attended planner turn: it can review, run acceptance, accept, reject, send back, retry or ask (maintainer, 2026-11-17). Its verdicts are recorded in the activity log as made by a resumed turn, so they can be audited later.
   - Caller session open, terminal not controllable: no extra step; go to 3.
3. **After `liveness.escalate_after_s`** (default 900 s) still undecided, or when step 2 is not allowed: notify you (attention item and notification, as `stalled` today) with the task and what it waits for. Reminders follow the backoff.

Bounds: at most `liveness.max_nudges` terminal pings or resumes per pending decision. Resumes count as planner turns, pass budget admission and are skipped in `strict` and `emergency` mode (the existing `nudge_in_modes`). A caller decision of any kind (verdict, retry, message, stop) clears the ladder. A `human` caller is never typed at or resumed; it only gets the notification and reminders.

### Settled during design review (designer's calls)

- **Where the progress clock lives.** The run's progress poller keeps writing git progress (`progress.lastChangeAt`). The broker owns the no-progress decision: it takes the latest of `lastChangeAt` and the node's last outgoing message, question, report or outcome from the messages table. An executor that is answering messages while a banner animates is therefore not stuck.
- **Typing into a terminal pacer did not launch is new work, not reuse.** Today pacer types only into sessions it owns, and into Orca worker terminals it created (`src/exec/orca/wait.ts` uses `terminalShow` and `terminalEnter`). Orca's CLI can send input to any live Orca-managed terminal by handle (`orca terminal send`), so the Orca adapter adds a send call to the existing Orca client. tmux needs a new `send-keys` adapter. pacer's own terminals use `src/session/`. Each is a separate adapter and can ship separately; Orca first.
- **Two observation paths (found in live validation).** Default local runs go through the bundled `pacer-exec-direct` plugin and are observed in 60 s leases (`src/plugins/executor-production.ts`); only Orca, strict and legacy resume runs use the run poller in `src/exec/direct.ts`. Retry-loop checks run on both, through one shared helper: at each lease renewal on the plugin path, at each poll otherwise. A plugin-owned attempt stopped for a provider retry loop moves to the next executor like a limit; other broken reasons on that path still fail the task. The plugin path also writes no run progress today, so the output-based idle alert and stop do not fire there; the no-progress backstop (PR 2) must cover it.
- **MCP delegates.** The MCP server is a child of the planner process and inherits its environment, so it records the same reach when the variables are present. When they are not (no session id), the task gets the generic planner inbox, the hooks and the notification to you, but no terminal ping or resume.

### 4. Architecture placement

- Detection patterns stay in `src/exec/limits.ts` (OpenCode entry in `SESSION`, banner parser).
- `no_progress` and the caller ladder are new broker stall reasons and actions in `src/messaging/liveness.ts` and `broker.ts`, using the existing liveness store, backoff and attention.
- Terminal typing and session resume go through adapters (ARCH-4, ARCH-5): Orca typing through the executor plugin's terminal capability, tmux and pacer terminals through `src/session/`, resume through a per-planner adapter next to the planner installers. The core names no planner or host.
- New config keys go in `execution` and `messaging.liveness` schemas, with Rust config parity where those sections are mirrored (`crates/config`).
- Resume runs an argument vector, never a shell string (SEC-5).

## What is left to the builder

- Exact OpenCode banner regex and the transient/limit classification table, from real transcripts (the session logs show both forms).
- How the terminal host reports "agent idle at prompt" (Orca agent status hooks, tmux pane activity) and the fallback when it cannot.
- The Codex resume invocation and whether Codex supports a non-interactive resume of an existing thread; if not, Codex callers skip the resume step.
- Where the caller reach is stored (task record field or a messaging table) and its retention.
- Operations and events (`liveness.status` rows for the new reasons, attention text), and protocol docs regeneration.
- Tests: pure analysis tests for the new stall reasons, banner fixtures under `test/fixtures/`, broker ladder tests with fake adapters, and CT-11 live validation with a fixture executor that prints the retry banner.

## Later

- MCP push into a live planner session, to cover sessions in terminals pacer cannot control.
- Approach C as an opt-in when the caller cannot be reached.
