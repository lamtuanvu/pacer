# Workflow frame: pacer runs work from brief to pull request

Status: proposed, 2026-11-19, awaiting the maintainer's approval. Decision record: [ADR 0029](../decisions/0029-workflow-frame.md).

Governance: P1–P4, ARCH-1/2, ARCH-8, ARCH-9, ARCH-12, ARCH-16, API-5 (amendment API-5b proposed below), SEC-5, UI-1 to UI-28, CT-11, REPO-10.

## Intent

Today a person drives each feature by hand: they brief a planner session, brainstorm, write a spec, ask for reviews, write a plan, delegate tasks, chase executors, review, test and open the PR. pacer already runs and tracks the individual tasks. This design makes pacer run the whole lifecycle of a piece of work: it supervises every step, it lets several pieces of work run at once, and it brings to the person only what they must decide.

pacer owns the **frame**: a workflow engine, a declarative workflow format, an orchestrator role, structured questions, and the operations and events that clients draw. The steps a piece of work goes through are defined by a **workflow plugin**. pacer ships the first workflow plugin, and any plugin can replace it.

## Goals

- G1. A brief goes in, and pacer takes it to a finished result (for a code change, an open PR) through the steps its workflow defines.
- G2. Workflows are plugins in a declarative format. pacer contains no built-in knowledge of "feature", "bug fix", "simple ask" or any other workflow.
- G3. One graph engine runs both the predefined steps and the steps an agent generates while the work runs (for example, the execution plan).
- G4. Each run has an orchestrator agent that supervises it from start to finish and decides at its decision points.
- G5. Agents ask the person structured questions. The UI draws a form, and the answer goes back to the agent that asked.
- G6. Several runs share executors and budget under a priority the person sets.
- G7. Every decision, whether an agent's or the person's, is recorded with its reason and can be replayed in the UI.

## Scope: only work that pacer starts as a workflow

Everything in this design applies only to **runs**: work started with `run.start` (from the workflows page, the CLI or the TUI), and the tasks and work nodes that belong to a run. All other work keeps today's behaviour unchanged. That includes:

- tasks a planner delegates with `pacer delegate`, and work submitted with `pacer dispatch`;
- interactive lanes and conversations started outside a run;
- review, send-back, retry, liveness, messaging guardrails, grants, worktree placement, task ordering and the existing task, dispatch and needs-you screens.

How this is enforced:

- A task belongs to a run only if the engine created it. The marker is the link from the task to a step instance in the engine's own tables (`workflow_steps`), written only by the engine; task records themselves are not changed.
- Every new behaviour is gated on that marker: the engine's settlement handler, the run grant, the wider messaging default, structured-question routing to an orchestrator, merging into the run branch, run priority and pausing. A task without the marker never enters any of them.
- Run priorities map onto the existing numeric task priority, so ordering between run tasks and other tasks uses the existing rule. No new scheduling logic touches ordinary tasks.
- The structured question form is additive. An ordinary task can still use plain `ask`/`answer` exactly as today, and its questions go where they go today.
- Each implementation PR includes regression tests showing that ordinary delegated and dispatched tasks behave exactly as before.

## Non-goals

- A visual workflow editor. Workflow files are written by hand or by agents.
- Plugin code that runs inside the engine. The format is declarative only.
- Replacing the dispatcher's scheduling, executor choice, fallback or liveness.
- Mandating any development method. Superpowers, SpecKit and others are choices inside a workflow's steps, never in the frame.

## Anti-goals (failure even if it works)

- The frame hard-codes a workflow, a stage name or a triage category.
- A second task system or a second database next to the task store.
- The flow becomes opaque: a person cannot tell why a run took a branch.
- The person is interrupted more than they are today, or a question is missed and the work stalls silently.
- A workflow can loosen a decision that the person requires to stay theirs.

## Constraints

| Source | What it requires here |
| --- | --- |
| Constitution, "Workflow choice" | The frame must keep every workflow optional; pacer still works with no workflow. |
| P1, ARCH-1/2 | The service owns workflow state; clients are thin. Core operations come before any client. |
| ARCH-8 | Everything is reachable from the CLI and TUI. |
| ARCH-9 | This needs an ADR (frame, format, orchestrator role, message-default change). |
| ARCH-12 | Workflows are plugins. ARCH-12 keeps routing, strategy and the pacing engine in the host but does not name dispatch or a workflow engine; [ADR 0029](../decisions/0029-workflow-frame.md) argues why the engine stays in the host, for the maintainer to confirm. |
| ARCH-16 | All state lives in the existing SQLite store. |
| P2, ARCH-3 | Multi-client safe: mutations carry `expect_rev` and return `conflict`. |
| P3/P4 | No fixed planner agent; protocol changes are additive. |
| API-5 | Executors keep their narrow grants. The orchestrator's run grant is a new credential, so it needs a rule amendment, API-5b (see "Grant" below), approved by the maintainer. |
| [ADR 0002](../decisions/0002-actionable-attention.md) | The frame forces no approval step; a workflow chooses its own human steps. |
| [ADR 0006](../decisions/0006-intelligent-work-dispatcher.md), [dispatcher design](2026-10-24-intelligent-work-dispatcher-design.md) | Extend task and work-node ops; the dispatcher design's non-goal of opaque model-made dispatch decisions. |
| [ADR 0011](../decisions/0011-agent-messaging.md) | Messaging guardrails; this design changes their default for workflow participants (see Communication). |
| SEC-5 | Message and answer bodies travel only as argv or stdin. |
| CT-11, REPO-10 | Live validation and independent review before done. |

## Approaches considered

**Engine**

| Option | Trade-off | Verdict |
| --- | --- | --- |
| Temporal, Restate, Inngest | Durable and proven, but a separate server and store | Rejected: a second runtime and store (ARCH-16), and a heavier host (ARCH-12) |
| LangGraph (JS) | Closest feature set (checkpoints, interrupts, dynamic fan-out), but nodes are in-process code and it keeps its own checkpoints and retries | Rejected: duplicates task store and dispatcher |
| XState as the interpreter | Proven statechart semantics, but dynamic sub-graphs fit poorly, and the task glue is still ours | Kept as the reference for semantics, not used as a dependency |
| **Own small engine on the task store** | Durability, retries, fallback, capacity, liveness and human waits already exist in pacer; the engine only evaluates edges, joins and loop counts | **Chosen** |

**Workflow definition**

| Option | Trade-off | Verdict |
| --- | --- | --- |
| **Declarative file** (JSON or YAML) over fixed step types | Drawable before it runs, safe to load, easy to validate; new behaviour needs a new frame step type | **Chosen** |
| Code module with hooks | Flexible, but runs plugin code in the engine and the graph cannot always be drawn up front | Rejected |

**Who moves the run.** Chosen: the engine moves the run by fixed rules, and the orchestrator agent makes the judgment calls at decision points through engine operations. Rejected: an agent free to jump anywhere (opaque), and a fully mechanical engine (cannot judge reviews, write plans or answer executors).

## Design

### Concepts

