# Agent messaging: multi-turn collaboration between agents, with a liveness broker

Date: 2026-10-28. Status: proposed, awaiting the maintainer's approval. Applies to: `src/tasks/**` (store, types, runner), `src/exec/**` (launch, direct, prompt), `src/supervisor/**`, `src/session/**`, `src/core/tasks.ts`, `src/core/work.ts`, `src/api/ops.ts`, `src/api/ops-session.ts`, `src/api/caller-policy.ts`, `src/mcp/server.ts`, `src/cli.ts`, `src/install/{claude,codex,skill,policy,doctor-hooks}.ts`, `src/attention/**`, `src/view-model/**`, `app/src/**`, `plugins/agent-session/**`, `docs/protocol.md`, `docs/protocol.schema.json`, generated Rust protocol types.
Builds on:
- [ADR 0003 interactive conversations](../decisions/0003-interactive-conversations.md) and the [interactive agent support design](2026-10-24-interactive-agent-support-design.md): native resume arguments and session identity
- [intelligent work dispatcher](2026-10-24-intelligent-work-dispatcher-design.md) and [ADR 0006](../decisions/0006-intelligent-work-dispatcher.md): API-5 work grants, `dispatch.retry` same-task restarts
- [attempt token accounting](2026-10-27-attempt-token-accounting-design.md)

## Problem

Delegation is a one-shot handoff. Every delegated run is a headless process (`codex exec`, `claude -p`, `opencode run`) that exits when the agent finishes. After that, nobody can talk to the agent again:

- `--send-back`, `pacer retry` and `pacer answer` each start a **fresh executor process** with a rebuilt prompt. The agent's conversation memory is gone. Send-back and answer also create a new task id.
- `pacer answer` bases the new task on the asking worktree's `HEAD`, so the asking run's uncommitted edits appear to be lost (not yet confirmed by a test).
- The native session id is usually captured (`run.agentSession`), but no delegated path uses it to resume.
- Interactive conversations can resume a native session, but only a human can drive them. An agent would have to type raw PTY keystrokes (`pacer session io`) and parse base64 terminal output. No op sends a message and returns the reply.
- Nothing notices when collaboration stalls. If an executor's turn ends without a result, or a question sits unread, the tree waits forever.

## Goals

1. One messaging primitive for every participant. Agent to agent is the same whether the peer is a planner, an executor or a sub-executor.
2. A message to an agent pacer launched continues that agent's **native session** in the **same worktree**, so context and uncommitted work survive across turns.
3. A liveness broker guarantees that every open tree always has a next mover, and that the next mover is either making progress or a human has been told it is their move.
4. Every turn is metered, capped and recorded. Messaging never bypasses budget, slot or API-5 checks.
5. CLI, API and MCP expose the same operations (ARCH-8). Conversation end never implies a review verdict.

Non-goals:
- An unguarded mesh. The protocol allows any route, but every send passes the configured guardrail, and the default guardrail is close to the task tree.
- Plugin-supplied guardrail policies. The policy evaluator is one interface so a plugin provider can be added later under ARCH-12–14; this spec ships config rules only.
- Moving a session between executors. `--retry-on <other executor>` still creates a new task.
- Replacing Orca orchestration for workers pacer did not launch.

## Model

### Participants

A participant is anything that can send or receive messages. There are three kinds, and the kind decides delivery, never the position in the tree.

| Kind | Example | Reachability |
|---|---|---|
| `launched` | any task pacer runs, including a top-level task a user started | wakeable: the broker starts a turn |
| `external` | a Claude Code or Codex planner calling `pacer delegate` | pull only: inbox, MCP, planner hooks |
| `human` | the user in the app, TUI or terminal | notify only: attention, badge, thread view |

An `external` participant is registered on first contact with a stable identity: the planner kind plus its native session id when the hook supplies one, otherwise the calling process's planner identity. A `human` participant is the local user; one per pacer home. A caller is `human` only through app authentication or the explicit local path: the CLI in an interactive terminal that is neither an executor session nor a planner session. Any other unknown local caller is `external:local`, which has no human privileges (see [ADR 0011](../decisions/0011-agent-messaging.md)).

