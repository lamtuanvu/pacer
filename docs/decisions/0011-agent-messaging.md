# Agent messaging protocol with configurable guardrails

Date: 2026-10-28. Status: proposed; the amendment below awaits maintainer merge.

## Context

Delegation is a one-shot handoff. Follow-ups (send-back, answer, retry) start a fresh executor process and lose the agent's conversation. The [agent messaging design](../specs/2026-10-28-agent-messaging-design.md) adds a message protocol between agents, a native session resume per turn, and a liveness broker.

## Decisions

1. Messaging is agent to agent. Participants are `human`, `external:<key>` (agents pacer did not launch) and `task:<id>` (agents pacer launched). How a message is delivered depends on the participant's kind, not on its position in the tree.
2. Routing, rates, caps, liveness and hook strength are configurable guardrails. They are evaluated in the service on every send. The default guardrail is: top-level sessions may message their direct children and other top-level sessions; children may message their parent and, with a work grant, their siblings and their own children; anyone may message the human; the human may message anyone.
3. Three protocol invariants cannot be configured: the sender identity is derived from the credential, grant or role env; sends are idempotent by `(sender, request_id)`; message bodies reach agents only as argument-vector or stdin data (SEC-5).
4. A message to an agent pacer launched runs a new turn through the existing runner, so admission, budget, slots and token accounting apply. Every continuation turn (message, answer, send-back) first passes fresh project policy admission, as a new attempt does ([ADR 0015](0015-policy-admission-and-task-mutation-locks.md)). The turn resumes the stored native session in the same worktree while policy admits that executor.
5. Refusals reuse the existing error codes and carry `data.reason`. No new `CoreErrorCode` is added.
6. A human-started delegated task is full managed work by default when `messaging.grants.user_started_tasks` is `on`. `grant: false` or `pacer delegate --no-grant` opts out for that task. Conversations and planner-origin delegates are excluded. Managed roots use strict enforcement and therefore default to headless launches; they may create children through their attempt grant and review those children through `dispatch.review`. Their message turns still use managed restart, grant revocation and reissue, and the attempt budget.

## Identity sources and accepted exceptions

- A caller is `human` only through app authentication, or through the CLI in an interactive terminal (`stdin` is a TTY) that is neither an executor session nor a planner session (`CLAUDECODE=1`, `PACER_PLANNER_SESSION`, or the Codex session variables `CODEX_THREAD_ID` and `CODEX_SANDBOX`). Any other unknown local caller is `external:local`. It has no human privileges: it cannot confirm held messages or close nodes it did not start. It is not a top-level session either, so the default `top_peer` rule does not let it message (or start turns in) tasks it did not start, including human-started tasks; such a send is refused with `msg_forbidden`. Under the default it may message the human and the tasks it started. `pacer delegate` (CLI and MCP) records the task's origin with the same rule, so a planner's reports reach the inbox its `msg inbox` reads. A retry, and an answer or send-back that falls back to a retry, keeps the original task's origin rather than the retrying caller's.
- Accepted exception: an executor's identity comes from `PACER_ROLE=executor` and `PACER_TASK_ID`, which the executor could change. Executors already run unsandboxed as the same OS user as the service, so a per-process secret would not stop a determined executor today. Binding executor identity to a per-attempt token, as work grants do, is future work. Orca workers have no environment option, so their executor contract carries the identity on the `pacer ask` and `pacer msg send` commands themselves.
- The CLI calls the `msg.*` ops in-process rather than through the service (ARCH-1 advisory): the caller's identity comes from that process's environment, which the service would not see. State is shared through the task and message stores, and turns are launched detached from the caller's process.

## Accepted defaults and deferrals

- The default `top_peer` rule lets a top-level task's executor, including one without a grant, message other top-level tasks, which can start a turn in another tree. This is the maintainer's chosen default. The turn runs under the recipient tree's caps and budget admission, and users can narrow it in config (for example, `{effect: deny, relation: [top_peer]}`).
- Rule matchers for `account` and `tree id` are deferred; plan 1 ships `repo` and `executor`.
- `msg.close` is authorized separately from sends: only the node's parent, the tree's origin or the human may close it.
- The claude-code headless resume argv keeps the model and permission flags but not every flag `launchFor` adds for a fresh launch. It is to be compared against `launchFor` with live evidence.

## Planner hook trust

`SessionStart` records a native planner session identity, while `Stop` and `UserPromptSubmit` surface unread messages for that session. The hook may block a planner's Stop, which is deliberately configurable through `messaging.hooks.stop` (`block`, `inject_only` or `off`). The default block releases after the same message set has blocked twice, then the broker escalates to the human. The hooks fail open and skip executor sessions. Planner-kind inbox messages are also shown because MCP calls do not carry the session environment. Hook output is context for the planner, not an authority to send, mark read, or bypass the service guardrail; the planner must answer or mark messages read.

## Project policy and live delivery

Project messaging rules have their own `project-messaging.json`, revision and lock. They sit between tree and global rules. They cannot share `project-strategies.json`: its v1 schema is strict, old readers fail closed on new fields, and writes replace whole entries. An invalid messaging file is surfaced by policy inspection while sending falls back to global and default rules. Revision checks protect concurrent edits.

Live delivery waits until the agent is between turns and no viewer holds terminal control. It never injects into a takeover run. Pacer takes control, sends one bracketed paste and one Return, then releases control. Bodies above 32 KiB are stored in a private run-directory file and only a short read-file prompt is pasted. Socket or control failures release messages back to pending; a later turn-ended report completes the turn. These rules keep a human's terminal input and an active agent turn from being interrupted.

## Proposed amendment (API-5)

API-5 bounds what an executor may *create* to its grant subtree. This amendment adds the following: messaging routes are user-configured guardrails evaluated by the service, and they may allow messages outside a subtree, for example between top-level sessions. A message never grants the power to create work or to run free-form shell text. Identity derivation and argument-vector delivery stay fixed.

## Consequences

Planners and executors can hold multi-turn conversations with full context. Every turn is metered. Per-session planner identity distinguishes planner sessions on one machine; messages addressed to the generic planner-kind inbox remain visible to each session. Human-started managed work can coordinate sub-agents, but strict enforcement requires an eligible certified executor and a headless default. The opt-out preserves an unmanaged task when that coordination is unnecessary.
