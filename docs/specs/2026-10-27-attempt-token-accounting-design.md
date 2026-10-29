# Attempt token accounting

## Intent

Pacer should be able to show how much work its dispatcher moved and what that work cost. It needs to know:

- how many root tasks it handled,
- how many tokens each root task used in total,
- how those tokens were spread across the executors, accounts and models that ran its subtasks and retries, not only the executor named on the root task.

This design records token usage for each attempt, rolls it up through the work tree, and exposes it through the versioned API. Clients render it on the Insights screen, the Dispatch summary, the task list and task detail. The service owns measurement and aggregation (P1). Clients only display the results.

## Current foundations and gaps

- `Attempt` (`src/tasks/types.ts`) records executor, model, actual model, timing, exit status, the log path (which can be empty, for example on some interactive runs) and `routing` (rule, chosen executor, why, skipped executors). It also records `usageAtStart` and `usageAtEnd`, the account's quota percentage before and after the run.
- `workTotals` (`src/dispatch/work.ts`) already rolls a work tree up into task counts, execution time, wait times and `usagePools`. A usage pool is the observed quota-percentage delta per account, pool and reset epoch. Each attempt belongs to exactly one work node, so attempts are never counted twice.
- No token counts are recorded. Percentage deltas cannot be summed across providers. They also cannot be split between attempts that overlap on a shared account. The pool total says `attribution: "shared-account-observation"` for this reason.
- Codex already prints one total ("tokens used / 32,612") at the end of its plain-text log, with no split between input and output. Claude Code runs with `--output-format stream-json`, whose final `result` event carries a usage object. Cursor runs with `--output-format text`. Antigravity (`agy -p`) and OpenCode (`opencode run`) are launched without a structured output format. Remote runners force plain text.
- Planner tokens (the planning, splitting and review turns tied to a root task) are not observed at all. Neither are tokens spent by a model-backed decision engine, which the dispatcher design requires to be accounted for explicitly.
- The work-tree projection (`workTree` in `src/dispatch/work.ts`) copies only an allow-list of attempt fields, and returns `attempts: []` for a node whose task record cannot be read.

## Goals and boundaries

- Record one token measurement for each attempt where the executor reports one, with its provenance: where the numbers came from, how complete they are, and when they were captured.
- Roll measurements up per work node and per root task, and from there per executor, account, model, task kind, repository and period. Each attempt is counted once. Root totals include every descendant's attempts.
- Make coverage explicit. An attempt is `measured`, `partial` (a total without a breakdown) or `unknown`. A total built from incomplete coverage says so, and clients render it as a lower bound ("≥ 1.2M · 2 of 3 attempts measured"). A missing reading is never shown as zero.
- Keep token counts and quota percentages separate. Tokens describe work volume. Quota percentage describes subscription cost. Following the dispatcher design, tokens are not a universal cost or quality measure, and pacer does not convert one into the other.
- Never read or copy credentials (P5). Usage comes only from the executor's own output, the run log pacer already writes, or a provider usage adapter. Prompt text and model output are never copied into the usage record.
- All protocol changes are additive (P4).

Out of scope:

- Converting tokens into money. A price table can come later as a plugin, and it would be clearly labelled as an estimate.
- Measuring tokens used inside a planner session that are not tied to a pacer root task.
- Changing routing behavior. Learning may read these numbers later under the dispatcher design's rules, which is a separate change.

## Approach

Three options were considered:

1. **Scrape plain-text logs.** No launcher changes, but most executors print no usage in text mode, and parsing human-readable output breaks whenever the CLI wording changes.
2. **Structured executor output plus a usage extractor per executor (selected).** Run each executor with its machine-readable output mode where one exists. Each executor gets an extractor that reads the attempt's log after it exits and returns a normalized usage record. Plain-text scraping stays only as a labelled `partial` fallback (the Codex total line).
3. **Provider usage APIs.** Accurate where they exist, but they are account-level and cannot be split per attempt on a shared account. That is exactly the problem `usagePools` already reports.

The selected design follows the observation-adapter pattern from the dispatcher and idle-usage-refresh designs. A **token extractor** is a capability of the executor's adapter, not a branch in the service. The supervisor calls it once an attempt has ended, before the task result is written.

