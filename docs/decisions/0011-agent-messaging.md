# Agent messaging protocol with configurable guardrails

Date: 2026-10-28. Status: proposed; the amendment below awaits maintainer merge.

## Context

Delegation is a one-shot handoff. Follow-ups (send-back, answer, retry) start a fresh executor process and lose the agent's conversation. The [agent messaging design](../specs/2026-10-28-agent-messaging-design.md) adds a message protocol between agents, a native session resume per turn, and a liveness broker.

## Decisions

1. Messaging is agent to agent. Participants are `human`, `external:<key>` (agents pacer did not launch) and `task:<id>` (agents pacer launched). How a message is delivered depends on the participant's kind, not on its position in the tree.
2. Routing, rates, caps, liveness and hook strength are configurable guardrails. They are evaluated in the service on every send. The default guardrail is: top-level sessions may message their direct children and other top-level sessions; children may message their parent and, with a work grant, their siblings and their own children; anyone may message the human; the human may message anyone.
3. Three protocol invariants cannot be configured: the sender identity is derived from the credential, grant or role env; sends are idempotent by `(sender, request_id)`; message bodies reach agents only as argument-vector or stdin data (SEC-5).
4. A message to an agent pacer launched runs a new turn through the existing runner, so admission, budget, slots and token accounting apply. The turn resumes the stored native session in the same worktree.
5. Refusals reuse the existing error codes and carry `data.reason`. No new `CoreErrorCode` is added.

## Identity sources and accepted exceptions

- A caller is `human` only through app authentication, or through the CLI in an interactive terminal (`stdin` is a TTY) that is neither an executor session nor a planner session (`CLAUDECODE`, `PACER_PLANNER_SESSION` or a Codex session variable). Any other unknown local caller is `external:local`. It has no human privileges: it cannot confirm held messages or close nodes it did not start. `pacer delegate` (CLI and MCP) records the task's origin with the same rule, so a planner's reports reach the inbox its `msg inbox` reads.
- Accepted exception: an executor's identity comes from `PACER_ROLE=executor` and `PACER_TASK_ID`, which the executor could change. Executors already run unsandboxed as the same OS user as the service, so a per-process secret would not stop a determined executor today. Binding executor identity to a per-attempt token, as work grants do, is future work. Orca workers have no environment option, so their executor contract carries the identity on the `pacer ask` and `pacer msg send` commands themselves.
- The CLI calls the `msg.*` ops in-process rather than through the service (ARCH-1 advisory): the caller's identity comes from that process's environment, which the service would not see. State is shared through the task and message stores, and turns are launched detached from the caller's process.

## Accepted defaults and deferrals

- The default `top_peer` rule lets a top-level task's executor, including one without a grant, message other top-level tasks, which can start a turn in another tree. This is the maintainer's chosen default. The turn runs under the recipient tree's caps and budget admission, and users can narrow it in config (for example, `{effect: deny, relation: [top_peer]}`).
- Rule matchers for `account` and `tree id` are deferred; plan 1 ships `repo` and `executor`.
- `msg.close` is authorized separately from sends: only the node's parent, the tree's origin or the human may close it.
- The claude-code headless resume argv keeps the model and permission flags but not every flag `launchFor` adds for a fresh launch. It is to be compared against `launchFor` with live evidence.

## Proposed amendment (API-5)

API-5 bounds what an executor may *create* to its grant subtree. This amendment adds the following: messaging routes are user-configured guardrails evaluated by the service, and they may allow messages outside a subtree, for example between top-level sessions. A message never grants the power to create work or to run free-form shell text. Identity derivation and argument-vector delivery stay fixed.

## Consequences

Planners and executors can hold multi-turn conversations with full context. Every turn is metered. Per-session planner identity (two planner sessions on one machine) arrives with the SessionStart hook work in plan 2. Until then, external planners share one identity per planner kind.
