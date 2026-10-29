# The assistant

Ask about your tasks, dispatch, executors and budgets from anywhere in the app with **⌘J** (Ctrl-J elsewhere), or with
`pacer ask "<question>"`. The design is in the [assistant spec](specs/2026-10-28-always-on-assistant-design.md) and the
[decision record](decisions/2026-10-28-assistant-extension-point.md).

## Set up

The assistant is off until you choose an account in **Settings › Assistant**. It runs on one OpenAI-compatible endpoint
account (a hosted model or a local one) and never moves to another account. If you choose the planner's account it follows
the planner's pacing: it answers in relaxed and normal mode and pauses in strict and emergency mode.

## What it can read, and what it cannot

It reads through fixed tools, in-process, from pacer's own data: counts and attention, task titles, states, executors,
times, decisions and review state, cached usage and pace, reviewed outcomes, recent activity, strategy names, and read-only route explanations (`dispatch.explain`) for a repository.
Results keep numbers and short pacer-owned names only. Goals, context, constraints, reports, output, diffs, files, keys,
terminal screens and session transcripts are never sent, secrets and your home path are removed, and each result is cut at
32 KiB. What it reads, and your question, go to the account's model.

## What it can do

Nothing on its own. It can propose a retry, stop, answer, pause (at most 24 hours), resume, a prefilled New task, or a link.
Each appears as a card whose text pacer writes from the operation; the assistant's own words sit beneath it. The app runs
the operation with your session only after you press the card's button.

## Limits, history and cost

Defaults: 32,000 input and 8,000 output tokens per question, 6 tool rounds, one question at a time, 50 a day. History is
stored on this machine in pacer's home, kept 30 days and at most 200 conversations, and **Clear history** deletes it. Each
turn's token usage is recorded as assistant use, apart from your tasks, with a `measured`, `partial` or `unknown` coverage. A cancelled answer is recorded with no usage, though the model's provider may still bill the input.

## Entry points, and what is deferred

⌘J (Ctrl-J elsewhere) and the "Ask pacer" pill open the sheet, which opens with the task's scope when you are on a task.
Not built yet, and recorded here so nobody looks for them: the ⌘K menu's `?` ask mode, its "Ask: …" result and footer hint,
and a top-bar "Ask pacer" button. The command menu is a separate change; it calls `assistantEntry.ask({ text,
newConversation })` and reads `assistantEntry.available()` (`app/src/shell/assistant-entry.ts`), which is the whole contract.
Also deferred: streamed model tokens (the plugin returns the whole answer until plugins can stream), retrying on a different
executor, an Insights row for assistant use, and a native agent CLI backend.

## The per-turn stream

`assistant.ask` returns `{ conversationId, turnId }`; the answer follows on `GET /v3/assistant/turns/<turnId>/stream`
(Server-Sent Events, same authentication as every route, in memory only, at most ten frames a second). Each `data:` line is
JSON: `{ "status": "Thinking…" }`, `{ "delta": "<text>" }` or `{ "done": { "state": "done|error|cancelled", "error"? } }`.
After `done`, read the turn with `assistant.turn`. Other windows learn that History changed from an `assistant` event that
carries no text.

## For plugin authors

`assistant` is a plugin extension point (`assistant.respond`), served only by bundled plugins until installed plugins are
sandboxed. See the [plugin protocol](plugin-protocol.md).