Executor launchers are not yet plugins, so the first extractors are built in next to their launchers in `src/exec/`. Under P13, the extractor contract is defined as a plugin-protocol capability (`usage.extract`, versioned and generated under P14) in the same slice that extracts an executor's launcher into a plugin. From then on the host never falls back to a built-in extractor for that executor.

## Domain model

An attempt gains an optional `tokens` field:

```ts
interface AttemptTokens {
  coverage: "measured" | "partial" | "unknown";
  input: number | null;        // fresh input tokens, excluding cached reads
  cacheRead: number | null;    // cached input read, where reported
  cacheWrite: number | null;   // cache creation, where reported (billed differently from reads)
  output: number | null;       // including reasoning tokens
  reasoning: number | null;    // subset of output, where reported
  total: number | null;        // as the provider reports it, never computed from nulls
  turns: number | null;        // model requests made during the attempt, where reported
  source: "executor-json" | "executor-text" | "endpoint-response" | "adapter";
  selfReported: boolean;       // true when the number came from stdout that repository code could also write
  extractor: string;           // e.g. "codex-jsonl@1"
  capturedAt: number;          // epoch seconds
  note?: string;               // why coverage is partial or unknown
}
```

Rules:

- `total` uses the provider's own total when it reports one. When it does not, the extractor sums the reported parts and marks the record `measured` only if every part is known.
- An attempt that ends early (killed, timed out, out of quota) keeps the usage reported up to that point, marked `partial` with a note.
- An attempt with an empty or unreadable log is `unknown` with a note.
- Interactive takeovers (live sessions) are measured only if the executor reports usage for the resumed session. Otherwise they are `unknown`.

## Extraction per executor

What each CLI emits must be confirmed against the installed version during implementation planning. A row marked "to verify" is a working assumption, not a verified fact.

| Executor | Launch change | Source | Coverage |
| --- | --- | --- | --- |
| Codex | Add `--json` (JSONL events) and keep `-o` for the last message | Token-count events; the last cumulative value wins | measured (to verify field names) |
| Codex, existing logs and remote | none | The "tokens used" total, accepted only as the final trailer after the process exited; any earlier occurrence is ignored | partial (total only), `selfReported` |
| Claude Code (executor) | none locally; remote keeps text | Usage on the final `result` event of `stream-json` | measured locally; unknown on remote until remote can use stream-json |
| OpenCode / endpoints | Add `--format json` | Token counts on step-finish events, summed over steps (to verify) | measured |
| Cursor | Switch to `--output-format stream-json` if it reports usage (to verify) | Usage event, if any | measured or unknown |
| Antigravity | none until a structured mode exists | — | unknown |
| Local model (OpenAI-compatible) | none | `usage` from the endpoint response, if the runner relays it | measured or unknown |

Changing an output mode changes what the live log view and the plain-log renderer receive. Both must keep rendering readable progress: the existing stream-json handling for Claude is the model. Each launcher change is its own delivery slice, with fixture tests for the log renderer.

## Planner attribution

Planner tokens are what makes "ran outside the planner" meaningful, so the Insights screen shows them. They are the hardest to measure, because the planner's session belongs to the planner tool, not to pacer.

The proposal is a planner usage hook. The planner integrations pacer installs (status line, hooks, MCP) already report the planner's quota-percentage observations. Where the planner exposes a cumulative token counter for its session, pacer records a counter snapshot whenever the planner:

- calls a delegate or work operation (opens or extends a root task), or
- calls a review operation (closes it).

The difference between consecutive snapshots, within the same planner session, is attributed to the root task that call touched. If several root tasks are open in one session, the difference is split evenly between them and marked `partial` with a note.

Tokens used by a model-backed decision engine (classification or routing calls) are recorded as their own `decision` bucket on the root task. They are not part of any executor's share and not part of the planner's. The built-in rules engine uses no tokens and records nothing.

Until a planner adapter supports this, planner tokens are `unknown`. Clients then show "Planner: not measured" instead of hiding the row. Whether pacer may read a planner's session transcript to get these counters is an open decision (see below). It is not assumed.