### Tree

Every tree has an origin: the participant that started it, either a `human` or an `external` agent. Each task node's parent is the participant that created it. A `launched` agent can be a top agent (parent is the origin), a child and a parent at once.

A task the user starts gets an API-5 work grant when `grants.user_started_tasks` is on (the default), so its agent can create and message its own subtree. The user can turn this off per task.

### Protocol and guardrails are separate layers

The protocol is plain agent to agent: any participant can address any other participant by id. It does not hard-code who may talk to whom, how often, or how the broker pushes. Those are **guardrails**: a configurable policy that the service evaluates on every send and every broker action. Pacer ships a default guardrail; users and projects can narrow or widen it without a protocol change.

```
sender ──msg.send──▶ [identity] ──▶ [guardrail policy] ──▶ [store] ──▶ [delivery driver]
                     derived from       allow / deny /                   resume, live,
                     credential/grant   rate / cap / escalate            pull, notify
```

The service always derives the sender's identity from the caller's credential or grant, never from a request field. That, idempotency and SEC-5 argument-vector delivery are protocol invariants, not guardrails, and cannot be configured away.

### Guardrail policy

A policy is an ordered list of rules in pacer config (global, then per-project strategy, then per-tree overrides given at delegate or session start; a narrower scope wins). The first matching rule decides. A send that matches no rule is denied with `CoreError("MSG_FORBIDDEN")`, whose data names the policy layer that refused it.

A rule matches on:

| Matcher | Values |
|---|---|
| `from` / `to` kind | `launched`, `external`, `human`, `any` |
| `from` position | `top` (origin of a tree), `child`, `any` |
| relation of `to` to `from` | `parent`, `child`, `sibling`, `descendant`, `ancestor`, `same_tree`, `top_peer` (another top-level session), `any` |
| message `kind` | `message`, `question`, `answer`, `report`, `nudge`, `close` |
| scope | repo, executor (account and tree id are deferred; see ADR 0011) |
| grant | sender holds an API-5 work grant: `required`, `not_required` |

A rule's effect is `allow` or `deny`, plus optional limits: maximum messages per minute, maximum turns it may cause, maximum body size, and whether it requires human confirmation before delivery.

The same policy holds the broker and hook settings, so they are configurable too:

| Setting | Default |
|---|---|
| `liveness.interval` | 60 s |
| `liveness.backoff_max` | 15 min |
| `liveness.max_nudges` | 3 |
| `liveness.nudge_in_modes` | `relaxed`, `normal` (escalate instead in `strict`, `emergency`) |
| `tree.max_turns` | 50 |
| `message.max_bytes` | 64 KiB |
| `hooks.stop` | `block`, released after the same message set blocked `2` times; also `inject_only`, `off` |
| `grants.user_started_tasks` | `on` |
| `keep_worktree_days` | 7 days a resolved, open task keeps its worktree after its last message or run end (`0` turns the window off) |

### Default guardrail

The shipped policy starts from this routing table:

| Sender | Allowed recipients |
|---|---|
| A top-level session (an identified `external` planner session, or a `launched` top agent whose parent is a `human`; not the unidentified `external:local`) | its direct children, and other top-level sessions under the same pacer home |
| The unidentified local caller `external:local` | the tasks it started |
| A child node | its parent, and its siblings |
| Anyone | the `human` |

Under the default, a parent reaches deeper descendants through the child in between, and a child without a grant may message only its parent (the replacement for `pacer ask`). Users widen it (for example, allow `descendant`, or let mid-tree parents message each other) or narrow it (for example, deny `top_peer` for one project) in config.

Wherever a policy lets a message cross trees, the recipient's turn runs in the recipient's tree, under that tree's caps and budget admission. The wait-for graph spans all trees, so a cycle across trees is detected like one inside a tree.

