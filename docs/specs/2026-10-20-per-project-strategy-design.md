# Per-project executor strategy

Approved by the maintainer on 2026-10-20 for issue #190.

## Proposed design

### 1. Product behavior and precedence

| Condition | Behavior |
| --- | --- |
| Repository has no override | Existing task-kind routing, pacing, account spreading/filling and fallback remain unchanged. |
| Repository has an override | Its list supplies both allowed candidates and strict automatic preference order, replacing the global task-kind executor list for this repository. |
| First allowed executor is ineligible | Try the next eligible allowed executor; never append global candidates. |
| Pacing prefers a different allowed executor | Project order wins. Existing hard eligibility checks still apply. AHEAD/UNKNOWN/EXPIRING and account spread/fill do not reorder the project list; they are not newly treated as hard exclusions. |
| User explicitly selects an allowed executor | Prefer that executor under existing explicit-request/capacity semantics; later fallback remains inside the project list. |
| User explicitly selects a forbidden executor | Reject with `not_allowed` before creating/spawning a task; `--force`, retry, bulk retry and hooks cannot bypass the policy. |
| All allowed executors lack capacity | Preserve existing queue semantics. Show allowed executor capacity reasons. |
| No allowed executor is usable for a non-capacity reason | Report the actual per-executor exclusions; preserve existing lifecycle outcome conventions instead of inventing a new task state. |
| Policy changes while work waits | Re-evaluate before a new attempt is authorized; never use a stale reserved executor as authority. |
| Policy changes while an executor is already working | Do not interrupt that attempt. Observing/reattaching to an existing durable run is allowed; a new child attempt must pass current policy. |
| Global strategy changes or a runner is removed | Keep the project policy. Missing referenced runners are unavailable, never silently replaced by another account or global candidate. |
| Override removed | Explicitly restore existing global behavior for that repository. |

Keep the existing `MAX_ATTEMPTS = 3` executor-attempt bound. Eligibility skips do not consume attempts; when three actual attempts fail, stop with an explicit attempt-limit explanation even if later allowed candidates remain. Do not misreport those untried candidates as exhausted.

The ordered list contains at least one runner; reject an empty save. “Use global strategy” is an explicit remove action, not an empty list. No project-specific planner, budget, model, classifier, host credentials or per-task-kind subrules in v1.

### 2. Repository and executor identity

- Reuse `RepoRef.key` from `src/core/repos.ts`, `resolveRepoInput`, existing git-common-dir worktree aliases and `repoKey` URL normalization in `src/config/hosts.ts`.
- Main checkout, subdirectories and linked worktrees share a project policy. Independent clones with the same normalized supported origin share the policy because existing repository identity already groups them. Repositories without a supported origin use the existing canonical-main-path local key.
- Persist the resolved repo key with tasks; prefer stored task.repo for queued/retry decisions. Legacy tasks without it must resolve identity before execution; an identity probe error must not silently select the global policy. Read-model paths use stored/cached identity and never probe Git or mutate the registry.
- Identity-changing operations (moving an originless repository or changing origin) are outside automatic migration in v1. List orphaned policies so users can remove/recreate them deliberately; document this boundary.
- Accept existing runner aliases in writes, but resolve and persist a fully qualified identity (`agent#account@host`, explicit `@local` for local runners), not an alias whose default account can change. Map it to the active strategy's runner ID only when agent, account and host match exactly. Reject planner/unknown/duplicate identities at save. Distinguish accounts and remote hosts.

### 3. Persistence and concurrency

Create `$PACER_HOME/project-strategies.json`, outside `state/repos.json` and named strategy YAML. Registry pruning and global strategy activation must not erase project policy.

```ts
interface ProjectStrategyEntry {
  rev: number;
  executors: string[] | null; // qualified IDs; null is a removal tombstone
}
interface ProjectStrategyFile {
  version: 1;
  projects: Record<string, ProjectStrategyEntry>;
}
interface ProjectStrategyView {
  repo: Pick<RepoRef, "key" | "label"> & { path?: string }; // orphan has no reachable path
  rev: number; // 0 only if never configured
  executors: string[] | null;
  available: { id: string; reference: string; label: string }[];
}
```

Use mode0600 files and0700 created directories, atomic write and the existing `project-strategies` cross-process lock. Require `expect_rev` on set/remove. Compare per-repo revision inside the lock; two editors of the same repo cannot overwrite each other, while unrelated repo edits preserve both records. Tombstones prevent stale set/remove/recreate ABA races. Missing file means no overrides; malformed/unreadable file is an explicit error and blocks new routing instead of permitting global fallback. Reject unsupported file versions and invalid entry shapes. Reads never repair or rewrite data.

