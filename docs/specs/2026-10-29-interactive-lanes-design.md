# Interactive long-lived delegated lanes

Date: 2026-10-29. Status: draft — maintainer decisions requested (see `.work/QUESTION.md` in the implementer's worktree). No runtime behavior changes until the open decisions return and this doc is updated to reflect them.

## Intent

[Issue #452](https://github.com/lamtuanvu/pacer/issues/452). `pacer delegate` is brief → run → result, one shot. The 2026-10-28/29 run of 14 hand-driven lanes showed a planner needs, for large multi-ticket work:

- mid-run messages from the planner into a still-running executor,
- an executor that can escalate ("NEEDS DECISION") without stopping its other independent progress,
- many review/iteration rounds without rebuilding context each time,
- several lanes visible together under one named parent in Orca, each with its own worktree, branch and a live terminal a human can watch or type into,
- all of it routed, budgeted and reviewed by pacer — which is the reason [#451](https://github.com/lamtuanvu/pacer/issues/451) (the enforcement gap) exists: today, going around pacer for exactly this kind of lane costs nothing.

This design proposes the smallest shape that removes the reason to drive executors by hand, by composing capability pacer already has rather than building a parallel stack.

## What already exists

pacer already has most of the parts this issue asks for, built for other reasons. The design's job is to connect them, not invent them.

| Need from #452 | Existing building block | Gap |
|---|---|---|
| Live Orca worktree + terminal for a task | `src/exec/orca/backend.ts`: `worker-start` with `--worktree new-child`, a worktree and branch per attempt, a terminal handle | None — already how every Orca-backed delegated task runs. |
| A human or the planner watching live | `src/session/service.ts` `SessionHost`/takeover (`OrcaSessionHost`), `pacer session io <id> --control` (`src/commands/session-io.ts`) — attaches to *any* task's Orca terminal (delegated or conversation) over a WS protocol with take/release control and input/size/output frames | Not exposed as a one-shot `pacer send`; today it is a persistent viewer protocol a human or a thin client drives. |
| Escalation ("NEEDS DECISION") without stopping other progress | `pacer ask` (executor-only, one open question at a time) → `src/exec/orca/wait.ts` turns Orca's `question`/`escalation` wake messages into `TaskRecord.question` + `needs_input` state; `pacer watch` already renders `needs_input` as a "settled" event with the question and the next command | `answer` (`src/core/tasks.ts:333`) always spins a **new retry attempt** — a fresh worker, not a message into the same running process. Fine for one-shot delegate, wrong for a lane that should keep running. |
| Many review/iteration rounds in one session | `dispatch.child`/`dispatch.answer`/`dispatch.retry`/`dispatch.review` (`src/commands/dispatch.ts`, `src/core/dispatch.ts`) — a scoped work tree with grants (API-5), siblings that keep running while one needs input | Same retry-not-message behavior as above; no "same process, many turns" primitive. |
| Routing + budget stay in pacer | `previewDispatch`/`rankExecutors`/dispatch ladder already runs for `dispatch.submit`/`dispatch.child`; `includePlanner` already lets the planner's own account be ranked | `pacer session create` (the only *live-terminal* launch path today) picks an executor from `session.prepare`'s list directly — it does not call the dispatch ladder, so a `--interactive` lane would bypass routing exactly where #452 says it must not. |
| Named parent group, shown together | Orca itself: `orca worktree create --parent-worktree <selector>` nests a worktree under a named parent in Orca's own UI | pacer's Orca backend never calls this. It uses `worker-start --worktree new-child`, whose convenience worktree-creation has no `--parent-worktree` passthrough (confirmed from `orca orchestration worker-start --help`). Grouping needs a `orca worktree create` call pacer doesn't make today, before `worker-start --worktree <that selector>`. |
| Per-lane resources (worktree, branch, DB) | Worktree/branch: already per-attempt. Test database: not pacer's concern today — brief/`acceptance` already lets a task's setup create one; nothing to add unless a lane needs a *shared* DB across its group, which no existing fixture does. |

Two existing modes collide conceptually and the design has to pick one to extend:

- **`interactionMode: "delegated"`** (default): routed, budgeted, reviewed, retried. No live terminal access once launched (the human only sees logs/tail through `watch`/`workerRead`).
- **`interactionMode: "conversation"`**: has the live terminal (`session.*`, takeover), but is launched by `pacer session start` picking an executor straight from `session.prepare`'s list — no dispatch ladder, no budget-aware routing, no review/retry loop, no `TERMINAL_STATES`/`needs_input` wiring.

`--interactive` is, structurally, "delegated routing and review, with conversation's live terminal." Neither mode is that today.

## Proposal shape (non-binding on the open decisions below)

1. **`pacer delegate --interactive [--group <name>]`**: create a `TaskRecord` as today's `delegate` does (routed through `previewDispatch`/the ladder, budget-attributed, reviewed on completion), launched through the Orca backend as today, but recorded with a live-terminal flag so `session.io`/takeover can attach to it as it already does for `conversation` tasks. `--group <name>` creates (or reuses) a pacer-tracked parent worktree per group and passes its selector when creating the lane's worktree, so Orca's own UI nests every lane of the group under it.
2. **`pacer send <id> "<message>"`**: the planner side of delivering input to a running task. Opens the same live-terminal path `session io` already has, writes one input frame, records a `message` event on the task's timeline (`taskActivity`, the same log `retry`/`task_started` already use), and detaches. Does not create a new attempt.
3. **Escalation stays `pacer ask`/`question`/`needs_input`, but `answer` on an interactive lane must not force a new attempt.** The existing `question`→`answer`→`retry` loop remains correct for one-shot delegated tasks. For `--interactive` lanes it needs a second path: deliver the answer as a `pacer send`-style message into the *same* running terminal, and only fall back to a fresh attempt if the worker has actually exited. This is Decision 2 below.
4. **Groups surface in `pacer tasks`/the Dispatcher UI** as a group label on `TaskRecord`, independent of whatever Orca-side nesting Decision 3 settles on, so grouping is visible even where Orca nesting doesn't apply (e.g. non-Orca backends).
5. **Routing and budget are unchanged in kind**: a `--interactive` lane goes through the same `previewDispatch` ladder as any `dispatch.submit`, and usage is attributed to the resulting attempt exactly as today. Nothing new to decide here — flagged only so review confirms it, since it is the reason #451/#452 exist together.

## Decisions needed before implementation

See `.work/QUESTION.md` (untracked, implementer's worktree) for the maintainer-facing version with recommendations. Summarized:

1. **How does `pacer send` actually deliver text into a running lane** — reuse the existing takeover/`session.io` live-attach-and-inject path (contends with a human who has already taken control), or add a second, cooperative channel through Orca's own mailbox (the same channel `question`/`escalation`/`worker_done` already use), which needs the executor's prompt to poll for it and doesn't contend with a human typing, but is new protocol surface Orca's wake types don't have today (`planner_message`)?
2. **Does answering an open question on an interactive lane ever spin a new attempt**, or does it always deliver live and only fall back to a fresh attempt when the worker process has actually exited? This changes `src/core/tasks.ts` `answer`/`retryTask` for interactive lanes specifically.
3. **Is Orca-side visual grouping (`--parent-worktree`) in scope for v1**, given it requires pacer to create the group's parent worktree itself (a new Orca call pacer doesn't make today) before starting each lane's worker against it, or does v1 ship a pacer-side-only group label (visible in `pacer tasks`/the app, Orca worktrees stay flat) and defer Orca nesting?
4. **Is `--interactive` a new `InteractionMode`, or does `conversation` gain dispatch routing, budget attribution and the review/retry loop it lacks today?** The first duplicates less of the state machine but adds a third mode; the second reuses conversation's live-terminal machinery but means teaching it routing, `needs_input`, review and retry it was never built with.

## Non-goals (carried from the issue and from existing specs)

- Replacing `dispatch.child`'s scoped-grant model (API-5) for how a child task gets created; an interactive lane's own escalations still go through it.
- Changing the managed-delegation-enforcement guarantee (strict/cooperative) — an interactive lane is still a managed attempt and still needs a current enforcement certificate in strict mode.
- A new live-terminal protocol. `session.io`'s WS framing (hello/control/input/size/output/exit) is reused, not replaced.
- Solving #451 (the shell-level enforcement gap) here; that issue's `PreToolUse` shell guard is a separate, smaller change this design does not depend on, though removing the planner's reason to go around pacer is this design's whole point.

## Validation (once decisions return)

- `pacer delegate --interactive` is routed through the same ladder as `dispatch.submit` (assert a recorded decision, not a bypass).
- `pacer send` delivers into the live terminal without disturbing a human controller's own `--control` session (or is refused with a clear reason, per Decision 1).
- An escalation on an interactive lane leaves the lane's own later turns and any sibling lane in the same group unaffected.
- `--group` is visible together in `pacer tasks` and, if Decision 3 selects Orca nesting, in `orca worktree list` under the named parent.
- CT-11 live validation with the harness (`bun run live`), covering CLI and, for any UI-visible grouping, the Dispatcher UI. Surfaces not exercised are reported UNVERIFIED.

Review follows REPO-10, plus API-1–5 (new/changed ops), ARCH-1/2/5/12 (session/dispatch boundary), SEC-1/5 (enforcement token scope for `pacer send`), CT-4/11.
