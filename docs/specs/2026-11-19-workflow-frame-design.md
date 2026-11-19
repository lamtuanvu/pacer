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

- A task belongs to a run only if the engine created it. The marker is a `run` reference on the task or work node, and no other path sets it.
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

Each step instance is a dispatcher work node under the run's root, so dispatcher limits, dependency waits, capacity, executor choice, fallback and liveness apply unchanged. The engine owns the graph's shape; the dispatcher owns who runs each task and when. A generated plan's dependencies become dispatcher dependency edges.

**Returning a step result.** An agent reports its result through a new operation, `step.result` (CLI `pacer step result`, and an MCP tool), with a JSON body. The engine validates it at once against the schema the workflow declares and returns the errors to the caller, so the agent can fix it in the same turn. A task that settles without a valid result is failed with the validation error, and the orchestrator decides (retry with the error, send back, or escalate). Results are not parsed out of the free-text report.

**Human steps** are run-level records, not tasks: nothing runs while one waits. The engine creates a question for it (below) and the step finishes when the question is answered, by the person, or by the orchestrator when auto mode allows.

**One repository per run.** `run.start` takes a repo (the CLI defaults to the current one). A run is one dispatcher subtree in that repo. Work across several repos is a non-goal for this version.

### Generated sub-workflows

A `generate` step asks an agent (normally the orchestrator) for a sub-workflow in the same format, constrained by the step's `limits`. The engine validates it. On failure the agent gets the errors and retries, up to the step's retry limit. A valid graph is stored as a versioned record linked to the step.

**Approval before it runs.** A `generate` step may set `approval: must` or `approval: auto`. The engine then raises a human question carrying the graph, and starts the child run only after approval; "revise" sends the person's note back to the agent, which regenerates. With `auto`, the orchestrator may approve in auto mode, as for any `auto` step. Without `approval`, the child run starts as soon as the graph is valid. The `generate` step finishes when its child run finishes, and its result is the child run's result. In the sketch, the generated plan's `require_last` makes the tests the plan's final step, before `open_pr`.

Rules: no cycles except bounded retry edges that the limits allow; nesting depth defaults to 2; `require_after` and `require_last` are enforced by the validator, not by prompt.

**Re-planning.** When a task in a generated plan still fails after dispatcher fallback, the run's `replan` policy applies. Options per workflow: `auto: N, then: ask` or `ask`. On re-plan the orchestrator writes a new version covering the unfinished steps; finished steps are kept; the person sees a summary of what changed. The first workflow uses `auto: 1, then: ask`.

### Orchestrator

One orchestrator per root run. pacer launches it with the configured planner agent (any agent in `PLANNERS`; P3) and keeps one native session for the run's life, so its context stays on one piece of work. Role detection (`isExecutorSession`) gains this third role.

**Lifetime: event-driven turns, not a long-lived process.** A run can wait days on a `must` step, so the orchestrator does not stay `running`. It settles between events and the engine resumes its session for one turn per event: a step settled, a step result was invalid, a question was escalated to it, a re-plan is due, the person sent it a message, or the person returned to the run (for the "since you last looked" summary). Each wake-up is a metered turn and is billed like any other. A paused or background run simply raises no wake-ups. Because the orchestrator is not `running` between turns, step tasks are not its dispatcher children: each run has a root work node owned by the engine, and step tasks are children of that node.

**Steps with `role: orchestrator` are turns in its session**, not new tasks. The step instance records the turn id, and a retry is another turn. A step may set `interactive: true` (brainstorming does), and then that turn runs in the orchestrator's interactive lane, so the person sees and can type in its terminal. Otherwise the turn is headless. This is an exception to [ADR 0011](../decisions/0011-agent-messaging.md) decision 6 (managed roots default to headless launches), limited to orchestrator turns of steps marked interactive.

It acts only through engine and task operations, each recorded with a reason:

- decide at decision points: produce the results that edge conditions read, choose a workflow, give a review verdict;
- write and rewrite generated plans;
- supervise: read its run's events, answer executor questions it can answer, escalate the rest;
- intervene: send back with a note, retry on another executor, skip, stop, re-plan.

The person talks to a run through its orchestrator (for example, brainstorming happens in its session) and can still open any executor's session directly.

**Grant.** A new run grant, scoped to one root run, allows: review, send-back, retry, stop, skip, escalate, submit a sub-workflow, choose a workflow, report step results, and answer questions inside that run. Executors keep their existing grants.

