# ADR 0029 — Workflow frame: pacer runs work from brief to pull request

Date: 2026-11-19

Status: Proposed. Accepted when the maintainer merges it. The ADR 0011 amendments and the API-5b rule amendment below each need the maintainer's approval before the phase that uses them merges.

Source: [workflow frame design](../specs/2026-11-19-workflow-frame-design.md).

## Context

pacer runs and tracks single tasks, and the work dispatcher ([ADR 0006](0006-intelligent-work-dispatcher.md)) adds child tasks with dependencies. Nothing above a task describes a whole piece of work: no stages, no human steps, no plan built while the work runs, and no single place where several pieces of work compete for executors and for the person's attention. The [workflow frame design](../specs/2026-11-19-workflow-frame-design.md) describes the feature. The constitution's "Workflow choice" section forbids mandating a development method, so any workflow must stay optional and replaceable.

## Decisions

1. **pacer owns the frame; workflows are plugins.** The frame is an engine, a declarative workflow format with a fixed set of step types (`agent`, `human`, `fanout`, `choose_workflow`, `generate`, `end`), the orchestrator role, structured questions, and the operations and events clients draw. The engine stays in the host. ARCH-12 keeps routing, strategy and the pacing engine in the host and moves other capabilities to plugins; it does not name a workflow engine. The engine belongs with those because it gates core task semantics that plugins cannot hold: it reacts to task settlement, issues and checks run grants, decides which tasks are in scope, and merges into run branches. A plugin would need host-level grants to do this, which is the boundary ARCH-12 protects. The maintainer confirms this reading by accepting this ADR. A workflow, including the one pacer ships, is a plugin. No workflow, stage or triage name is built into the host.
2. **Our own engine on the task store, with no external workflow runtime.** Durable workflow servers (Temporal, Restate, Inngest) need a second runtime and store, which ARCH-16 rules out and which would make the host heavier. LangGraph and XState duplicate retries and checkpoints that pacer's tasks and dispatcher already provide. The engine only evaluates edges, joins fan-outs, counts loops and starts child runs. Every step that runs is an ordinary task, so dispatch, liveness, messages, review and attention apply to it unchanged.
3. **Declarative files only.** A workflow is a JSON or YAML graph over the fixed step types, with edge conditions in a small expression language and back edges only with an explicit `max_loops`. No plugin code runs inside the engine. A new kind of step is a frame change.
4. **Agents generate sub-workflows in the same format.** A `generate` step asks an agent for a graph, which the engine validates against the step's limits and runs as a child run after optional approval (`approval: must|auto`). The engine owns the graph's shape; the dispatcher keeps choosing executors, falling back and enforcing capacity.
5. **Only runs are in scope.** A task belongs to a run only if the engine created it. Everything new is gated on that link. Delegated and dispatched tasks, interactive lanes started outside a run, and the existing screens keep their current behaviour.
6. **One orchestrator per root run.** pacer launches it with the configured planner agent (P3). It does not run continuously: the engine resumes its session for one metered turn per event. It acts only through engine and task operations, and each action is recorded with its reason, so an agent's decisions stay traceable, in line with the [dispatcher design](../specs/2026-10-24-intelligent-work-dispatcher-design.md)'s non-goal of opaque model-made dispatch decisions. A run grant gives it review, send-back, retry, stop, skip, escalate and sub-workflow submission inside its own run. Executor grants are unchanged. The run grant is a new credential and needs the API-5b amendment below.
7. **The person's decisions cannot be loosened.** A workflow marks each human step `must` or `auto`. In auto mode the orchestrator may answer `auto` steps only. The person can make any step stricter. The frame forces no approval step of its own ([ADR 0002](0002-actionable-attention.md)).
8. **A run branch carries the code.** A run that changes code gets one branch. Task worktrees start from its tip, accepted tasks are merged into it one at a time, conflicts become a task for the orchestrator, and the pull request is opened from it.

## Rule amendment API-5b (needs maintainer approval)

API-5 lets an executor delegate only through a service-issued task/attempt grant, and API-5a adds the assistant grant as a separate credential. The orchestrator's run grant is a third credential:

- a `prg_` bearer (`prg_` + 64 lowercase hex), bound to one root run id and one orchestrator turn (turn id and deadline), stored SHA-256-hashed in the existing grant store under its own `kind`;
- issued when an orchestrator turn starts; it expires at the turn's deadline and is revoked when the turn settles or the run ends or is stopped;
- it authorizes only review, send-back, retry, stop, skip, escalate, sub-workflow submission, workflow choice, step results and answers, and only on tasks, steps and questions of its own run. `authorizeWorkOperation` answers for it first and refuses everything else;
- an unknown, expired or revoked `prg_` fails closed (403 at the HTTP gate, `not_allowed` from the core) and is never treated as an executor or the operator.

## Amendments to [ADR 0011](0011-agent-messaging.md) (need maintainer approval)

- **A wider default route for run participants.** The orchestrator and the agents in a run may message any agent, in their own run or another, and may read other runs' state. Only the owning orchestrator, or the person, may change a run's work. The existing rate and cap guardrails still bound every route, and the routing guardrails stay configurable. This applies only to run participants.
- **Interactive orchestrator turns.** Decision 6 has managed roots default to headless launches. An orchestrator turn for a step that the workflow marks `interactive` (for example, brainstorming with the person) runs in an interactive lane instead. This exception is limited to those turns.

## Consequences

- New tables in the task store: workflow definitions, runs, step instances, generated graphs, decisions and questions.
- New additive `/v3` operations (`workflow.*`, `run.*`, `step.result`, `question.*`) and CLI commands. ARCH-8 holds: the CLI and TUI can do everything.
- A new plugin extension point, `workflow`, and a bundled `pacer-dev` plugin that can be disabled or replaced.
- Orchestrator wake-ups are metered turns. Priority and pausing under strict pacing bound how much planner budget several runs use.
- The work is delivered in phases, each with live validation (CT-11) and independent review (REPO-10).