`pacer msg policy [--json]` prints the effective policy for the current repo with the layer each rule came from. `pacer msg policy --check --from <p> --to <p> --kind <k>` explains which rule decides, without sending. A refusal's hint gives this command for the refused send. When no rule matched, the refusal says so (`data.layer: none`) and names the closest allow rule that would have matched with a work grant (`data.closest`).

### Messages

A new `messages` table in the task store (`tasks.db`):

| Field | Meaning |
|---|---|
| `id` | ULID |
| `tree_id`, `task_id` | the tree, and the task the message belongs to |
| `from`, `to` | participant ids |
| `kind` | `message`, `question`, `answer`, `report`, `nudge`, `close` |
| `body` | text, max 64 KiB |
| `reply_to` | message id, required for `answer` |
| `request_id` | caller idempotency key, unique per sender |
| `created_at`, `delivered_at`, `read_at` | delivery lifecycle |
| `turn_id` | the turn that delivered or produced it |

Messages are append-only. The thread of a task is its messages ordered by `id`.

### Node turn state

Each `launched` node gets a `turn` field on its `TaskRecord`:

| State | Meaning |
|---|---|
| `working` | a turn is in progress |
| `awaiting_reply` | it sent a `question` and its turn ended; it waits for an `answer` |
| `idle` | its turn ended normally; it may receive more messages |
| `done` | it sent a `report` with an outcome |
| `stalled` | the broker gave up nudging; escalated |
| `closed` | reviewed, stopped or closed by its parent |

`external` and `human` participants have only a derived state: `has_unread` and `blocking` (some node is `awaiting_reply` on them).

## Delivery

Delivery sits behind a `DeliveryDriver` interface chosen per recipient:

```ts
interface DeliveryDriver {
  deliver(recipient: Participant, pending: Message[]): Promise<DeliveryResult>;
}
```

### Resume driver (`launched`, headless)

When a recipient is not `working`, the broker batches all its undelivered messages into one turn:

1. Admission: route, budget, slot and tree-cap checks, the same as an attempt. A refused admission leaves the messages queued and records why.
2. Launch the native resume in the node's worktree, with only the new messages as the prompt, passed as an argument vector (SEC-5):
   - codex: `codex exec resume <sid> -` (prompt on stdin)
   - claude-code: `claude -p --resume <sid> --output-format stream-json …`
   - opencode: `opencode run --session <sid> …`
3. The turn's final assistant text becomes a `report` message to the node's parent, unless the agent already sent one with `pacer msg`.
4. Token usage is recorded per turn, as per attempt today.

Messages to a `working` node queue and are delivered as one batch when its turn ends.

Headless resume argv is built by the host's `resumeHeadlessFor` in `src/exec/launch.ts`, next to `launchFor`. The plugin keeps owning interactive launches. Session identity gaps are closed:
- opencode headless: capture the session id when the run starts, rather than by title lookup during takeover.
- claude-code: keep one session id for the node's lifetime instead of a fresh UUID per attempt. A fallback to another executor starts a new node.

If resume fails because the CLI rejects the id or the history is missing, the driver starts a fresh session with the thread replayed as context, records `resume: "replayed"` on the turn and labels it in the log.

### Live driver (`launched`, interactive)

For conversations and executors with `session: "interactive"`, the process stays alive. The driver writes the batched messages into the PTY as one submitted prompt once the Stop hook reports the turn ended, and reads the reply from the hook's transcript report. This is in phase 1 for conversation top agents, because children of a conversation must be able to reach it.

### Pull driver (`external`)

Messages wait in the inbox. They reach the agent through `pacer msg inbox [--wait]`, the MCP `msg_inbox` / `msg_wait` tools, and the planner hooks described under Liveness.

### Notify driver (`human`)

The app and TUI show a thread view and a **Waiting on you** state. An attention item is raised for every `question`, and for unread messages that block a node.

### Existing commands, re-expressed

| Today | After |
|---|---|
| `pacer ask "<q>"` (executor) | `question` to parent; the turn ends in `awaiting_reply` |
| `pacer answer <id> "<a>"` | `answer` to the asking node; resumes the **same** task and session |
| `pacer review --send-back --note` | `message` with the note; resumes the same task |
| `pacer review --retry-on <exec>` | unchanged: a new task on another executor |
| `dispatch.answer` / `dispatch.retry` | implemented on top of the message path; the same task id, as today |

