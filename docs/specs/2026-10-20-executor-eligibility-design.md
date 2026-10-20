# Executor eligibility from timestamped evidence

Status: Approved by the maintainer on 2026-10-20; implementation plan pending review.
Issue: [#213](https://github.com/lamtuanvu/pacer/issues/213).

## Intent and agreed policy

Pacer must distinguish whether an executor can run from how desirable its
budget is to spend. Routing, guards, delegation and presentation must use
the same decision, including the evidence age and reasons for uncertainty.

The maintainer selected automatic uncertain fallbacks, explicitly labelled.
Confirmed eligible executors come first. An uncertain fallback remains
uncertain when selected or launched. Guards allow local work unless there
is a confirmed eligible alternative. Explicitly selecting an executor does
not override an ineligible decision.

Valid exhaustion with `allow_paid: false` prohibits a launch regardless of
available credits. Unknown spending risk is reported as unknown; the
fallback policy authorizes an uncertain attempt, not a change to
`allow_paid`. Pacer cannot enforce spending controls on independently
launched or already-running native sessions.

## Findings in the current implementation

- `src/usage/codex.ts` selects the first usable file by modification time
  and uses that time as `capturedAt`, including for relative reset times.
  Its cursor retains quota values without their event timestamps.
- `src/remote/usage.ts` likewise uses log modification time, then compares
  it against local observation time when selecting an account reading.
- `src/usage/freshness.ts` exempts near-limit and exhausted observations
  from ordinary age limits until the predicted reset.
- `src/engine/verdict.ts` turns a passed reset into zero usage without
  observing the replacement window.
- `src/usage/byteplus.ts` represents a missing subscription as an error
  with no windows. `computeStatus` does not turn that into availability
  evidence, and ranking retains UNKNOWN candidates.
- `src/guard/guard.ts` blocks based on a nonempty ranked list.
- `src/tasks/runner.ts`, queue draining, API capacity and view-model helpers
  independently apply restrictions or interpret verdicts.
- Authentication recovery currently clears restrictions on a newly read
  successful result without comparing its underlying observation time.

These are source inspection findings. Historical provider incidents in
the issue have not been independently reproduced against live accounts.
The existing Codex, freshness, guard and ranking suites pass 37 tests;
several assertions explicitly encode behavior this issue changes.

## Options and recommendation

1. **Shared evidence and eligibility evaluator (recommended).** Normalize
   adapter facts, reconcile them centrally, and expose one decision to
   every consumer. This addresses the issue across providers while
   retaining pacing and existing API fields.
2. **Repair each consumer separately.** Smaller individual edits, but
   availability, freshness and spending rules would still diverge.
3. **Introduce a general event-sourced policy service.** Could preserve a
   comprehensive audit history, but adds storage and migration work beyond
   the account evidence and restrictions needed here.

Use option 1, with narrowly scoped persistence where reconciliation must
survive service restarts or concurrent processes.

## Evidence contract

Add normalized evidence types alongside existing usage types. Each fact
has a stable reference, account identity, optional runner/model/host scope,
source, observation time, validity deadline and reason. Unknown times are
null, never filled from file or cache activity.

Keep availability (`ready`, `unavailable`, `unknown`), quota windows and
spending signals separate. Preserve credit availability, balance and any
explicit paid-consumption indicator with their actual semantics. A credit
balance alone does not establish paid consumption or permission to spend.

Account facts are evaluated once and shared by applicable runners.
Runner installation, model support, host readiness and explicit blocks
retain their narrower scopes. One model's healthy reading cannot clear
another model's restriction.

Codex local and remote readers retain the enclosing quota event timestamp.
Relative reset durations use that timestamp only. File timestamps are
discovery/cursor hints. Select observations by event time across candidate
files and within files; cache the newest validated observation so that an
older discovery result cannot replace it. Discovery limits must be
documented and must not imply that an undiscovered newer event was read.
Legacy cursor/cache values without trustworthy event times are uncertain
until reread; do not silently migrate modification times as evidence.

A provider CLI response may use request observation time only when its
documented contract reports current state. Cache reads keep the original
observation time. Transient errors are recorded separately from retained
historical facts. Malformed subscription responses are uncertain; only
an explicit, valid response establishing no subscription is unavailable.

## Reconciliation and freshness

Reconcile each fact by its applicable scope and observed time. A newer
compatible observation supersedes older evidence, even if its quota
usage is lower or its reset date differs. Fetch time never wins.

For equal-time facts, authoritative provider responses take precedence
over passive logs for the same fact. Local and remote copies of the same
event have equal authority. Contradictory equal-authority evidence remains
conflicting; source order must not choose a convenient value.
Execution outcomes establish the fact actually observed: successful
execution proves execution was possible at that time, not remaining quota
or absence of paid consumption.

Retain the current bounded quota ages initially: two hours for windows
of six hours or less, 24 hours for longer windows. Apply those bounds at
all usage percentages. A window ceases to be current at the earlier of
its age deadline and reset deadline. Missing, invalid or future observation
times cannot establish current budget.

Historical usage/reset values remain available as evidence. Expiry does
not manufacture zero usage or a future reset. Evaluate every applicable
limiting window; a fresh weekly window does not hide an expired short
window. Reactive and unmetered accounts follow their declared contracts
and do not require invented quota windows.

Provider availability failures have bounded validity; explicit user
blocks and disabled configuration remain effective until changed or their
configured deadline passes. Budget and authentication restrictions clear
only from newer evidence that actually addresses the restricted fact.
Use existing cooldown policy for execution-derived restrictions, bounded
by applicable evidence expiry and any reported reset.

Persist reconciled facts and restriction revisions with atomic writes,
restrictive permissions and the repository's locking conventions. Compare
observed time under the lock so concurrent refreshes cannot regress state.

## Core decision and ranking

The core evaluator returns `eligible`, `uncertain` or `ineligible`,
structured reason codes, supporting evidence references, evaluation time,
evidence age and next validity boundary. Availability, budget and spending
assessments remain inspectable separately.

Decision precedence:

1. Explicit prohibitions or valid unavailability make a runner ineligible.
2. Valid exhausted budget with paid execution forbidden is ineligible.
3. Missing, expired or conflicting required facts make it uncertain.
4. Availability and applicable budget/spending contracts permitting
   execution make it eligible.

Pacing only orders candidates within eligibility groups. Apply this to
global routing and per-project executor order, keeping configured order
within each group. Automatic uncertain fallbacks follow eligible choices
and carry an explicit explanation. Ineligible choices are excluded.
Hooks may narrow candidates but cannot override eligibility.

Preserve existing `ranked` and `excluded` fields and their shapes
additively. Add decisions and an explicit uncertain-fallback grouping or
marker. Existing ranked entries remain candidates, including fallbacks;
they do not acquire a new implicit guarantee of confirmed eligibility.
The guard selects the first eligible candidate, never simply index zero.

## Refresh and launch

Expose refresh capability per adapter: supported provider command,
passive log reread, or unavailable. Bypass each applicable cache on
preflight refresh, not merely the outer account cache. Re-reading an
unchanged log does not renew evidence. Refresh failure preserves
uncertainty and the diagnostic reason.

Route, task detail, queue draining and delegation share candidate
selection and fallback semantics. Before an actual new attempt, refresh
expired required evidence where supported, then re-evaluate using the
current clock, account policy and restrictions.

Do external reads outside slot/policy locks. Under the existing launch
reservation locks, verify policy and evidence revisions and restrictions;
retry selection if they changed. Recheck the decision's validity boundary
at dispatch. Do not hold a lock while a provider command runs.

Revalidation governs new launches. Resuming observation of an already
running attempt must not launch a duplicate or pretend the new policy
retroactively controlled that process.

Record the selected decision, evidence references and fallback reason in
the task routing/attempt data. Authentication/subscription failures update
availability; quota failures update budget; unrelated task failures update
neither. Unknown eligibility must not be reported as confirmed exhaustion
when no task launches.

## Presentation and compatibility

Expose the same decision through status, account/runner summaries, route,
task results and API snapshots. Retain existing pacing verdict fields as
pacing/history data. Add fields without removing or renaming protocol
fields, and regenerate protocol documentation.

Shared view-model vocabulary owns the labels and explanations for
eligibility, freshness and fallback use. CLI budget text, TUI, web/tray
and desktop-rendered views consume those descriptors. Historical quota
must be visibly historical, with observation age and reason; do not label
UNKNOWN evidence as confirmed available or unavailable.

No new native credentials access, refresh API invention, account login
flow or installation behavior is required.

## Validation and delivery

Tests cover all reported failure classes with normalized fixtures:
event time versus unrelated writes; out-of-order local/remote observations;
cache refresh and missing timestamps; stale near-limit/exhausted data;
early window changes and passed reset deadlines; multiple limiting
windows; explicit missing subscriptions versus transient read failures;
all-uncertain guards; mixed eligible/uncertain candidate ordering; credits
with paid execution forbidden; preflight races and refresh failures;
execution outcome classification and recovery; account/model scope.

Run focused regressions, `bun run typecheck`, `bun run test`,
`bun run build`, `bun run ui:check`, generated-artifact checks and
app build when its inputs change. Current local baseline ran on Bun
1.3.14, below the declared 1.4.2 minimum; supported-runtime validation
remains outstanding.

Use `bun run live` with disposable state and repository. Exercise
CLI/API, guards, real local delegation, TUI, web/tray and affected desktop
presentation. Record behavior/surface verdicts and task IDs in the harness
report, preserve evidence with `down --keep`, and report any unavailable
surface as UNVERIFIED. Remote live execution requires separate maintainer
authorization.

Update routing/account documentation and CHANGELOG, and record the
durable choice in an ADR. Use the explicit AGENTS.md numbered ADR naming
convention while OD-2 remains unresolved.

Before completion, provide implementer UI compliance and independent UI
and QA evidence reports identifying the reviewed revision, checks and
unverified behavior. Review changes and tests with the maintainer.
Do not push or reinstall the installed CLI without explicit approval.

## Governance references

Follow `.project/constitution.md`, `.project/context.md` and
`.project/decisions.md`. Applicable rule files are architecture,
api-protocol, security, code-and-testing, repository and ui under
`.project/rules/`.

Key requirements: ARCH-1–5/7–9; API-1–5; SEC-1/2/5/6/7;
CT-1–6/11; REPO-1–7; UI-1–4/6/8–25 where applicable.
Constitution amendment 0.4.0 records UI evidence requirements as adopted
despite stale proposal labels in some index/rule files. No amendments or
exceptions are proposed here.

Applicable reviewer definitions under `.project/reviewers/` are
architecture, protocol-compat, security, qa and ui-accessibility.
Implementation plans and review evidence remain under untracked `.work/`.
