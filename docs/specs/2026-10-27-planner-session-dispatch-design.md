# Planner session dispatch

Date: 2026-10-27
Status: Approved by the maintainer in conversation on 2026-10-27, including planner-account certification and its recurring probe cost. Reviewed once by an independent builder check on 2026-10-27; its findings are folded in. Implementation and governance adoption remain separate. Extends [intelligent work dispatcher](2026-10-24-intelligent-work-dispatcher-design.md) and [managed delegation enforcement](2026-10-27-managed-delegation-enforcement-design.md). No runtime behavior changes until approved and implemented.

## Intent

Managed delegation enforcement closed the executor side: an executor Pacer launches in strict mode cannot create untracked children through its native subagent entry points. The planner's own interactive session was left outside that guarantee. It is the one session a person actually talks to, and it is where most work starts.

Today that session is governed by the delegation guard, which decides from the planner's budget verdict and the subagent's type name. It never consults the dispatcher. When the planner account is behind pace the guard allows every native subagent unconditionally, so the work neither reaches the decision engine nor appears in the work tree.

This design brings the planner session under the same rule as every executor: **execution work is launched by Pacer as a managed task, whichever account ends up running it — including the planner's own.** Pacer selects the executor from the model inventory on capability fit, learned outcomes and capacity. The planner account becomes an ordinary candidate protected by an explicit reserve, as the dispatcher design already anticipated ("optional account reserves remain explicit strategy settings rather than blanket exclusion").

## Guarantee

For a session Pacer has installed its planner guard into, a native subagent call that would perform execution work is denied. The planner obtains execution through `pacer delegate` (or `dispatch.submit`), and the service authorizes, selects, launches, records and reviews the resulting task. This holds regardless of the planner account's budget verdict or pacing mode.

The guarantee covers the certified native subagent entry points for the installed agent version, on the same terms and with the same stated limits as managed delegation enforcement. It is not a process-level boundary: a planner can still edit files directly with its ordinary file and shell tools, and this design does not attempt to intercept that. Pacer must say so plainly wherever it reports planner enforcement, and must not present the guard as control over all planner execution.

**Agent scope.** The guarantee is claimed for `claude-code` planner sessions only. `GUARD_PLANNERS` also covers `codex` and `cursor`, and the planner hook is installed for both, but the enforcement spec records that Codex's hook invocation is unproven for the installed version and that Cursor's `subagentStart` may only report after the child is created. Claiming a denial that does not prevent the child would violate the honesty requirement above. Codex and Cursor planner sessions keep today's guard behavior unchanged, and status and `doctor` report planner enforcement for them as UNVERIFIED with the reason. Extending the guarantee to either requires its own probe, as in the enforcement spec's adapter order.

## Goals

- Every native subagent call for execution work in the planner session is denied and redirected to managed delegation.
- The planner account is a first-class dispatch candidate, selected or rejected by the same decision engine as any executor.
- Selection is made on declared capability (tier, tools, context), declared and learned task fit, and measured capacity — not on the planner's pacing mode.
- An explicit reserve protects the planner's interactive capacity from work the planner itself executes.
- Every decision, allow or deny, is recorded with the candidates considered and the reason, and is inspectable in the CLI and the Dispatcher UI.

## Non-goals

- Intercepting direct edits. The guard sees `Agent`/`Task`; file and shell tools stay untouched.
- Replacing the ladder engine, the observation adapters or the review flow.
- Certifying the planner's host beyond what the managed delegation enforcement probe already establishes.
- Changing human acceptance or merge authority.

## Anti-goals

These would make the change a failure even if it worked as written.

- **A planner that cannot think.** Read-only helpers — exploration, planning, review and analysis agents — must stay instant and in-process. Routing them through task creation would make the planner unusable.
- **A dispatcher in the conversation's critical path.** The guard runs inside a synchronous pre-tool hook. If a decision cannot be reached inside its deadline it must fail open with a recorded reason, never hang and never block the session on service availability.
- **Starving the conversation.** If planner-executed tasks can consume the interactive window, the person loses the session they are using. The reserve is an admission-time boundary with real exclusion power, not a ranking hint. It is honestly bounded: see "Reserve" below for what it does not promise.
- **Silent routing.** A person who disagrees with a denial must be able to see which candidates were considered, why one won, and how to override, without reading logs.

## Current state

| Layer | File | Behavior today |
|---|---|---|
| Planner guard | `src/guard/guard.ts` | Allows on `mode === "relaxed"` or no eligible alternative; otherwise denies by `subagentType` allow-list. Never builds candidates. |
| Executor ranking | `src/engine/rank.ts` | Excludes the planner runner unless `includePlanner`. `score()` reads only pacing deltas; its `TIER` map is a billing class, not a capability tier. |
| Decision engine | `src/dispatch/`, `src/core/dispatch.ts` | Full ladder over tier, tools, context, strengths, headroom, burn, cost and learned fit. Reached only through `pacer delegate` and `dispatch.*`. |