The old commands keep their names and flags. The protocol keeps `task.answer` and the `send_back` verdict; they now create messages.

## Liveness broker

A loop in the service checks every open tree. The default interval is 60 s, configurable globally and per tree. It keeps one invariant: **while a tree is open, some participant holds the next move, and that participant is making progress, or a human has been told it is their move.**

### Detection and action

| Stall | Action |
|---|---|
| A `launched` node's turn ended with no `report`, `question` or outcome | Resume it with a `nudge`: "Your turn ended without a result. Continue, ask your parent, or report." |
| A `launched` node is `working` with no output past the idle threshold | The existing supervise idle detection stops the turn, then a `nudge` resumes it |
| A `launched` node's process died mid-turn | Existing runner recovery; if that fails, resume with a `nudge` |
| A delivery to a `launched` node failed | Retry the delivery on the backoff schedule |
| An `external` agent has unread messages or is blocking a node | (a) a `Stop` hook stops the planner from ending its session and puts the pending messages in its context; (b) a `UserPromptSubmit` hook adds them at the start of its next turn; (c) after the escalation delay, an attention notice to the human |
| A `human` has unread messages or a pending question | Attention notice immediately; reminders on the backoff schedule; the task shows **Waiting on you**. Humans are never nudged, only reminded. |
| A wait-for cycle (A waits on B, B waits on A) | Nudge the deepest `launched` node in the cycle to make the next move. A cycle of only `external` and `human` participants escalates to the human. |

The wait-for graph is built from `awaiting_reply` edges and unread blocking messages. Cycle detection runs on every broker tick.

### Bounds

- Values below are the default guardrail; all are configurable (see Guardrail policy).
- Backoff: the first nudge after one interval, then doubling, up to `liveness.backoff_max`.
- At most `liveness.max_nudges` consecutive nudges without progress per node. Progress is any outgoing message, outcome or new commit/diff in its worktree. Then the node becomes `stalled`, and the broker calls `task.request_review` with a specific note and raises an attention item.
- Nudges are turns. They count toward the tree's turn cap and pass budget admission. In `strict` and `emergency` modes the broker escalates instead of nudging.
- The broker runs until the tree's origin closes it (accept, reject, stop or `msg close`). Closing a conversation records no verdict.

### Planner hooks

`pacer install` adds, for Claude Code and Codex planners:
- `Stop`: `pacer msg hook stop --planner <kind>`. If the planner's identity has unread messages, or a child is `awaiting_reply` on it, the hook returns a block decision whose reason contains the messages. With the default `hooks.stop: block`, it allows the stop after the same message set has blocked twice, so a planner cannot be trapped, and the broker escalates to the human.
- `UserPromptSubmit`: `pacer msg hook prompt --planner <kind>` adds the pending messages as additional context.

`pacer doctor` probes both hooks, as it does `SessionStart` and `PreToolUse` today.

## Surfaces

### API operations

| Op | Purpose |
|---|---|
| `msg.send` | `{task, to?, kind, body, reply_to?, request_id}`; `to` defaults to the task's agent |
| `msg.inbox` | unread messages for the caller |
| `msg.wait` | block until a message for the caller, or a reply to a message id, arrives; with a timeout |
| `msg.log` | a task's thread, paged |
| `msg.read` | mark messages read |
| `msg.close` | close a node or tree; no verdict. Only the node's parent, the tree's origin or the human may close it; closing is not a send and does not pass the routing guardrail. |
| `tree.status` | per-node turn state, next mover and stall counters |