- **Workflow definition**: a declarative graph from a plugin, identified as `<plugin>/<workflow>@<version>`.
- **Run**: one execution of a definition for one brief. A run has a priority, an auto-mode switch, an orchestrator and a status.
- **Step**: a node in the graph. When a step runs, it becomes one or more ordinary pacer tasks linked to the run, so everything that works on tasks today (CLI, TUI, attention, liveness, messages, logs) works on steps.
- **Step result**: structured JSON that a step returns when it finishes; edge conditions read it.
- **Child run**: a run started by a step (a chosen workflow, or a generated sub-workflow). It shares its root run's orchestrator.

### Step types (the frame's fixed vocabulary)

| Type | What it does |
| --- | --- |
| `agent` | Runs one task with a role (`orchestrator`, `reviewer`, or a work kind and difficulty) and a prompt template. Executors come from the dispatcher. |
| `human` | Waits for the person: a structured question, or an approval of an artifact. Marked `must` (always the person) or `auto` (the orchestrator may answer in auto mode). |
| `fanout` | Runs N branches in parallel (static list, or one per item in a previous result) and joins them with a rule: all, any, or a quorum. |
| `choose_workflow` | The orchestrator picks an installed workflow; the engine starts it as a child run. |
| `generate` | An agent writes a sub-workflow in this same format; the engine validates it and runs it as a child run after optional approval (`approval: must|auto`). |
| `end` | Finishes the run with a result. |

Edges carry an optional condition on the source step's result (a small expression language: equality, membership, numeric comparison, `and`/`or`). Back edges are allowed only when they declare `max_loops`.

### Workflow file sketch

```yaml
id: pacer-dev/feature
version: 1
inputs: { brief: string }
policy:
  replan: { auto: 1, then: ask }
steps:
  brainstorm:
    type: agent
    role: orchestrator
    prompt: prompts/brainstorm.md
    skills: [superpowers:brainstorming]   # a workflow detail, not a frame dependency
  approve_spec:
    type: human
    decision: must
    question: { kind: approve_revise, artifact: "{{brainstorm.result.spec}}" }
  review:
    type: fanout
    branches: [architecture, devils-advocate, ux, security]
    each: { type: agent, role: reviewer, prompt: prompts/review.md }
    join: all
  plan:
    type: generate
    role: orchestrator
    limits:
      step_types: [agent, fanout, human]
      max_steps: 30
      max_depth: 2
      kinds: [feature, tests, docs, refactor, debug, boilerplate]
      require_after: { "kind in [feature, refactor, debug]": reviewer }
      require_last: { kind: tests }
    approval: auto            # the graph is approved before it runs
  open_pr: { type: agent, role: orchestrator, prompt: prompts/open-pr.md }
  merge: { type: human, decision: must, question: { kind: approve_revise } }
  done: { type: end }
edges:
  - [brainstorm, approve_spec]
  - [approve_spec, review, "result.answer == 'approve'"]
  - [approve_spec, brainstorm, "result.answer == 'revise'", { max_loops: 3 }]
  - [review, plan, "result.verdict == 'pass'"]
  - [review, brainstorm, "result.verdict == 'revise'", { max_loops: 2 }]
  - [plan, open_pr, "result.status == 'done'"]   # other outcomes go to the re-plan policy
  - [open_pr, merge]
  - [merge, done, "result.answer == 'approve'"]
```

Field names are illustrative; the builder fixes the exact schema (see "Left to the builder").

### Engine

The engine is an event handler on task settlement plus a few tables. Its whole job:

1. Load and validate definitions (schema, reachable `end`, every back edge bounded, every referenced prompt present).
2. Start a run: create the run record, start its orchestrator, and start the entry step.
3. When a step's task settles, read its structured result, evaluate the outgoing edges, and start each target whose condition holds.
4. Join fan-outs by their rule.
5. Count loops and stop a back edge at `max_loops`, raising a decision instead.
6. Start child runs for `choose_workflow` and `generate`, and finish the parent step with the child's result.
7. Apply the run's policies (re-plan, auto mode).

From Phase 3 (generated plans), each step instance is a dispatcher work node under the run's root; Phase 1 starts steps as plain delegated tasks, because it has no dependencies to express. Either way, dispatcher limits, dependency waits, capacity, executor choice, fallback and liveness apply unchanged. The engine owns the graph's shape; the dispatcher owns who runs each task and when. A generated plan's dependencies become dispatcher dependency edges.

**Returning a step result.** An agent reports its result through a new operation, `step.result` (CLI `pacer step result`, and an MCP tool), with a JSON body. The engine validates it at once against the schema the workflow declares and returns the errors to the caller, so the agent can fix it in the same turn. A task that settles without a valid result is failed with the validation error, and the orchestrator decides (retry with the error, send back, or escalate). Results are not parsed out of the free-text report.

**Human steps** are run-level records, not tasks: nothing runs while one waits. The engine creates a question for it (below) and the step finishes when the question is answered, by the person, or by the orchestrator when auto mode allows.

**One repository per run.** `run.start` takes a repo (the CLI defaults to the current one). A run is one dispatcher subtree in that repo. Work across several repos is a non-goal for this version.

#### How the engine stays correct (as built in Phase 1)

The engine is not an in-process subscriber. A background-worker loop (`workflow`, every second) walks the shared `task_changes` log from a durable cursor (`workflow_cursor`). Each tick does four things in order, and no single run can stop the tick for the others:

1. **Orphan rows.** A step row is written *before* its task is delegated (status `running`, no task id), and the delegation uses the stable request id `wf:<run>:<step>:<attempt>:<branch>`. A crash between the two leaves an orphan row. Every tick attaches the task that this request id already reserved, or delegates again under the same request id once the row is older than 60 seconds.
2. **Re-advance.** `workflow_steps.advanced_at` records when a done step's outgoing edges were processed. A done row with no `advanced_at`, older than 5 seconds, in a live run, has its edges replayed. Upgrading a database that predates the column backfills finished rows as already advanced, so history is never replayed.
3. **The change log.** Every terminal change (`done`, `failed`, `stopped`, `limit`) of a task that has a step row settles that step. The cursor only moves past fully handled changes. A gap in the log (pruned past retention, or a restored database) triggers a full rescan of running steps.
4. **Lost settlements.** In live runs only: a failed step row without `advanced_at` (its run failure never landed) fails the run; a fan-out whose branches are all settled but which has no join row is joined; a running step row whose task is already terminal is settled.

Exactly-once rules:

- **Settlement is claimed by compare-and-set.** A step settles only by a write that requires its status to still be `running`, so of two settlers (the request thread and the tick) exactly one advances the run. A human step's answer is the same compare-and-set on `waiting`, and the loser gets `conflict`.
- **An edge fires once.** Each successor row records its `trigger`, `<run>/<step>#<attempt>/<branch>@<edgeIndex>`, under a unique index; extra fan-out branch rows carry the trigger suffixed with `/<branch>`. Firing an edge is one immediate transaction: if the trigger exists, the edge was already handled; otherwise the back-edge loop counter is incremented and the successor rows are inserted together. Delegation happens after that transaction, so a crash in between is an ordinary orphan (rule 1).
- **Loop counts do not use `expect_rev`.** The increment is read and written inside the immediate transaction and bumps the run's `rev`, so a client holding an older rev gets `conflict` and rereads, but a loop update never fails a healthy run over a rev the request thread changed.
- **An `end` edge waits.** A run does not end while a fan-out is unresolved or a sibling step is still busy; the deferred end lands on the tick that finds them gone.