`includePlanner` is already passed for scoped child delegation and conversation-mode tasks, so Pacer can already launch the planner's agent as an executor. The missing piece is the planner's own session, not the launch path.

Two configuration facts shape the rollout. In a strategy that declares no `models:`, every model record is `tier: "unknown"` with empty `strengths`, and `dispatch.learning.enabled` defaults to false. The ladder's `task-fit` factor is then a constant and selection reduces to spare capacity. A dispatcher that selects on fit requires a populated inventory; shipping the control change without it would deliver quota routing under a new name.

## Approaches

1. **Keep the budget gate, tighten its thresholds.** Smallest change, but it preserves the category error: a pacing verdict is not a judgment about which model should do the work, and the planner can never be a deliberate choice.
2. **Guard allows the native subagent but records a routing decision (rejected by the maintainer, 2026-10-27).** Cheap and non-disruptive, and the decision would be explainable. Rejected because the work still runs outside the work tree: no attempt record, no reserve accounting, no review, no lineage. "Pacer decided" is not the same as "Pacer launched".
3. **Deny execution subagents in the planner session; route everything through managed work, with the planner account as a candidate (selected).** Gives one execution path for planner and executors alike and reuses the existing enforcement, work-tree and review machinery. Costs a round trip for work the planner would previously have done in-process, and requires the planner account to be launchable as an executor under a reserve.

## Service contract

### Guard decision

`decideGuard` stops reading `status.mode`. The order becomes:

1. Executor session, or `PACER=off` — allow, unchanged. Executor sessions remain governed by managed delegation enforcement.
2. The requested type is a **read-only helper** — allow. This list is narrowed from today's `ALLOW_TYPES` and is matched against a declared capability rather than a name substring where the adapter can supply one; see "Left to the builder".
3. Otherwise the call is execution work — **deny**, with a reason carrying the routed recommendation.

Today's `"<provider>-executor"` allow branch is removed. It is an execution-work allowance outside the guarantee, and a deliberately named executor-launching subagent is exactly the call this design exists to route. Existing agent sets that rely on it will start receiving denials; that belongs in the release note.

**The classifier keeps its decision point, with a changed question.** Today `activeHooks.guard` can only return an allow, which under the new order would punch a hole straight through the guarantee. It is repurposed instead: it answers branch 2 — *is this read-only helper work?* — which is the judgment the dispatcher spec wanted from it and which name matching does badly. It can move a call from branch 3 to branch 2; it can never allow work it has classified as execution. `guard_feedback`, the ground-truth records and the feedback instruction in the denial reason all survive unchanged, and `classifier` remains a recorded verdict source alongside the branch.