SSE events: one entity kind, `message`, whose value is the message row including `status`. `node.stalled` arrives with the broker in plan 2. Refusals reuse existing codes with `data.reason`: `not_allowed`/`msg_forbidden` (with `data.layer`), `too_large`/`msg_too_large`, `conflict`/`msg_cap_reached`, `conflict`/`msg_node_closed`, `conflict`/`msg_worktree_unavailable` (cleanup removed the worktree a settled task's next turn resumes in), `conflict`/`msg_live_unavailable`.

### CLI

```
pacer msg send <task> "<text>" [--question] [--to <participant>] [--wait] [--json]
pacer msg inbox [--wait] [--json]
pacer msg log <task> [--json]
pacer msg close <task>
pacer tree <task> [--json]
```

### MCP

`msg_send`, `msg_inbox`, `msg_wait`, `msg_log`, `tree_status` for planners. Executors with a work grant receive the same tools, limited to their subtree.

### Skill and policy

The planner skill and policy change from "delegate → wait → review" to "delegate → converse → review". They document `pacer msg`, explain that follow-ups continue the same session, and cover `send-back`, `answer` and `needs_input`, which the skill omits today. The executor contract replaces "`pacer ask` is your only way back" with the message commands and says that ending a turn without a report triggers a nudge.

### App and TUI

The task detail gets a thread view: messages, turns and nudges in order, with a composer. A node in `stalled`, or waiting on the user, shows a plain-language state (UI-12). Tree view nodes show their turn state.

## Safety

- The sender's identity comes from the credential or grant, not the request.
- Message bodies reach agents only as prompt data in argument vectors or stdin; nothing runs through a shell (API-5, SEC-5).
- `request_id` makes sends idempotent. State changes on a node use `expect_rev`, following the dispatch pattern.
- Per-tree caps: maximum turns (default 50), maximum nudges, maximum message size. Reaching a cap makes the node `stalled` and escalates; messages are never dropped silently.
- Messages are stored with the task store's file permissions. They may contain code and secrets the agents saw, so they get the same handling as task logs.

## Delivery plan

Three plans, each shippable on its own.

1. **Messaging core.** Participants and identity (with each task's recorded `origin`), the message store, the guardrail evaluator with global and per-tree layers and the default policy, `msg.*` ops, CLI and MCP, headless resume turns, report-on-run-end, ask, answer and send-back expressed as messages, human attention for messages, skill and executor contract text, and the ADR.
2. **Liveness broker and planner hooks.** The broker loop, stall detection, nudges, the wait-for graph, `SessionStart` per-session planner identity (`PACER_PLANNER_SESSION`), `Stop` and `UserPromptSubmit` hooks and their doctor probes, escalation.
3. **Live driver and surfaces.** The live driver for conversations and interactive executors, project-level guardrail rules, grants for user-started tasks by default, the app and TUI thread view.

## Testing

- Unit: routing permission, sender derivation, batching, idempotency, turn state transitions, the wait-for graph and cycle detection, backoff and caps, hook block and release logic.
- Integration: fake executor CLIs that record resume argv. Scenarios: ask → answer resumes the same session with uncommitted edits intact; a silent turn end causes a nudge; three nudges cause `stalled` and escalation; a planner Stop hook blocks and then releases; a cycle; resume failure falls back to replay; strict mode escalates instead of nudging.
- Live (CT-11): real multi-turn runs for codex and claude-code that show context kept across turns, a nudge on a real agent, and the planner Stop hook in a real Claude Code session. opencode, and any surface that cannot be exercised, is reported UNVERIFIED.

## Decisions

Recorded from the maintainer on 2026-10-28:

1. **Protocol, not fixed routing.** Messaging is agent to agent. Routing, rates, caps, liveness and hook strength are configurable guardrails over the protocol, not protocol rules.
2. **Default guardrail.** The routing table under Default guardrail, user-started tasks granted by default, Stop hook block-then-release after 2, liveness 60 s / 15 min / 3 nudges.

## Open decisions

1. **Governance.** API-5 (amendment 0.14.0) binds executor child work to a service-issued grant within the executor's subtree. A configurable guardrail can allow routes outside a subtree (for example, between top-level sessions), and the default grants user-started tasks. The ADR proposes an amendment stating that messaging routes are user-configured guardrails, that identity derivation and argument-vector delivery stay fixed, and that a grant still bounds what an executor may *create*. It goes through the amendment process before plan 1 ships.