## Roll-up

- **Node:** the sum over the node's own attempts, with counts of measured, partial and unknown attempts.
- **Root task:** the sum over every node in the tree, including the root's own attempts, plus planner and decision-engine attribution. Each attempt is counted once, because it belongs to exactly one node. Child totals are never added on top of a parent's own total.
- **Missing task records:** a node whose task record cannot be read still contributes its rows from `attempt_usage`. If it has none, it counts as one `unknown` attempt, so the root total is flagged as a lower bound.
- **Tasks without a work node:** a task delegated before work trees existed, or outside them, is its own root task.
- **Spread:** per root task, the totals grouped by executor (runner id, shown as the agent name), account and model. This is what the token-spread bars render.
- **Coverage:** every aggregate carries `measuredAttempts`, `partialAttempts` and `unknownAttempts`. A total is a lower bound whenever `unknownAttempts > 0`.

`workTotals` gains a `tokens` block next to `usagePools`. Quota percentages and tokens stay in separate fields. The work-tree projection adds `tokens` to its attempt allow-list.

## Storage

- The `tokens` field is stored with the attempt in the task record, so task detail and work trees need no join.
- A new `attempt_usage` table in the dispatch SQLite database indexes the same numbers so the Insights queries do not scan task files. Its key is `(task_id, attempt)`, where `attempt` is the 1-based index `work_decisions` already uses. It also stores `root_id`, `executor`, `account`, `model`, `extractor`, `ended_at`, and these fields copied from the task: `kind` (from `routing.kind`), `repo_key`, `outcome` and `ladder_rule` (from `routing.rule`).
- The write happens in the same transaction that writes the attempt. Writes are idempotent upserts. A newer extractor version may re-extract and replace a row, but it never replaces a `measured` row with a lower coverage.
- **Backfill.** A migration fills in existing tasks from their logs: Codex trailer totals become `partial`, and Claude stream-json becomes `measured`. Tasks that retention already archived are read from the gzipped log at `archivePath`, or marked `unknown` with a note if that is not possible. The migration is idempotent and writes only `attempt_usage`, never task files.
- **Root usage.** Planner and decision-engine tokens are not executor attempts, so they go in a separate `root_usage` table. Its key is `(root_id, source, ref_id)`, where `source` is `planner` or `decision`, and `ref_id` is the planner snapshot pair or the decision-call id. It has the same coverage and provenance fields as `AttemptTokens`, plus `at`, and it is indexed by `at` for `insights.summary`. Root totals read it together with `attempt_usage`.
- **One read path.** Task detail and the work tree take an attempt's `tokens` from `attempt_usage` when the task record has none, so backfilled history shows the same numbers in every view.
- Task retention archives logs and artifacts (gzip into `archive/`, restorable) but keeps task records. It never touches `attempt_usage` rows. They are small and contain no prompt or output text. A separate retention setting can prune them later.

## API and protocol

All changes are additive (P4):

- `Attempt.tokens` (optional) in task and work-tree results.
- `totals.tokens` in work-tree results: `{ total, input, cacheRead, cacheWrite, output, measuredAttempts, partialAttempts, unknownAttempts, byExecutor: [...], planner: {...}, decision: {...} }`.
- A new read operation, `insights.summary`, with `{ from, to, repo?, bucket: "day" | "week" }` as input. It returns:
  - root tasks handled, subtasks spawned, attempts and retries,
  - token totals with coverage,
  - the spread per executor (tasks, attempts, tokens, share, tokens per task, acceptance rate),
  - a daily series per executor,
  - counts of task kind by executor,
  - counts per ladder rule from `routing.rule`, and skip reasons from `routing.skipped`.

  The operation needs only the normal read scope, and its numbers come from the index table.
- Clients refetch on the existing task and work events. No new event is needed for the first slice.

Definitions the API documents, so every client counts the same way:

- **Root task:** a work node with no parent, or a task with no work node.
- **Handled in a period:** the task's first settle time falls within the period. A later retry does not count it again. `settledAt` is overwritten whenever a task settles again, so the index stores `first_settled_at`, set once when a task first settles. The backfill uses `settledAt` for tasks that have only settled once, and the earliest attempt's `endedAt` for the others.
- **Retry child:** a child node created to re-run a failed or rejected sibling's goal, rather than to do a new part of the work.
- **Accepted first try:** accepted at review with a single attempt and no retry child.
- **Share and "ran outside the planner":** token volume ratios only. Token counts from different providers are not comparable costs, so these are never presented as savings, and are always shown next to their coverage. "Ran outside the planner" is shown only when planner coverage is not `unknown`. The split among executors does not depend on planner coverage.

## Security and privacy

- Extractors read only the attempt log pacer wrote (mode 0600) and parse numeric usage fields. They never store message content, prompts, file paths from tool calls, or endpoint keys.
- Extractor input is untrusted (executor output can be manipulated by repository content). Extractors must:
  - parse strictly,
  - cap line length and the number of events,
  - reject negative, non-integer or absurdly large values (above 10⁹ per attempt), recording `unknown` with a note instead,
  - never execute or evaluate anything they read.
- Numbers taken from plain stdout are marked `selfReported`, because tests or scripts in the repository could print a fake usage line. Clients show self-reported totals with that label.
- A changed launcher argv is reviewed under the security rule like any subprocess change.

## Validation

- A fixture log per executor and output mode under `test/fixtures/`, using temp-dir paths: a complete run, a killed run, a malformed or oversized line, and a version with renamed fields. Each fixture asserts the normalized record and its coverage.
- Roll-up tests: a three-level tree with retries in which some attempts are `unknown`, asserting no double counting, the correct lower-bound flags, and correct grouping per executor.
- Migration test on a copy of a sandbox `PACER_HOME`, never the real one: an idempotent backfill that leaves task files unchanged.
- Protocol freshness (P11) and backward compatibility: older clients ignore the new fields.
- Live validation (CT-11): delegate a real Codex task, and one that the planner splits across two executors, through `bun run live`. Confirm that task detail, the work tree and `insights.summary` report matching totals. Any executor not exercised live is reported as UNVERIFIED.

## Delivery slices

1. Domain type, extractor contract and the `attempt_usage` table, with the Codex text-total extractor (`partial`) and the Claude stream-json extractor (`measured`), plus the backfill migration.
2. Roll-up in `workTotals` and `Attempt.tokens` in the API. Task detail shows a token split per agent.
3. `insights.summary`, then the Insights screen and the Dispatch "where the tokens went" summary in the app.
4. Codex `--json` launcher change and extractor, with the live-log renderer updated.
5. OpenCode `--format json`, then Cursor once its usage events are verified.
6. Planner attribution, after the open decision below is settled.

Every slice that changes user-visible behavior updates the affected `docs/*.md` pages and `CHANGELOG.md`, and regenerates the protocol docs.

Each slice is useful alone: slice 1 already gives real (partial) numbers for most of the existing task history, because almost all of it ran on Codex.

## Open decisions

- **Planner counters.** May a planner adapter read the planner's own session transcript or local usage file to get cumulative token counters? Reading only numeric usage from a file the planner writes is not reading credentials. But it does touch user data outside pacer's home, so the maintainer should decide, and record it in `.project/decisions.md`.
- **Multiple open root tasks in one planner session.** The proposal splits the difference evenly and marks it `partial`. The alternative is to attribute it only to the most recently touched root task.
- **Usage-index retention.** Keep forever, or follow a separate setting (proposed default: 365 days).
- **Cached input in totals.** Proposed: show cache reads and cache writes separately and leave them out of the headline total. This needs the maintainer's confirmation, because some CLIs fold cached tokens into their total.
- **Planner usage source.** The planner integrations already report quota-percentage observations through the status line. Whether any of them exposes a cumulative token counter is not yet verified.

## Assistant usage

The [always-on assistant](2026-10-28-always-on-assistant-design.md) records each turn's usage in its own `assistant_usage` table, outside any root task, with the same `measured`, `partial` or `unknown` coverage. It is never added to executor or planner work. Clearing assistant history deletes the text and keeps these rows.