This is a new credential, so it needs a rule amendment, proposed here as **API-5b**, modelled on API-5a:

- a `prg_` bearer (`prg_` + 64 lowercase hex), bound to exactly one root run id and one orchestrator turn (turn id and the turn's deadline), stored SHA-256-hashed in the existing grant store under its own `kind`;
- issued when an orchestrator turn starts, it expires at that turn's deadline and is revoked when the turn settles or the run ends or is stopped;
- it authorizes only the operations listed above, and only on tasks, steps and questions of its own run. `authorizeWorkOperation` answers for it first and refuses everything else;
- an unknown, expired or revoked `prg_` fails closed (403 at the HTTP gate, `not_allowed` from the core) and is never treated as an executor or the operator.

Because a fresh grant is issued for every turn, the grant is not tied to a task being `running` or to a task timeout, which is what lets a run wait days for the person.

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
- Under strict or emergency pacing, `background` runs pause at their next step boundary and their orchestrators go idle until the budget recovers. Paused runs show why.
- The attention queue ranks by what an answer unblocks (stops the run, stops a branch, informational), then by run priority, then by age. Items carry their run's identity so clients can group and colour them.
- Each run keeps a "since you last looked" summary that its orchestrator writes when the person returns to it.

### Run branch: how parallel code comes together

The frame gives every run that changes code a **run branch**, created from the repo's base branch when the run starts (for example `pacer/run-<id>`). The maintainer chose a frame-provided run branch over leaving integration to each workflow; the details below (naming, merge timing, conflict handling) are design calls listed under "Calls made".

- **Starting a task.** A code task's worktree branches from the run branch at its current tip. Because a dependency counts as satisfied only once it is accepted, and accepting merges it (below), a dependent task always starts with the code of everything it depends on.
- **Accepting a task.** When a code task is accepted (by the orchestrator or the person), the engine merges its branch into the run branch. Merges into one run branch are serialized.
- **Conflicts.** If the merge conflicts, the run branch is left untouched and the engine creates a conflict-resolution task for the orchestrator. That task has both branches and the conflicting files, may delegate the fix, and finishes when its result merges cleanly. Tasks that depend on the conflicting one wait.
- **Base moves on.** Updating the run branch from the base branch is a step a workflow can include (for example before opening the PR). It uses the same conflict path.
- **Pull request.** A PR is opened from the run branch. The frame exposes the run branch name and the base branch to steps, so a workflow's PR step needs no knowledge of task worktrees.
- Runs that change no code (for example a question answered by exploring) never create a run branch.

### Persistence

New tables in the existing task store: `workflow_defs` (installed definitions and versions), `workflow_runs`, `workflow_steps` (step instance to task or work-node mapping, result, loop count), `workflow_graphs` (generated sub-workflow versions with their producing step), and `workflow_decisions` (who decided what, at which step, why). Step tasks are ordinary tasks and work nodes. All writes use `expect_rev`.

### Operations, events and clients

Core operations (additive, `/v3/ops`): `workflow.list`, `workflow.validate`, `run.start` (brief, workflow or `auto`, priority, auto mode), `run.get`, `run.list`, `run.pause`, `run.resume`, `run.stop`, `run.set_priority`, `run.set_auto`, `run.decide`, `run.submit_graph`, `step.retry`, `step.skip`, `question.ask`, `question.answer`, `question.escalate`. Events: run, step, decision and question entities on the existing SSE stream.

CLI: `pacer run start|list|show|pause|resume|stop|priority|auto`, `pacer workflow list|validate`, and `pacer ask`/`pacer answer` gaining the structured form. TUI: a run list, and a run view with the step graph as an indented tree, decisions and questions. Web and desktop: see "User interface" below; they are clients of these operations and come after the core.

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

## Left to the builder

- The exact schema of the workflow format, result schemas and the condition language, within the step types and rules above.
- Table columns, indexes and migration, within ARCH-16.
- How the engine hooks task settlement (in-process subscriber in the core is expected).
- The prompt-like-line detector's patterns and thresholds.
- How plugins ship workflow files and prompts within the existing plugin protocol.
- The orchestrator's standard prompt and the question-tool instruction text.
- The order of delivery: core and CLI first, then TUI, then web and desktop.

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

## Follow-ups

- ADR: [0029 workflow frame](../decisions/0029-workflow-frame.md), including the ADR 0011 amendments and the API-5b rule amendment, all awaiting the maintainer's approval.
- Live validation (CT-11) and project review (REPO-10) for each implementation PR.
