# Interactive long-lived delegated lanes

Date: 2026-10-29. Status: decided by the maintainer on 2026-10-29 (see "Decisions" below), implemented, independently reviewed, and fixed per that review and the later project review (see "Project review follow-up"). One correction from the draft is recorded under "What `pacer send` actually reuses" — session `io`'s WS transport does not bridge Orca terminals today, so `pacer send` was built on `OrcaClient.terminalSend` directly rather than that transport.

## Intent

[Issue #452](https://github.com/lamtuanvu/pacer/issues/452). `pacer delegate` is brief → run → result, one shot. The 2026-10-28/29 run of 14 hand-driven lanes showed a planner needs, for large multi-ticket work:

- mid-run messages from the planner into a still-running executor,
- an executor that can escalate ("NEEDS DECISION") without stopping its other independent progress,
- many review/iteration rounds without rebuilding context each time,
- several lanes visible together under one named parent in Orca, each with its own worktree, branch and a live terminal a human can watch or type into,
- all of it routed, budgeted and reviewed by pacer — which is the reason [#451](https://github.com/lamtuanvu/pacer/issues/451) (the enforcement gap) exists: today, going around pacer for exactly this kind of lane costs nothing.

This design composes capability pacer already had (the Orca worker/worktree model, `dispatch.child`'s scoped tree, `pacer ask`/`needs_input`, the choice ladder) rather than building a parallel stack.

## What already existed

| Need from #452 | Existing building block | Gap this design closed |
|---|---|---|
| Live Orca worktree + terminal for a task | `src/exec/orca/backend.ts`: `worker-start` with `--worktree new-child`, a worktree and branch per attempt, a terminal handle | None for a plain lane. For `--group`, see below. |
| Escalation ("NEEDS DECISION") without stopping other progress | `pacer ask` → `src/exec/orca/wait.ts` turns Orca's `question`/`escalation` wake messages into `TaskRecord.question` + `needs_input`; `pacer watch` already renders `needs_input` as a "settled" event with the question | `answer` always spun a **new attempt** — a fresh worker, not a message into the same running process — and the Orca backend stopped the worker as soon as it settled `needs_input`, so there was nothing left to reattach to. |
| Many review/iteration rounds in one session | `dispatch.child`/`dispatch.answer`/`dispatch.retry`/`dispatch.review` — a scoped work tree with grants (API-5), siblings that keep running while one needs input | Same respawn-not-message behavior for managed (`dispatch.child`-created) lanes too (`src/core/work.ts`'s `restartWork`, which reuses the task id in place rather than creating a new one). |
| Routing + budget stay in pacer | `previewDispatch`/`rankExecutors` already ran for `dispatch.submit`/`dispatch.child`; conversation tasks already went through `rankExecutors` too, just with their candidate set narrowed to the one requested executor when no project policy existed | A `conversation` task's requested executor was a hard, no-fallback restriction instead of a validated preference, and `conversation` tasks were unconditionally forced onto the direct backend, never Orca. |
| Named parent group, shown together | Orca itself: `orca worktree create --parent-worktree <selector>` nests a worktree under a named parent in its own UI (confirmed from `orca worktree create --help`; `orca orchestration worker-start --help` has no such passthrough on its `new-child` convenience creator) | pacer's Orca backend only ever called `worker-start --worktree new-child`. Grouping needed a `worktree create` call pacer didn't make, before `worker-start` targets the already-created worktree. |

## What `pacer send` actually reuses

The draft of this design assumed `session.io`'s WS transport (`src/commands/session-io.ts`, `src/serve/session-ws.ts`) already bridged a live Orca terminal, since `src/session/service.ts` has an `OrcaSessionHost` class and `sessionInfo()` reports a `host: 'orca'` case. On inspection, that WS route (`upgradeSession`) only proxies a local Unix socket from the **direct** backend's own PTY session (`sessionDirectory()` resolves only for `task.run`-bearing attempts, which the Orca backend never sets); `OrcaSessionHost`/`attachTarget()`'s `{kind:'orca'}` branch exists but nothing bridges it into that WS framing today, and "watching live" for an Orca-backed task means opening Orca's own terminal pane, not a pacer-brokered socket.

Given that, and given Orca's API gives pacer no push-based output stream for a worker terminal (only `terminal show`'s polled preview/tail and `terminal send`'s write), `pacer send` is a direct, one-shot delivery: `OrcaClient.terminalSend(terminal, text)`, gated by a cooperative lease (`TaskRecord.driving = {by, at}`, 60 seconds) rather than a true multi-process lock — pacer cannot see a person typing directly in Orca's own app, and says so. This keeps the decided refuse/`--force` shape (`src/session/send.ts` `send()`) without claiming a transport that does not exist.

## Decisions (Vu Lam, 2026-10-29)

1. **`pacer send`'s delivery mechanism: reuse the takeover/send-style path (A).** Refuse and name the controller when control (the `driving` lease) is held; `--force` takes over and is logged. Implemented in `src/session/send.ts` `send()` / `DRIVING_LEASE_S`, exposed as `task.send` and `pacer send <id> "<message>" [--force]`.
2. **Answering an interactive lane delivers live into the running worker (A); falls back to a respawn only once the worker has exited.** Implemented in `src/exec/orca/backend.ts`: `findLiveAnswerWorker` detects a still-running worker for the task being answered (covering both a plain `--interactive` answer's new, `retryOf`-linked task and a managed `dispatch.answer`'s same-task-id restart), and `reattachOrcaAttempt` delivers the answer text via `terminalSend` and resumes supervision instead of starting a fresh worker. The settling side of this is in the same file: an interactive lane's `needs_input` escalation (`pacer ask`) now leaves its worker and terminal alive rather than stopping them, so there is something to reattach to.
3. **Orca-side visual grouping ships now (A), not deferred.** `pacer delegate --group <name>` creates (or reuses, cached per repo+group in `~/.pacer/orca.json`) a top-level parent worktree via `orca worktree create --no-parent`, then creates each lane's own worktree nested under it with `orca worktree create --parent-worktree <selector>`. Since the Orca backend now creates every new-child worktree itself before starting the worker in it (#461), a group lane is an ordinary `new-child` placement that also carries `parentWorktree`: `prepare()` resolves the group, and `runOrcaAttempt` creates, verifies and supervises the lane worktree like any other new-child worktree. If `worker-start` is then definitively refused (not an ambiguous result, which skips fallback to avoid double execution), the backend's own created-worktree discard removes the lane worktree rather than leaving an orphan — a gap the independent review caught in the first cut; pinned by `test/orca-backend.test.ts`'s "group: a refused worker-start removes the orphaned lane worktree it just created".
4. **`--interactive` extends `conversation` mode (B)** rather than adding a third `InteractionMode`. `conversation` now: goes through the same executor ranking as a delegated task (an explicit request is a validated, fallback-eligible preference, not an exclusive restriction); can run on the Orca backend, not only direct (`runner.ts`'s backend choice drops `task.interactionMode === "conversation"` from the direct-only condition, keeping it only for strict enforcement); and is no longer special-cased out of `needs_input`/verification/review on settlement (`runner.ts` removed the conversation early-return, so a conversation now gets a real diff, an optional acceptance check, and review/retry eligibility exactly like a delegated task). `pacer delegate --interactive` is literally `delegate()` with `interactionMode: "conversation"` set, so it inherits the ladder-routed, budget-attributed path delegate already had.

   The first cut of the ranking change (dropping the old `conversationSelection` narrowing) went
   through two broken intermediate states before the final `conversationFallback()` shape, caught
   by the independent review (not by the implementer) in the second case:
   - Deleting the narrowing outright broke reachability: a conversation naming an executor a
     routing rule excludes entirely (e.g. the planner's own account) could no longer run at all.
   - Patching that by passing an explicit `CandidateSelection` into `rankExecutors` (so the
     requested-but-excluded executor had somewhere to go) fixed reachability but silently defeated
     `rankExecutors`' own `pacing.policy === "priority"` ordering — passing any explicit selection
     takes an early-return branch in `rankExecutors` that sorts by array order alone, skipping
     EXPIRING-promotion/AHEAD-demotion/headroom reordering entirely, for every candidate, not just
     the injected one. Since `"priority"` is pacer's default pacing policy, this silently regressed
     pace-aware ordering for every conversation-mode task with no project selection — the common
     case — contradicting this decision's own stated intent.
   - The shipped fix (`conversationFallback()` in `src/tasks/runner.ts`) calls `rankExecutors` with
     no selection override at all when there's no project policy (identical to a delegated task),
     then — only if the requested executor is missing from both the ranked and excluded results —
     ranks that one candidate alone (a lone selection trivially preserves order) and appends it as a
     last-resort fallback, never disturbing the real sort above it. Pinned by
     `test/runner.test.ts`'s "conversation ranking still honors pacing.policy priority ordering
     (EXPIRING promoted ahead of AHEAD)".

 UI/TUI audit for decision 4: the TUI session screen (`src/dashboard/screens/sessions.ts`) explicitly excluded conversations from the settled-task review detail and from getting a review verdict item; both exclusions are removed, since a settled conversation is now reviewable. The web app's session route (`app/src/screens/session/SessionRoute.tsx`) already passed the same `slots`/`data` (title banner, retry options, diff panel) to both the `<Conversation>` and `<Session>` branches, so no change was needed there — the review/retry UI was already mode-agnostic; only the data model previously made conversations ineligible.

## Project review follow-up (2026-10-29)

Independent project review of the first implementation found gaps that the decisions above did not settle. The fixes conform to the established rules; [ADR 0014](../decisions/0014-interactive-lanes.md) records the resulting lifecycle:

- **Ownership.** A kept-alive worker was released from admission and left unsupervised: `task.stop` did not stop it, and nothing expired it. The task now owns it through its backend (`TaskRecord.live`). It holds its executor slot, and stop, settlement, review, an answer on another executor and a four-hour idle limit release it.
- **No text into a shell.** Orca types `--text` into whatever runs in the terminal. Once the agent exits, that is the login shell. `pacer send` and live answers now type nothing unless the worker is unsettled and Orca's `terminal show` reports the lane's agent (`agentIdentity`) as the foreground process of the same terminal incarnation. Otherwise `send` fails as `unavailable` and an answer respawns.
- **Host-neutral `task.send`.** Delivery goes through an optional backend capability (`Backend.live`) instead of reading Orca state directly. A backend without it refuses with `unavailable`.
- **Contention.** The lease and revision checks run under the task lock. The lease identity is the caller's client label or CLI terminal, not the service's OS user, so two clients contend.
- **Rounds beyond the first.** The worker now moves to each answering attempt, so later answers and `pacer send` find it.
- **Only supervised lanes accept `pacer send`.** A lane waiting on its question has no runner watching its worker, so `send` refuses it as `conflict` and points at `pacer answer`, which delivers live and resumes supervision.
- **Scope of decision 4.** Routing and review apply to every conversation and are announced in the CHANGELOG. A `session.create` chat stays on the direct backend, because `session.io` cannot stream an Orca terminal. Only `--interactive` lanes use Orca.

## Non-goals (carried from the issue and from existing specs)

- Replacing `dispatch.child`'s scoped-grant model (API-5) for how a child task gets created; an interactive lane's own escalations still go through it.
- Changing the managed-delegation-enforcement guarantee (strict/cooperative) — an interactive lane is still a managed attempt and still needs a current enforcement certificate in strict mode.
- A new live-terminal streaming protocol for Orca. `pacer send` is write-only; it does not attempt to give Orca-backed tasks the same live output streaming the direct backend's PTY session has.
- Solving #451 (the shell-level enforcement gap) here; that issue's `PreToolUse` shell guard is a separate, smaller change this design does not depend on, though removing the planner's reason to go around pacer is this design's whole point.

## Validation

- Unit/integration: `test/orca-backend.test.ts` (group worktree creation and reuse, keep-alive on `needs_input`, reattach for both a `retryOf`-linked answer and a same-task-id managed answer), `test/send.test.ts` / `test/send-cli.test.ts` (delivery, contention/`--force`, timeline recording, executor-session refusal, validation), `test/core-tasks.test.ts` (`--interactive`/`--group` parsing and carry-through on retry), `test/runner.test.ts` (conversation now runs delegated acceptance and falls back on a limit).
- `bun run typecheck`, `bun run test`, `bun run ui:check`, `cargo xtask gen --check`, `cargo xtask loc --check`, `cargo xtask deps`, `cargo build --workspace`, `cargo test --workspace --locked` — results recorded in the PR description.
- CT-11 live validation: evidence summarized in the PR description. This needs a real Orca runtime and (for the backend/model choice) a configured strategy with `execution.backend: orca`; what could and could not be exercised in this environment is recorded there, not assumed.

Review follows REPO-10, plus API-1–5 (new `task.send` op, protocol/schema regenerated), ARCH-1/2/5/12 (session/dispatch/Orca-backend boundaries), SEC-1/5 (the `driving` lease is cooperative, not a security boundary, and is documented as such), CT-4/11.