Policy decisions are committed at the existing slot/attempt reservation point. Lock ordering is `slots` then `project-strategies` then existing short task-store updates; policy mutation takes only `project-strategies` and publishes after releasing it. Never await Git, provider status or executor execution under the policy lock. Compare the current revision to the ranked revision inside the final reservation critical section: if changed, release locks and recompute. A later policy edit does not revoke an already committed attempt. A queue reservation must be rechecked by the runner before a new child attempt.

### 4. Shared routing contract

Create `src/engine/project-routing.ts` for pure identity/candidate resolution and `src/config/project-strategies.ts` for validated storage. `src/core/project-strategies.ts` owns API-facing reads and mutations.

```ts
interface ProjectSelection {
  repoKey: string;
  rev: number;
  references: readonly string[];
  executors: readonly string[]; // active runner IDs or missing qualified refs
}
resolveProjectSelection(
  strategy: Strategy, repoKey: string,
  entries: Readonly<Record<string, ProjectStrategyEntry>>
): ProjectSelection | undefined;

// Extend existing rankExecutors with optional fourth argument.
interface CandidateSelection { executors: readonly string[]; order: "configured" }
rankExecutors(kind, strategy, statuses, selection?: CandidateSelection);
```

Undefined selection runs the unchanged ranking path. Project selection uses exactly its candidates, applies the existing hard exclusions, then returns survivors in configured order with monotonic rank scores. It does not run global pacing or account reshuffling afterward. Compute the no-configured-executor reason from the selected candidate list too, rather than the global `executorsFor` list. Keep `executorsFor` as the global helper; project-aware callers derive candidates through `resolveProjectSelection` so there is no accidental global fallback.

Hook results may only remove candidates; a hook returning a forbidden ID or different order cannot expand/reorder the project list. Apply remote eligibility and slot checks as today, without weakening either.

Add optional `policy: {source:"project"; repoKey:string; rev:number; executors:string[]}` to route results and `RoutingNote`; omit it for global routing. Persist actual attempt decisions for explanations. When a policy file cannot be read in a snapshot, expose an actionable diagnostic and suppress retry suggestions; do not turn a broken policy into an empty successful global read.

### 5. API, CLI and UI

New operations in `src/api/ops.ts`:

- `project.strategy.list {}`: policies keyed by repo, including entries whose checkout is absent; no Git probing.
- `project.strategy.get {repo}`: registered key or absolute path → `ProjectStrategyView`.
- `project.strategy.set {repo, executors:string[], expect_rev:number}` → updated view; min1 executor, revision>=0.
- `project.strategy.remove {repo, expect_rev:number}` → updated inherited view with incremented revision. Stored canonical keys can address orphaned policies without requiring a reachable checkout.

Mutations publish the existing config-change event with area `project-strategies`; extend invalidation consumers, not the transport. Expose the operations through existing discovery/MCP plumbing. Preserve `/v2` compatibility; old clients without new fields remain valid.

CLI, through the existing API client/local-dispatch path:

```text
pacer project strategy list [--json]
pacer project strategy show --repo <path-or-key> [--json]
pacer project strategy set --repo <path-or-key> --executors <id,id,...> [--json]
pacer project strategy remove --repo <path-or-key> [--json]
pacer route [kind] --repo <path-or-key> [--json]
```

`set/remove` read the revision then submit CAS once; on conflict explain that another client changed the policy and require a fresh retry, never auto-overwrite. Bare `pacer route` keeps its existing global behavior. Repo-aware output names the project override, effective order and exclusions.

Add a “Project strategies” subsection within Settings → Routing, using a new focused `ProjectStrategies.tsx` component rather than enlarging `General.tsx`. Repo picker; inherited/custom indicator; ordered runner rows; Add/Remove and keyboard-accessible Move up/Move down buttons; Save; Use global strategy; visible conflict/errors. Show labels plus account/host where needed. Save is explicit and preserves unsaved input on errors. Feature-detect new operations for older services.

Delegate and retry flows use repo-aware server results. On changing repo, clear an explicit executor that is no longer allowed. Show “Project order” and the selected repository in route explanations. Existing TUI/tray/Orca actions consume corrected shared retry suggestions; do not add separate policy stores or interactive Orca settings. CLI provides complete configuration without the web app.

### Alternatives considered

1. **Recommended: persistent repo policy + shared routing selection.** Consistent restrictions across global strategy changes; small independent configuration contract.
2. **Attach a complete named strategy to each repo.** Reuses YAML, but duplicates planner/account/budget configuration and expands the issue into full strategy composition.
3. **Add repo predicates to global routing rules.** Fewer storage changes, but global strategy switching can remove the restriction and current pacing can still reorder the candidates. Harder to explain as a persistent project policy.


## Validation

Preserve no-override behavior; test identity, concurrent edits, ranking, queue/fallback/retry boundaries and client consistency. Follow CT-11 with real executors in an isolated harness, affected UI screenshots and independent UI/QA reports.