The denial reason is produced from a real `previewDispatch` for the brief Pacer can infer from the hook payload (prompt, repository from the hook's `cwd`, task kind and difficulty from the classifier when configured). It names the selected runner, the resolved model, the winning step and its reason, and gives the exact `pacer delegate` invocation. When the selected candidate is the planner's own account, the reason says so and still requires `pacer delegate`: the task must be managed, and the point of the denial is the work tree, not the account.

**The decision runs in-process, in the guard's own short-lived CLI process**, as `plannerSessionStatus` and `activeHooks` already do. It does not call the service. The guarantee must not depend on a running service: routing every planner decision through RPC would make the fallback-allow path the normal case for anyone who does not keep the service up, which is the same abstention this design exists to remove. The decision record is written directly to the dispatch store under a record shape for a decision with no task or attempt, sharing the store's retention. Concurrent short-lived writers are expected and covered by the store's existing locking.

The guard never blocks on the engine. Preview runs under a deadline strictly below the hook timeout; on timeout, no-match or any error it returns **allow** with `source: "fallback"` and a recorded cause. Enforcement for the planner session is cooperative by construction — the planner can always ignore a denial by using its file tools — so failing open costs visibility, while failing closed costs the session.

### Planner as a candidate

**Entering the pool.** `includePlanner` only lifts the exclusion *inside* `rankExecutors`; the pool itself comes from `executorsFor(kind, s)`, and the starter strategy builds that list as "every provider except the selected planner" (`src/install/init.ts`), as do per-project `selection.executors`. Lifting the rank-level exclusion is therefore not sufficient, and injecting the planner into every pool regardless of what the person wrote would silently override explicit `executors:` lists and project overrides — the "silent routing" anti-goal. So: **the planner enters the pool only by being listed in a routing rule or project selection, like any other runner.** `pacer setup` and the starter template add it; an existing strategy does not gain it until migrated. Upgraded installs therefore see the denial behavior but no planner candidacy until they opt in, and `doctor` says exactly that.

**The `planner_executes` flag is a per-call-site parameter, not a gate inside `rankExecutors`.** A new strategy setting `pacing.planner_executes` (default `true`) governs the delegate and guard paths only. Reading it inside `rankExecutors` would also kill conversation-mode task launches and `allowDelegation` child routing, which pass `includePlanner` today (`src/tasks/runner.ts`, `src/tasks/drain.ts`, `src/core/routing.ts`, `src/dispatch/runtime.ts`) and are not in scope here. Regression tests must assert that `planner_executes: false` leaves those four call sites working.

**Inventory.** The planner runner contributes its declared models like any other runner. A planner account with no `models:` block yields one `executor-default` record at `tier: "unknown"`, which a capacity step can still select but which can never satisfy a `min_tier` requirement.

**Reserve.** `pacing.planner_reserve` is a pace multiplier (`paceScale: 1 - plannerReserve / 100`) and keeps that meaning untouched. Overloading one key with two semantics — a pace scale and a headroom floor — would make both the config schema and the UI lie, so this is a **new setting, `pacing.planner_reserve_headroom`, default 25**. A planner candidate is ineligible when measured headroom in any planner quota window carrying a `usedPct` is at or below it, after the dispatch `reservePct`. A window with unknown headroom does not satisfy the reserve: unknown capacity cannot count as satisfied, consistent with the dispatcher spec's hard-eligibility rule. The exclusion carries its own reason so preview shows "planner reserve" rather than a generic capacity message, and it applies to planner-executed *tasks* only — never to the interactive session.

What the reserve does **not** promise: it is checked at admission, so a long planner-executed task plus heavy interactive use can still cross the boundary mid-flight. Estimated demand is not measurable here, and the dispatcher spec already concedes this. Pacer must word the setting, its `doctor` line and its UI as an admission boundary plus `max_tasks`, not as a guarantee that the window never drops below it. In-flight accounting and mid-flight stop are deliberately out of scope; if they are wanted later they touch `src/engine/slots.ts` and the task runner and deserve their own design.

**Concurrency.** Planner-executed tasks consume a slot on the planner runner like any other runner, honoring `max_tasks`.

### Pacing mode

`plannerMode` stays, and keeps its role in status display, the session-start briefing and advisory text. It leaves the guard entirely. Capacity reaches the decision through candidate `headroom` and `burn`, which the ladder already ranks, so a planner with spare quota wins on measured headroom rather than by bypassing the decision.

### Recording

Every guard outcome — allow, deny or fallback — is recorded with the decision request id, the candidates considered, the selected candidate, the step and reason, and the branch that produced it. The existing `guard_verdict` label gains the branch (`read-only-helper`, `routed`, `fallback`, `executor-session`, `disabled`) so an allow can be told apart from an abstention without re-running the guard. Decisions reached through preview are stored with the dispatch decision record so the Dispatcher UI can show planner-session routing beside executor routing. Prompts are summarized, never stored in full, consistent with the enforcement spec's logging limits.

### Inventory and learning

The control change ships together with a populated inventory, or it does not ship:

- The starter strategy and `pacer setup` gain a `models:` block per runner with declared `tier` and `strengths`, including the planner account.
- **Existing strategies are never rewritten.** A migration that guesses tiers into a person's own config would be Pacer deciding model quality on their behalf, which the dispatcher spec explicitly disclaims ("technical model metadata does not establish model quality"). `pacer doctor` reports "dispatcher selecting on capacity only: no model tiers declared" with the fix and an explicit command to write a starter block; the person runs it.
- Consequently an upgraded install gets the denial and redirect behavior, but capacity-only selection and no planner candidacy, until it opts in. That is the honest state and `doctor`, `status` and the Dispatcher UI must show it rather than implying fit-based routing is active.
- `dispatch.learning.enabled` defaults to true. It already refuses to influence ranking below `minSamples` comparable reviews, so the default is inert until evidence exists.

## Certifying the planner account

**Decided by the maintainer on 2026-10-27: enforcement certification applies to the planner account unchanged, including the recurring probe.** Managed delegation enforcement is non-waivable by its own terms, a planner-executed task is a Pacer-launched headless `claude-code` executor, and `previewDispatch` already calls `enforcementExclusion` for every ranked runner under a strict root. The planner account is certified like any other runner. No amendment to the enforcement spec is sought.

Three accepted consequences:

1. The probe spends the planner account's own quota — the account the person converses with — and the certificate expires after at most 24 hours, so this recurs.
2. The certificate fingerprint includes the identity of the account's `settings.json`. Pacer writes that file during install and people edit it; every such change invalidates the certificate.
3. `probeSupportReason` returns unsupported when any project-level control file exists in the repository. `.claude/settings.local.json` is common and present in this repository, so planner candidacy is excluded here until that changes. This is reported, not worked around.

### Probe scheduling

Certification is manual today: `dispatch.enforcement.probe` starts an `enforcement.probe` job and nothing schedules it. Recurring certification needs a trigger policy, and the policy is mostly about **when not to probe**.

- **Never from the guard.** The guard runs on a deadline and fails open; it reads certificate state and never causes a probe. A planner candidate excluded for an expired certificate is excluded with that reason, and the probe happens out of band.
- **Scheduled as a job**, reusing the existing `enforcement.probe` kind and the job daemon. It runs only when all of these hold: `planner_executes` is true; the planner runner is listed in a routing rule or project selection, so candidacy is actually reachable; `probeSupportReason` returns null for the target and repository; and `certificateStatus` is `uncertified` or `stale`.
- **Never spend the quota being protected.** No probe while the planner's measured headroom is at or below `planner_reserve_headroom`. A reserve that is defended by burning the reserve is not a reserve.
- **Never silently.** The enforcement spec already requires setup to report probe cost before running. That extends to scheduling: a new `pacing.planner_probe` setting takes `ask` (default), `auto` or `off`. On `ask`, the first probe for an account requests consent once and records it; later probes within the ceiling are automatic. On `off`, the planner is simply never a candidate, and status says why.
- **Bounded.** At most one successful probe per certificate lifetime per certificate key, with exponential backoff on failure and a hard ceiling per account per day. Repeated failures stop scheduling and surface a reason instead of retrying.
- **Repository-sensitive.** The certificate key is `(runner, account, launchMode)`, but the fingerprint includes the identity of the repository's control files, so moving between repositories invalidates it in practice. The scheduler treats the active repository as part of the trigger and must not thrash between two repositories; when it would, it stops and reports rather than probing repeatedly.
- **Measured.** Each probe records its observed account usage delta alongside the certificate, so the real recurring cost is visible rather than estimated. A probe whose measured cost exceeds a configured ceiling backs off and reports.

Visibility: `pacer status`, `doctor` and the Dispatcher UI show last probe time, expiry, next scheduled probe, consent state, measured cost and any unsupported reason, per the enforcement spec's read-only diagnostic requirement.

## Validation and rollout

Use isolated accounts and disposable repositories, as in the enforcement spec.

- Guard: execution subagent denied with a routed reason; read-only helper allowed; classifier moving a call from execution to read-only recorded as `classifier`; engine timeout, malformed hook payload and missing strategy each allow with a recorded fallback cause; `PACER=off` and executor sessions unchanged; a Codex or Cursor planner session behaves exactly as before.
- Selection: planner wins a step on declared fit and is launched as a managed task with a normal attempt record and work-tree lineage; planner excluded at the reserve boundary with the reserve reason; planner absent from a routing rule is never injected into it; `planner_executes: false` restores exclusion on the delegate and guard paths **while conversation-mode launches and `allowDelegation` child routing keep working**.
- Capacity: planner-executed tasks respect `max_tasks` and never drive the planner window below the reserve.
- Regression: executor-side strict enforcement, child delegation grants, review and retry are unaffected.
- CT-11 live validation with the harness, covering the CLI, the Dispatcher UI and the planner hook path. Surfaces that cannot be exercised are reported UNVERIFIED.

Review under API-1–5, SEC-1/5, ARCH-1/2/5/12, CT-4/11 and REPO-10. The security reviewer owns "Certifying the planner account", since it extends an approved enforcement guarantee to the account the person converses with and adds a scheduled, quota-spending probe.

Behavior changes needing a migration note and a release note: the `planner_executes` and `learning.enabled` defaults, the new `pacing.planner_reserve_headroom` and `pacing.planner_probe`, the narrowed read-only helper list, and the removal of the `"<provider>-executor"` allow branch. ADR 0006 needs an update for the planner session path.

Probe scheduling has its own validation: consent requested once and recorded; no probe below the reserve; no probe when `probeSupportReason` is non-null; backoff and daily ceiling observed under repeated failure; no thrash between two repositories; measured cost recorded and surfaced. Because the probe spends the planner account's real quota, these run against an isolated account, not the maintainer's.

## Left to the builder

- How the guard obtains a brief from the hook payload: repository resolution from `cwd`, task kind and difficulty when the classifier is configured, and what to do when the prompt is too short to classify.
- Staying inside the hook deadline: which parts of `previewDispatch` can run against cached observations only, and whether a short-lived routing cache keyed on repository and kind is worth its staleness.
- How a read-only helper is identified. Name matching is what exists; a declared capability from the adapter is better where one can be obtained. The builder chooses, and documents the fallback.
- Whether the denial reason should include a ready-to-run brief file or only the command.
- Protocol and ops surface for reading planner-session routing decisions, following API-1–5.
- The concrete tier and strengths values for the shipped starter inventory.