Errors: SQLite lock errors (`SQLITE_BUSY` and its relatives) are transient. They are retried on later ticks, at most five times per change and five times per orphan or re-advance row, counted in memory. After that, and for any other error, the error is deterministic: the affected run fails with a reason beginning `engine error`, `re-delegate failed` or `re-advance failed`, and the tick moves on. The retry counts live in memory, so a service restart gives a stuck row another five tries.

Data from agents is bounded and fenced:

- A step result is at most 64 KiB, measured in UTF-8 bytes; a larger one is refused with `invalid_input` at `step.result`.
- A workflow file is at most 256 KiB.
- In prompts, the brief and every substituted step result sit inside data markers, `--- data <nonce> <label> ---` and `--- end data <nonce> ---`. The nonce is fresh for each rendered prompt, and a one-line preamble names it, so text inside a result cannot close the block it sits in. Each substitution is capped at 16 KiB.

Phase 1 also settles a step only on `done`, `failed`, `stopped` and `limit`. `partial` and `needs_input` wait for the orchestrator (Phase 2) and structured questions (Phase 4).

### Generated sub-workflows

A `generate` step asks an agent (normally the orchestrator) for a sub-workflow in the same format, constrained by the step's `limits`. The engine validates it. On failure the agent gets the errors and retries, up to the step's retry limit. A valid graph is stored as a versioned record linked to the step.

**Approval before it runs.** A `generate` step may set `approval: must` or `approval: auto`. The engine then raises a human question carrying the graph, and starts the child run only after approval; "revise" sends the person's note back to the agent, which regenerates. With `auto`, the orchestrator may approve in auto mode, as for any `auto` step. Without `approval`, the child run starts as soon as the graph is valid. The `generate` step finishes when its child run finishes, and its result is the child run's result. In the sketch, the generated plan's `require_last` makes the tests the plan's final step, before `open_pr`.

Rules: no cycles except bounded retry edges that the limits allow; nesting depth defaults to 2; `require_after` and `require_last` are enforced by the validator, not by prompt.

**From plain tasks to work nodes (Phase 3 upgrade).** Phase 1 starts every step as a plain delegated task. Phase 3 gives each run an engine-owned root work node, with step tasks as its dispatcher children. Runs that are still live when a service with Phase 3 starts must not be half converted. So:

- `workflow_runs` gains `step_mode TEXT NOT NULL DEFAULT 'plain'`. Runs created by Phase 3 and later get `work_node`, plus `root_task_id`, the id of their root work node.
- A run keeps the step mode it started with, for its whole life: a `plain` run starts its remaining steps as plain tasks, and a `work_node` run starts them as children of its root. The tick settles both kinds the same way, because both reach the engine through `task_changes` and a step row.
- A `plain` run cannot reach a `generate` step: such a definition needs Phase 3 to validate at all, and a run is pinned to the definition version it started with.
- The upgrade itself needs no data migration beyond the new column. Running step tasks survive a service upgrade through the existing [running-work handover](2026-10-29-service-upgrade-with-running-work-design.md), and the tick resumes from its cursor.
- The plain path stays while any `plain` run is live. A later release may remove it once a start-up check finds none. Whether it should instead fail leftover plain runs with a "restart this run" reason is listed under "Decisions needed".

**Re-planning.** When a task in a generated plan still fails after dispatcher fallback, the run's `replan` policy applies. Options per workflow: `auto: N, then: ask` or `ask`. On re-plan the orchestrator writes a new version covering the unfinished steps; finished steps are kept; the person sees a summary of what changed. The first workflow uses `auto: 1, then: ask`.

### Orchestrator

One orchestrator per root run. pacer launches it with the configured planner agent (any agent in `PLANNERS`; P3) and keeps one native session for the run's life, so its context stays on one piece of work. Role detection (`isExecutorSession`) gains this third role.

**Lifetime: event-driven turns, not a long-lived process.** A run can wait days on a `must` step, so the orchestrator does not stay `running`. It settles between events and the engine resumes its session for one turn per event: a step settled, a step result was invalid, a question was escalated to it, a re-plan is due, the person sent it a message, or the person returned to the run (for the "since you last looked" summary). Each wake-up is a metered turn and is billed like any other. A paused or background run simply raises no wake-ups. Because the orchestrator is not `running` between turns, step tasks are not its dispatcher children: from Phase 3 each run has a root work node owned by the engine, and step tasks are children of that node (Phase 1 and Phase 2 start steps as plain tasks; see "From plain tasks to work nodes").

**Steps with `role: orchestrator` are turns in its session**, not new tasks. The step instance records the turn id, and a retry is another turn. A step may set `interactive: true` (brainstorming does), and then that turn runs in the orchestrator's interactive lane, so the person sees and can type in its terminal. Otherwise the turn is headless. This is an exception to [ADR 0011](../decisions/0011-agent-messaging.md) decision 6 (managed roots default to headless launches), limited to orchestrator turns of steps marked interactive.

It acts only through engine and task operations, each recorded with a reason:

- decide at decision points: produce the results that edge conditions read, choose a workflow, give a review verdict;
- write and rewrite generated plans;
- supervise: read its run's events, answer executor questions it can answer, escalate the rest;
- intervene: send back with a note, retry on another executor, skip, stop, re-plan.

The person talks to a run through its orchestrator (for example, brainstorming happens in its session) and can still open any executor's session directly.

**Grant.** A new run grant, scoped to one root run, allows: review, send-back, retry, stop, skip, escalate, submit a sub-workflow, choose a workflow, report step results, attach step artifacts, answer questions, and, from Phase 5, update the run branch from base (`run.sync_base`) and publish it (`run.publish`), all inside that run. Budget, priority, auto mode and planner changes stay with the person. Executors keep their existing grants, with one addition: an executor whose task has a step row may call `step.artifact` for its own step, gated by task identity exactly like `step.result`.

This is a new credential, so it needs a rule amendment, proposed here as **API-5b**, modelled on API-5a:

- a `prg_` bearer (`prg_` + 64 lowercase hex), bound to exactly one root run id and one orchestrator turn (turn id and the turn's deadline), stored SHA-256-hashed in the existing grant store under its own `kind`;
- issued when an orchestrator turn starts, it expires at that turn's deadline and is revoked when the turn settles or the run ends or is stopped;
- it authorizes only the operations listed above, and only on tasks, steps and questions of its own run. `authorizeWorkOperation` answers for it first and refuses everything else;
- an unknown, expired or revoked `prg_` fails closed (403 at the HTTP gate, `not_allowed` from the core) and is never treated as an executor or the operator.

Because a fresh grant is issued for every turn, the grant is not tied to a task being `running` or to a task timeout, which is what lets a run wait days for the person.

#### Wake-ups and turns are durable

A wake-up is a row, not an in-memory event. `workflow_wakeups` holds `(run_id, cause, ref, created_at, turn_id, done_at)`, with a unique key on `(run_id, cause, ref)`. The engine writes it in the same transaction as its cause: a settled step that needs a decision, an invalid result, an escalated question, a re-plan, a message to the orchestrator, or the person returning to the run.

Only decision points wake the orchestrator. A step whose outgoing edges the engine can evaluate by itself advances without a turn. That keeps the turn count close to the number of real decisions (see "Cost control").

A turn is a row in `workflow_turns`: `(id, run_id, planner, session_id, status, started_at, deadline, error)`. Starting a turn claims every open wake-up of the run, so wake-ups that arrive close together share one turn. When the turn settles, its wake-ups are marked done. Each turn runs as a resume of the run's native planner session, launched through the same runner path as any task attempt, so it is metered against the planner's account and pacing sees it.

#### When a turn goes wrong (Phase 2)

| What happens | What the engine does | What the run shows |
| --- | --- | --- |
| The turn fails (non-zero exit, crash, settles without acting on its wake-ups) | Releases the turn's wake-ups and revokes its `prg_` grant. It retries after 1, 5 and 15 minutes. After three consecutive failed turns it stops retrying and raises an attention item with three actions: retry now, switch planner, stop the run. | `planner failed 2×, retrying at 14:05`, then `waiting on you: planner failed 3×` |
| The planner's account is at its limit, or pacing makes it ineligible | Does not retry in a loop. The wake-ups stay open, and the engine starts a turn again when pacing reports the planner eligible, checking on each tick and at the reset time the usage broker estimates. This does not count toward the three failures. | `planner at limit until 18:00` |
| The turn passes its deadline (default 20 minutes for a headless turn; an interactive turn ends after 2 hours without input) | Stops the turn through the `task.stop` path, revokes its grant and releases its wake-ups. This counts as a failed turn. Operations the turn completed before the deadline stand: each was recorded on its own, with `expect_rev`. | as for a failed turn |
| The service restarts during a turn | At start-up, `prg_` grants of turns that no live process owns are revoked, and those turns are failed and their wake-ups released. Liveness covers the runner itself. | as for a failed turn |
| A wake-up is lost (a bug, or a write that never landed) | Each tick runs a "needs the orchestrator" check: a live run with an open decision (a step settled with a failure or an invalid result, an escalated question with no answer, a re-plan due), no open wake-up and no live turn gets the wake-up recreated under the same unique key. | nothing; the run continues |

While the orchestrator is unavailable, executor steps keep running and the engine keeps advancing mechanical edges. Only decisions wait. The run entity carries an `orchestrator` block, `{ state: idle | turn | retrying | blocked, planner, reason?, next_wake_at? }`, which the Runs page, the Live board and the TUI show.

#### Switching the planner during a run

A run keeps the planner it started with. Changing the global planner affects new runs only. `run.set_planner { id, planner, expect_rev }` switches one run, and it takes effect at the next turn boundary, never during a turn.

Native sessions cannot move between agents, so the new planner starts a new session. Its first turn gets a handover prompt built from durable state: the brief, the definition, step results, the decisions with their reasons, open questions and the latest "since you last looked" summary. The handover is capped at 32 KiB and the data in it is fenced with data markers. The switch is recorded as a decision. Whether the engine may switch planners by itself when the planner is exhausted is listed under "Decisions needed".

### Auto mode

Each run has an auto-mode switch (off by default). Every `human` step is marked `must` or `auto` by its workflow. With auto mode on, the orchestrator answers `auto` steps itself and reports what it chose; with it off, every human step goes to the person. The person can make any step stricter (globally or per run) and never looser: a `must` step can never be answered by the orchestrator. The first workflow keeps brainstorm sign-off, spec approval and merge as `must`, and leaves routing, plan approval and review verdicts as `auto`.

### Structured questions

Agents ask through a pacer tool, available as CLI and MCP, built on the existing `ask`/`answer` (`needs_input`).

A question carries: text; answer type (`single`, `multi`, `text`, `yes_no`, `approve_revise`); options, each with an optional trade-off note; a recommended option; what it blocks (`step`, `branch`, `nothing`); and an optional artifact reference. When it blocks nothing, the agent keeps working.

Storage: questions get their own table, `workflow_questions`, holding the asker, the current answerer, the escalation chain and the answer, so one thread stays one record. Only a question that blocks `step` or `branch` puts the asking task in `needs_input`. A question that blocks `nothing` leaves the task's state alone and shows in the attention queue as informational.

Routing: an executor's question goes first to its run's orchestrator. The orchestrator answers it, or escalates it to the person with its own suggested answer attached; the person's answer goes back to the asking agent unchanged. A new `escalate` operation keeps the original question linked so the thread stays one record.

The frame supplies the standard instruction text that tells agents to use the tool, and workflows include it in their prompts.

**Fallback.** The liveness check also scans terminal output for prompt-like lines (y/n prompts, numbered choices, "which option"). A match marks the task "may be waiting on you" with the raw text and two actions: answer in the terminal, or convert to a structured question. It never answers on its own.

### Communication between agents

Agents use the existing lanes: `pacer msg send` to `task:<id>` (a metered resume turn; delivered live to interactive sessions, read mid-run by dispatcher-managed work, otherwise delivered when the current turn settles), `review --send-back`, `review --retry-on`, `stop`, and the task event stream.

Rule: **agents talk and read freely; only the owning orchestrator acts on a task.**

- Any workflow participant may message any other agent, in its own run or another, and may read other tasks' logs, results and artifacts and other runs' state.
- Only the root run's orchestrator (or the person) may change that run's work. To affect another run, an orchestrator messages that run's orchestrator.
- This widens [ADR 0011](../decisions/0011-agent-messaging.md)'s default guardrail for workflow participants. Today's default (decision 2) lets top-level sessions message their direct children and other top-level sessions; lets children message their parent and, with a work grant, their siblings and their own children; lets anyone message the human; and lets the human message anyone. The wider route includes messages to another run's executors. The maintainer chose this behaviour in the design discussion; the ADR 0011 amendment that records it still needs the maintainer's approval. ADR 0011's existing rate and cap guardrails still apply to every route, and they are what bounds the cost of message turns between runs. The guardrails stay configurable, so the person can tighten them; the frame adds no restrictions of its own.

### Several runs at once

Each run has a priority: `urgent`, `normal` (default) or `background`.

- The dispatcher fills free executors by priority, then by the existing order.
- Under strict or emergency pacing, `background` runs pause at their next step boundary and their orchestrators go idle until the budget recovers; under emergency, `normal` runs pause too (see the table under "Cost control"). Paused runs show why.
- The attention queue ranks by what an answer unblocks (stops the run, stops a branch, informational), then by run priority, then by age. Items carry their run's identity so clients can group and colour them.
- Each run keeps a "since you last looked" summary that its orchestrator writes when the person returns to it.

#### Cost control

Orchestrator turns and message turns between runs are spent on the planner's subscription, so each run has a budget, and pacing modes tighten it.

- **Per-run budget.** A run has `budget: { orchestrator_turns, message_turns }`. A workflow sets its defaults in `policy.budget`, `run.start` may override them, and `run.set_budget` changes them during the run (with `expect_rev`). Proposed defaults are 60 orchestrator turns and 20 message turns per root run; child runs share their root's budget.
- **What counts.** Each orchestrator turn counts 1, whatever woke it. A message from a run participant that causes a metered resume turn in *another* run's agent counts 1 against the sender's run. Messages inside a run, and turns the person starts by typing in an interactive lane, do not count.
- **Spending less.** Only decision points wake the orchestrator (see "Wake-ups and turns are durable"). Wake-ups that arrive within 30 seconds of each other share one turn, except those the person causes, which start a turn at once. A "since you last looked" summary is written at most once per return, and only when something changed. A message to an executor in another run is queued for that executor's next turn, rather than forcing a resume, unless the executor is idle.
- **At the limit.** At 80% of either budget the run shows an informational attention item. At 100% the run pauses at its next step boundary with the reason `turn budget spent`. The person can raise the budget or stop the run. Answering a `must` step never needs budget.

How pacing modes apply:

| Mode | Orchestrator wake-ups | Runs |
| --- | --- | --- |
| relaxed, normal | as above | as above |
| strict | `urgent` runs as above; for `normal` runs, wake-ups the person did not cause wait in a 10-minute window and share a turn | `background` runs pause at their next step boundary (already in this design) |
| emergency | only wake-ups the person causes, and those of `urgent` runs | `normal` and `background` runs pause at their next step boundary |

A paused run resumes when the mode loosens. The run shows which rule paused it. The strict-mode window and the emergency pause of `normal` runs are proposals, decided together with the urgent-run rule in D4.

### Run branch: how parallel code comes together

The frame gives every run that changes code a **run branch**, created from the repo's base branch when the run starts (for example `pacer/run-<id>`). The maintainer chose a frame-provided run branch over leaving integration to each workflow; the details below (naming, merge timing, conflict handling) are design calls listed under "Calls made".

- **Starting a task.** A code task's worktree branches from the run branch at its current tip. Because a dependency counts as satisfied only once it is accepted, and accepting merges it (below), a dependent task always starts with the code of everything it depends on.
- **Accepting a task.** When a code task is accepted (by the orchestrator or the person), the engine merges its branch into the run branch. Merges into one run branch are serialized.
- **Conflicts.** If the merge conflicts, the run branch is left untouched and the engine creates a conflict-resolution task for the orchestrator. That task has both branches and the conflicting files, may delegate the fix, and finishes when its result merges cleanly. Tasks that depend on the conflicting one wait.
- **Base moves on.** Updating the run branch from the base branch is a step a workflow can include (for example before opening the PR). It uses the same conflict path.
- **Pull request.** A PR is opened from the run branch. The frame exposes the run branch name and the base branch to steps, so a workflow's PR step needs no knowledge of task worktrees.
- Runs that change no code (for example a question answered by exploring) never create a run branch.

#### Run branch beyond the happy path (Phase 5)

**Creation.** The branch, `pacer/run-<10 base32 characters of the run id>`, is created lazily when the first code step starts, from the base branch's tip. `workflow_runs` records `branch`, `base_ref` and `base_sha`. All merges happen in one integration worktree per run, under the task worktrees directory, owned by the engine and never by an agent. Merges into one run branch are serialized by a per-run lock.

**Accepting a run task merges, then accepts.** Today `pacer review --accept` records the verdict, and cleanup then removes the reviewed task's worktree; local branches stay. For a task with a step row in a run that has a branch, the `review` op with verdict `accept` does this instead:

1. It refuses with `invalid_input` ("uncommitted changes in the task worktree") if the task's worktree has uncommitted changes, so the orchestrator sends the task back to commit them.
2. It merges the task's *branch* (not its worktree) into the run branch in the integration worktree.
3. Only after a clean merge does it record the accept. Worktree cleanup then works exactly as it does today, because the merge no longer needs the worktree.
4. On a conflict it records no verdict. It aborts the merge, leaves the run branch untouched, creates the conflict-resolution task described above, and returns normally with `{ accepted: false, merge: "conflict", resolution_task: <id> }`. It does not use the `conflict` error code, which means a stale rev, so clients never mistake a merge conflict for "reread and retry". The task stays reviewable, and its dependents keep waiting.

Ordinary tasks' accept is unchanged.

**Rejected and sent-back work.** A rejected task is never merged. Its branch is kept, like any task branch today. A send-back keeps its worktree, as today. If the run branch has moved meanwhile, the next accept's merge shows any conflict; the engine never rebases a task branch by itself. A retry on another executor starts a new worktree from the run branch's current tip.

**Stopping a run that has merged work.** `run.stop` stops the run's running step tasks and leaves the run branch, and everything already merged into it, untouched. It never resets, deletes or pushes anything. The stopped run shows its branch and how many commits it is ahead of base. From there the person can keep the branch (the default), publish it (below), or delete it with `run.cleanup`.

**Clean-up.** When a run reaches a terminal state:

- its integration worktree is removed;
- its task worktrees follow the existing clean-up rules;
- task branches that are fully merged into the run branch are deleted with the safe `git branch -d`, and unmerged ones stay for the existing task clean-up to list;
- the run branch is kept until the person runs `run.cleanup { id, delete_branch: true, expect_rev }`, which deletes the local branch only, and only after confirmation in the client.

pacer never deletes a remote branch.

**Base moves on.** `run.sync_base { id, expect_rev }` merges the base branch's current tip into the run branch in the integration worktree, with the same conflict path. A workflow calls it from a step before publishing.

**Publishing: the PR step's identity and credentials.** `run.publish { id, draft, title, body, expect_rev }` pushes the run branch to the repo's `origin` and opens the PR with `gh pr create --head <run branch>`. The engine runs both in the integration worktree, under the service user's own git and `gh` configuration, so the author and the pusher are the person. pacer stores no forge token and never asks for one. A workflow's PR step is a `role: orchestrator` step: it writes the title and body and then calls `run.publish` under its `prg_` grant. Executors cannot publish. The title and body are agent-written text, so they reach `gh` only as `--title <arg>` and `--body-file -` on stdin (SEC-5), never through a shell. The PR URL is stored on the run and returned in the step result.

Publishing is outward-facing, so `run.publish` checks a gate itself; holding the grant is not enough. It runs only when one of these holds:

- **An approval step.** A `human` step may declare `approves: publish`. The validator requires such a step to be `decision: must`, and the engine records its approving answer as a `publish_approved` decision on the run. `run.publish` requires that decision, newer than the run branch's last change, so a later merge needs a new approval.
- **A draft opt-in.** The person passed `publish: draft` to `run.start`, which allows draft PRs only.

A workflow cannot loosen this. The PR step therefore comes *after* its approval step. The workflow sketch above shows the older order, with `open_pr` before `merge`; the first plugin uses approve, then publish. The default is listed under "Decisions needed".

**Merge commits** are made with `git merge --no-ff`. When the repository requires sign-off (as pacer does), a repository setting adds `--signoff`, so merge commits carry the person's sign-off. Squash-merging the PR upstream is the repository's own choice.

### Persistence

New tables in the existing task store: `workflow_defs` (installed definitions and versions), `workflow_runs` (with the run's loop counts), `workflow_steps` (step instance to task or work-node mapping, result, `trigger`, `advanced_at`), `workflow_cursor` (the change-log cursor), `workflow_graphs` (generated sub-workflow versions with their producing step), and `workflow_decisions` (who decided what, at which step, why). Later phases add `workflow_questions` (Phase 4) and `workflow_wakeups` and `workflow_turns` (Phase 2). Step tasks are ordinary tasks and work nodes.

Writes that clients and agents make to a run (`run.answer`, `run.stop`, and the later `run.*` setters) carry `expect_rev` and fail with `conflict` on a stale rev. The engine's own writes are serialized differently, as described under "How the engine stays correct": compare-and-set on a step row's status, the unique `trigger` index, and immediate transactions. Loop-count increments bump `rev` without checking it.

### Operations, events and clients

Core operations (additive, `/v3/ops`): `workflow.list`, `workflow.validate`, `workflow.add`, `run.start` (repo, brief, workflow or `auto`, title, priority, auto mode, budget override, `publish: draft`), `run.answer`, `step.result`, `step.artifact`, `run.get`, `run.list`, `run.pause`, `run.resume`, `run.stop`, `run.set_priority`, `run.set_auto`, `run.decide`, `run.submit_graph`, `step.retry`, `step.skip`, `question.ask`, `question.answer`, `question.escalate`. Events: run, step, decision and question entities on the existing SSE stream.

Phase 1 shipped `workflow.validate`, `workflow.add`, `workflow.list`, `run.start`, `run.get`, `run.list`, `run.answer`, `run.stop` and `step.result`, all `/v3`-only. `workflow.add` installs a definition by hand until plugins supply them (Phase 7). `run.answer` answers a human step by its step id. From Phase 4 it remains as a thin form of `question.answer` for the question that step raised. Later phases add `run.set_planner` and `run.set_budget` (Phase 2); `run.sync_base`, `run.publish`, `run.cleanup` and `step.artifact` (Phase 5); and the `workflow.definitions` plugin call (Phase 7).

CLI: `pacer run start|list|show|pause|resume|stop|priority|auto`, `pacer workflow list|validate`, and `pacer ask`/`pacer answer` gaining the structured form. TUI: a run list, and a run view with the step graph as an indented tree, decisions and questions (design below). Web and desktop: see "User interface" below; they are clients of these operations and come after the core.

#### Rust side: what the read model needs

The workflow ops are TS-forwarded: the Rust front door passes them to the TypeScript core, and each has a row in the M2 ledger. Phase 1 already mirrors the `/v3`-only rule in Rust: the `run` entity events are dropped from v2 events and v2 replay, and `V3_ONLY_OPS` is mirrored in `crates/read-model/src/v2_compat/surface.rs`. What the app reads from Rust beyond that:

| Need | Phase | Rust change |
| --- | --- | --- |
| New entity kinds `step`, `decision`, `question` (and the `orchestrator` block inside `run`) | 2–4 | Add each kind to the `/v3`-only list in `crates/read-model/src/events.rs` and to the v2 drop list in `v2_compat.rs`, with tests in the pattern of `run_entity_events_are_v3_only`. |
| Runs in the snapshot, so clients draw the Runs page and its badge without one call per run | 6 | `/v3/snapshot` gains `runs`: live runs only, with id, title, workflow, status, priority, what each waits on, step counts by status, and the `orchestrator` block. `crates/read-model/src/snapshot.rs` reads `workflow_runs`, `workflow_steps` and `workflow_questions` read-only from the task store. Missing tables (an older database) read as an empty list. |
| Run questions in the attention queue | 4 | `crates/read-model/src/attention.rs` adds items for open `workflow_questions` and for the orchestrator's "failed 3×" state. Each item carries the run's identity and rank, and its JSON is byte-identical to the TypeScript item. A parity test runs both over the same fixture database. These items are `/v3`-only. |
| Generated types | 2 | The run, step, question and workflow op types move from `crates/client-protocol` into a new area crate, `crates/workflow-protocol`, under CRATE-3, before more ops are added. Every new op also goes into `op_catalog.json`, `stdio_hello.json` and the M2 ledger. |

`run.get`, run history and the decision log stay TS-forwarded until a native cutover of the workflow area, which is not part of this design.

#### TUI (Phase 8)

The dashboard gains a **Runs** screen in the existing tab cycle, after Sessions, reached with Tab or with the next free number key (`6`). `R` keeps its current meaning, refresh. The keys below apply only on the Runs screen and in its run view.

- **Run list.** Open run questions sit at the top, ranked like the attention queue. Below them is one line per run: its fixed letter (the same letter the app uses), title, workflow, status, what it waits on, priority and age. Background runs are dimmed, and paused runs show why.
- **Run view.** Enter opens a run as an indented tree of the engine's graph. A step line reads, for example, `● review  running  3/4  2m`. Fan-out branches are children of their step, and a generated plan is a subtree under its `generate` step. A `?` marker shows a step that waits on the person, and the orchestrator's block (`planner at limit until 18:00`) is the first line. A details pane shows the selected step's result summary, its decisions with their reasons, and its questions.
- **Keys.** Enter on a step opens its task in the existing task detail (log, attach). `a` answers the selected question with the same form the app uses: a list for `single` and `multi`, `y`/`n` for `yes_no`, approve or revise with a note line for `approve_revise`, and an input line for `text`. `p` pauses or resumes, `s` stops (after a confirmation), `P` cycles the priority, `A` toggles auto mode, and `m` messages the orchestrator.
- **Rendering.** Updates come from the SSE stream. Status labels come from `src/view-model/`, shared with the app, so both say the same words. The view is laid out for 120 by 40 and wraps the details pane under the tree on narrow terminals. The TUI has no Live board; the tree is its graph.

Phase 8 is validated with `bun run live tui`.

### User interface

**A dedicated page.** Runs get their own page, named **Runs**, in the web and desktop app, separate from the existing task screens, which stay unchanged. The page lists runs (status, priority, what each waits on, with the attention queue for runs at the top). Opening a run shows its run view, and from there the person can switch to the **Live board**, the graphical view of the run (board 6 below; the mockups called it "World view" before it was renamed). Ordinary tasks never appear on this page, and runs' step tasks are not mixed into the existing task lists.

The UI for this feature is already designed as an interactive mockup canvas (eight boards). The canvas is the visual spec for the web and desktop clients. It is the maintainer's working document, kept outside git (the maintainer's local copy is under `.work/design/feature-workflow-canvas/`, with a locked snapshot of the single-task version under `.work/design/snapshots/`), so reviewers of this repository cannot see it. The UI phase should export the boards it builds from as images under `docs/specs/images/`. This section maps each board to the frame, so a builder knows which operations and events feed it.

| Board | What it shows | Backed by |
| --- | --- | --- |
| 1 · Feature overview | One run: a strip of its steps with the ones that wait on you marked, and a conversation rail | `run.get`, step and decision events, questions |
| 2 · Brainstorm with you | The interactive brainstorm with the orchestrator, questions drawn as forms, and the spec forming alongside | the orchestrator's interactive turn, `question.ask` / `question.answer`, the step's artifact |
| 3 · Spec review by the agent team | A reviewer panel in parallel, findings per reviewer, and the verdict | a `fanout` step of `reviewer` agents, its join result, `run.decide` |
| 4 · Parallel execution | Plan waves running on several executors, with blocked items | the generated child run, dispatcher work nodes and dependencies, liveness |
| 5 · Tests and pull request | Unit, end-to-end and agent-driven test results, then the PR | test steps' results, the run branch, the PR step |
| 6 · Live board | The run as a pannable, zoomable graph: steps as desks, fan-outs as parallel lanes, agents as generated creature mascots; clicking an agent opens its live output; message bar with party, whisper and planner channels | the run's step graph, task logs and sessions (`/v3/tasks/<id>/log`, `/session`), `pacer msg send` |
| 7 · Full journey, playable | A brief taken end to end: the router picks the workflow, the planner builds the execution graph while it plans (construction zones fill in), executors arrive at desks and leave when done; new executors get a generated mascot | `choose_workflow` and `generate` steps, versioned generated graphs, executor assignment from the dispatcher |
| 8 · Several tasks at once | One attention queue ranked by what each answer unblocks, runs as coloured lines with fixed letters, focus mode, "since you last looked", quiet mode, and the shared executor bench | run priority, the attention ranking above, the orchestrator's summary, dispatcher capacity |

Rules the mockups follow that the implementation keeps:

- The graph drawn is the engine's graph: predefined steps, plus generated steps once their `generate` step has produced them. The UI never invents structure.
- Each running agent has exactly one place on the graph; parallel branches are separate lanes.
- Mascots are generated deterministically from the executor's identity (a seeded pixel creature), so a new executor gets a stable look with no assets. The person is the only human figure; the orchestrator is marked as the planner.
- Every question has the same form wherever it appears (queue, run view, Live board), drawn from the structured question.
- Messages from the UI go through the same lanes as agents use (party = the run's orchestrator and its agents, whisper = one agent, planner = the orchestrator only).

The mockups use sample data and are not visually verified against the design system. UI work follows UI-1 to UI-28 and needs its UI and QA reports before merge.

Choosing a workflow: `run.start` takes a workflow id, or `auto`. `auto` runs the configured router workflow first, which uses a `choose_workflow` step. The first plugin ships a router that reads the brief and picks from whatever is installed.

### The first plugin

Workflow plugins install through the existing plugin system: installed plugins ask the person to consent once, and bundled plugins are trusted ([plugin system design](2026-10-19-plugin-system-design.md)). So the bundled `pacer-dev` needs no prompt, and a third-party workflow asks once when it is installed. A workflow's prompts can steer how the orchestrator answers `auto` steps, but never `must` steps, so installing a workflow cannot take a decision away from the person. `pacer-dev` is a bundled plugin, not code in the engine, so it can be disabled or replaced like any other.

`pacer-dev` ships the router and one software workflow following the sketch above: brainstorm with the person, spec, a parallel reviewer panel, generated plan, parallel execution with review after each code task, tests (unit, end-to-end, agent-driven), and PR. Which skills its prompts use is a detail of this plugin.

#### How plugins ship workflows (Phase 7)

Workflows use the existing plugin protocol ([plugin system design](2026-10-19-plugin-system-design.md), [protocol reference](../plugin-protocol.md)). Nothing in the format changes, and no plugin code runs in the engine.

- **Manifest.** A plugin declares `contributes.workflow: { "<name>": { "title"?: string } }`. The workflow's id is `<plugin id>/<name>`, and the host refuses an id that does not start with the plugin's own id.
- **One host-to-plugin call.** `workflow.definitions()` returns `{ workflows: [{ name, version, source, prompts: { "<path>": "<text>" } }] }`. It is pure data, so the plugin needs no capability grant to serve it. The transport carries one JSON object per line with a 1 MiB cap, so the call is paged: `workflow.definitions({ after? })` returns at most one workflow per reply, with its prompts, plus `next` when more remain. The caps are 256 KiB per source and 64 KiB per prompt, and a reply must stay under 960 KiB; a larger workflow is a plugin diagnostic. The host's deadline is 10 seconds per page. The call works the same over every transport and from the TypeScript and Rust SDKs, and bundled plugins embed their files at build time.
- **When the host calls it.** At plugin enable, upgrade and start-up. The host validates every workflow, including that each `prompt:` path is in the reply's `prompts`. It stores valid ones in `workflow_defs`, with a new `origin` column (`plugin:<id>@<version>`), and the prompts with them. A version that already exists with the same source is a no-op, as `workflow.add` is today. Invalid workflows are reported as plugin diagnostics and never stored.
- **Disable and uninstall.** These mark the plugin's definitions `disabled`, so new runs cannot use them. Nothing is deleted: running runs are pinned to their version and finish on it.
- **Protocol version.** This is an additive minor change to the plugin protocol (1.11.0 to 1.12.0). A manifest with `contributes.workflow` sets `host` to `>=1.12.0`, and `bun run plugin:protocol` regenerates the reference.
- **Consent.** Bundled plugins are trusted. An installed plugin's one-time consent lists its workflows and says what they can do: start agents in the person's repositories, ask questions, and publish only within the publishing rule above. A later version that adds a workflow asks again. This extends the plugin design's rule, under which a new version asks again only when it asks for more capabilities. The consent record stores, besides the capabilities, the list of workflow names consented to, and a version whose `contributes.workflow` adds a name prompts. ADR 0029 records the extension.
- **The router.** `run.start` with `workflow: auto` runs the workflow named in the `workflows.router` setting. Its default is `pacer-dev/router`.
- **Rust parity.** The new extension point's types are generated into a CRATE-3 area crate, `crates/plugin-workflow-protocol`, by `cargo xtask gen`. The Rust SDK (`pacer-plugin`) gets a typed handler, and a Rust fixture plugin in `crates/fixtures` serves one workflow. The conformance suite gains a `workflow` case that both SDKs pass. The native plugin reads in `crates/plugin-ops` (`plugin.list`, diagnostics) learn the `workflow` contribution key, so the Rust and TypeScript listings stay identical.

### Agent-driven testing

An agent-driven test is an ordinary `agent` step whose agent drives the real product as a person would and reports evidence. The frame knows nothing about any particular harness. It supplies three things:

1. **An evidence result shape**, which the workflow's result schema may require:

   ```json
   { "summary": "…", "passed": 3, "failed": 0, "unverified": 1,
     "surfaces": [ { "name": "web runs page", "status": "pass|fail|unverified",
                     "steps": ["…"], "artifacts": ["art_…"] } ],
     "report": "art_…" }
   ```

   The engine checks that the three counts match `surfaces`, and refuses the result if they do not. Edge conditions read it like any result, for example `result.failed == 0 and result.unverified == 0`. An `unverified` surface is never counted as passed.
2. **Artifacts.** `step.artifact { path, label }` copies a file from the asking task's worktree or evidence directory into the run's artifact store under `PACER_HOME`. That store is per run and per step, with 10 MiB per file and 200 MiB per run. The call returns an `art_` id that results and the UI refer to. Board 5 draws captures and reports from these ids.
3. **Tool routing.** A step may declare `needs: [browser]`, `[desktop]` or `[tui]`. The dispatcher then picks only executors whose configuration advertises that tool. How executors advertise tools is listed under "Decisions needed".

For pacer's own `pacer-dev` workflow, the test step's prompt has the agent:

- start a sandbox with `bun run live up`, which uses a temporary `PACER_HOME`, `HOME` and port;
- drive it through the harness's agent control commands (`targets`, `inspect`, `act`, `wait`, `assert`, `capture`) for the web, tray, TUI and desktop targets, or through a browser tool for the web app (`bun run live login` gives the URL), or through computer use for the native desktop;
- write the report with `bun run live report`, attach it and the captures with `step.artifact`, and tear down with `bun run live down --keep`.

The harness's real-install guard applies to the agent as it does to a person, and the prompt repeats the rule never to touch the real install. The report summary then goes into the PR body, which is how CT-11 is met. A surface the agent could not drive is reported `unverified` with the reason; it is never left out.

## Left to the builder

- The exact schema of the workflow format, result schemas and the condition language, within the step types and rules above.
- Table columns, indexes and migration, within ARCH-16 and the columns named in this design.
- The prompt-like-line detector's patterns and thresholds.
- The orchestrator's standard prompt, the handover prompt and the question-tool instruction text.
- The retry intervals, deadlines and coalescing windows above, which are proposed starting values.
- The order of delivery: core and CLI first, then TUI, then web and desktop.

## Decisions needed

These choices are the maintainer's. Each lists the options, with the recommendation first, and the phase that waits on it. The two pending amendments, API-5b (Phase 2) and the ADR 0011 amendments (Phase 6), are listed under Follow-ups.

| # | Decision | Options (recommendation first) | Blocks |
| --- | --- | --- | --- |
| D1 | When the orchestrator keeps failing | (a) retry after 1, 5 and 15 minutes, then ask the person; (b) retry indefinitely with backoff; (c) fail the run after the third failure | Phase 2 |
| D2 | Planner exhausted or switched globally during a run | (a) the run keeps its planner, and the person switches per run with `run.set_planner`; (b) fall back automatically to the next eligible agent in `PLANNERS`; (c) ask the person each time | Phase 2 |
| D3 | Default per-run budget | (a) 60 orchestrator turns and 20 cross-run message turns per root run, pausing at the limit; (b) no default budget, only pacing; (c) ask the person at the limit instead of pausing | Phase 2 |
| D4 | Urgent runs under strict and emergency pacing | (a) urgent runs keep normal wake-ups under strict, and in emergency only urgent runs and the person's own actions wake an orchestrator; (b) every run is treated the same under pacing; (c) urgent runs ignore pacing | Phase 6 |
| D5 | Who may push and open the PR | (a) only after a `must` step approves it, or as a draft when the person opts in at `run.start`; (b) always a `must` step; (c) the workflow decides | Phase 5 |
| D6 | How accepted tasks enter the run branch | (a) `git merge --no-ff`, adding `--signoff` where the repository requires it; (b) rebase onto the run branch, then fast-forward; (c) squash each task | Phase 5 |
| D7 | How long a run branch is kept | (a) until the person deletes it with `run.cleanup`; (b) delete it automatically N days after its PR merges; (c) delete it when the run ends without a PR | Phase 5 |
| D8 | Phase 1 runs still live when Phase 3 ships | (a) pin each run to its step mode and keep the plain path while any plain run is live; (b) fail them with a "restart this run" reason at upgrade; (c) convert them to work nodes in place | Phase 3 |
| D9 | How executors advertise tools for agent-driven tests (`needs: browser`) | (a) a `tools` list in the runner's configuration, which the dispatcher matches; (b) the workflow names the executor directly; (c) no routing, so the agent reports `unverified` when it lacks the tool | Phase 5 (test steps) and Phase 7 |
| D10 | Run questions on the v2 API and on the existing attention surfaces | (a) `/v3`-only items carrying the run's identity, which existing v3 clients show as ordinary items; (b) hidden everywhere except the Runs page; (c) also given to v2 clients as plain questions | Phase 4 |
| D11 | Where the generated Rust run types live | (a) a new area crate, `crates/workflow-protocol`, from Phase 2; (b) leave them in `crates/client-protocol` | Phase 2 |
| D12 | Consent for workflows from installed plugins | (a) once at install, and again when a later version adds a workflow; (b) once at install only; (c) for every new workflow version | Phase 7 |

## Calls made in this design without an explicit decision from the maintainer

- Step types and the condition language as listed.
- Nesting depth default 2; loops only with `max_loops`.
- Orchestrator per root run, launched with the configured planner agent.
- Auto mode off by default; the first workflow's `must`/`auto` split.
- Background runs pause under strict pacing.
- Table names and operation names.
- The orchestrator wakes for one metered turn per event, rather than running for the whole run; step tasks hang under an engine-owned root work node.
- Orchestrator-role steps are turns in its session, interactive when the step says so (an exception to [ADR 0011](../decisions/0011-agent-messaging.md) decision 6).
- A per-turn run grant, so no task has to stay running.
- Step results reported through `step.result`, validated at once.
- Human steps are run-level records; questions get their own table; only blocking questions set `needs_input`.
- One repository per run.
- Workflow plugins install through the plugin system's consent; `pacer-dev` is a bundled plugin.
- Run branch details: the branch name pattern, merging on accept, serialized merges, and conflicts becoming an orchestrator task.
- Plan approval lives inside the `generate` step (`approval: must|auto`), so a generated graph never runs before it is approved; the API-5b grant shape (per-turn `prg_` bearer).
- Mapping urgent / normal / background onto the existing numeric task priority, and generated-plan size within the dispatcher's descendant limit (raised for workflow roots if needed).
- The engine is driven by a background-worker tick over `task_changes` with per-tick recovery, rather than by an in-process subscriber (built in Phase 1).
- Wake-ups and turns are durable rows; only decision points wake the orchestrator; a handover prompt from durable state when the planner changes.
- Accept for a run task merges the task's branch before the verdict is recorded; merges happen in an engine-owned integration worktree; `run.stop` never touches the run branch.
- Plugins supply workflows through one data-only call, `workflow.definitions`; disabled definitions are kept for running runs.
- The agent-driven test evidence shape, the run artifact store and its size limits.
- The publishing gate: `approves: publish` on a `must` human step, checked by `run.publish` itself; the PR step is an orchestrator step.
- A merge conflict on accept is a normal result (`accepted: false`), not the `conflict` error code.

## Follow-ups

- ADR: [0029 workflow frame](../decisions/0029-workflow-frame.md), including the ADR 0011 amendments and the API-5b rule amendment, all awaiting the maintainer's approval.
- Live validation (CT-11) and project review (REPO-10) for each implementation PR.
