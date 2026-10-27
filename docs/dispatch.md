# Intelligent work dispatch

Pacer can choose an executor and a concrete model for each work attempt, then record why it made that choice. An executor with a scoped work grant can delegate a child task back to Pacer. Pacer owns the child policy, workspace, admission, review, and history. Existing `task.delegate` calls remain available; `dispatch.submit` explicitly creates a managed work root.

## Start and inspect work

```sh
pacer dispatch preview --repo . --goal 'Investigate a rendering bug' --json
pacer dispatch submit --repo . --goal 'Fix the rendering bug' --allow-delegation --request-id bug-42 --json
pacer dispatch tree --id TASK_ID --json
pacer dispatch list --relation roots --state running --json
pacer dispatch events --id TASK_ID --after 0 --json
pacer dispatch wait --id TASK_ID --timeout 15 --json
pacer dispatch review --id TASK_ID --accept
pacer dispatch retry --id TASK_ID --request-id retry-1 --expect-rev REV --feedback 'Address the failed check'
pacer dispatch answer --id TASK_ID --request-id answer-1 --expect-rev REV --text 'Use the blue variant'
pacer dispatch enforcement --repo . --json
pacer dispatch probe --repo . --executor codex --json
```

`dispatch.preview` is read only. It uses cached observations and makes no reservation. `dispatch.submit` creates a root, and the runner evaluates eligibility again immediately before launch. The response, work tree, and timeline distinguish declared, requested, and observed model identity. An executor-default model stays unresolved until supported execution evidence identifies it.

An executor may run `pacer dispatch child --goal '...' --request-id UNIQUE_ID` only while its attempt has a valid grant. The grant is short lived, bound to the attempt, and scoped to its descendants. Child work uses a separate worktree based on the parent worktree's current commit. The parent can use `dispatch wait`, `review`, `tree`, and `events` for its subtree. A parent cannot accept its own result through a grant. A parent can be accepted only after required children have been accepted. Stopping work stops its active descendants. Existing API and MCP task review/stop actions use the same work rules.

`dispatch.dependencies --id TASK_ID --depends-on CHILD_ID --expect-rev REV` sets same-root dependencies. A rejected dependency can be waived by the work owner with `dispatch waive --id TASK_ID --dependency CHILD_ID --reason '...' --expect-rev REV`. Both operations leave timeline evidence. `dispatch.review` uses the displayed revision; a competing change returns a conflict. The CLI fetches the latest revision when it is omitted. Direct API callers must supply `expect_rev`.

`dispatch.retry` and `dispatch.answer` requeue the same managed task and keep its root, parent, policy, worktree, dependencies and prior attempts. Use one stable `request-id` for each intended retry; replaying it does not launch a second attempt. An answer adds the question and answer to the brief and normally keeps the asking executor. Earlier independent reviews remain in attempt history. Managed work defaults to at most three cumulative attempts per task (`maxAttempts` is configurable); accepted, archived, expired or active work cannot be retried. A child may retry its own child through a valid grant, but cannot retry itself.

## Native subagent control

New managed work uses strict delegation enforcement. Pacer admits a local executor only after a canary has observed a native subagent call and its matching denied tool result for the selected account, CLI version, launch mode and repository. A missing or stale certificate queues the work with an exclusion reason. Conversation and interactive launches, remote hosts and Orca remain ineligible until their exact launch paths can be verified. Existing managed tasks saved before strict enforcement retain their cooperative policy.

Open **Settings → Dispatcher → Native subagent control** or run `pacer dispatch enforcement --repo .` to inspect each executor. `pacer dispatch probe --repo . --executor RUNNER` starts a background check that may use account quota; its response includes a job ID for `pacer api call job.get`. The app follows that job automatically. Connect that executor's native Pacer integration before probing. Claude Code currently has a certifying native tool-result observer. Codex, Cursor and permission-only adapters remain uncertified until a host-observed probe proves child startup was prevented. Project-level native control overrides are also left uncertified until they can be probed in the exact launch environment.

Strict executor attempts get an enforcement identity for the native guard. They get a separate child work grant only when delegation is allowed. The guard denies native subagent calls and reports the denial to the service through an operation limited to that attempt. It directs the executor to `dispatch.child`; Pacer selects and records an authorized child. This is admission-time control of supported native subagent tools. It cannot prevent an executor from starting another AI CLI or calling a provider API through an unrestricted shell.

## Configure the choice ladder

In the app, open **Settings → Dispatcher** to see the default session planner and account, the active ladder, allowed model choices, and a read-only task preview. **Saved profiles** switches the complete global planner, pacing, eligibility and dispatch policy. **Executor eligibility** sets an ordered executor list for each task kind; a **project override** supplies the list for one repository and stays in place when global profiles change. The decision engine ranks eligible account and model choices from that list. **Edit decision ladder** saves and activates a new named profile; the built-in ladder favors a capable model with spare capacity, then tries a usable fallback. Older Settings → Routing and Settings → Strategies links open Dispatcher. Any local executor holding a valid work grant can ask Pacer to delegate child work; the configured planner is the default for new sessions.

```yaml
planner: claude-code
accounts:
  claude-code: {kind: claude}
  codex: {kind: codex}
runners:
  codex:
    models:
      - id: provider/fast
        tier: small
        strengths: [simple-edits]
      - id: provider/deep
        tier: frontier
        strengths: [debug, architecture]
        tools: true
        context: 128000
dispatch:
  engine: ladder
  timeoutMs: 1000
  reservePct: 0
  comfortablePct: 20
  steps:
    - id: specialist
      match: {kind: architecture}
      candidates: {models: [provider/deep]}
      require: {minTier: medium, tools: true}
      capacity: comfortable
      rank: [task-fit, spare-capacity]
    - id: another-capable-model-with-headroom
      capacity: comfortable
      rank: [task-fit, spare-capacity]
    - id: usable-fallback
      capacity: usable
      rank: [task-fit, spare-capacity]
  onNoMatch: queue
  learning: {enabled: false, minSamples: 20, maxAgeDays: 90}
  discovery: {enabled: false, runners: [], models: []}
```

Steps are evaluated in order; the first step with qualifying choices wins. Requirements remain mandatory at every step. Within a step, factors are compared in the listed order, then by stable candidate ID. Available factors are `task-fit`, `spare-capacity`, `burn-before-reset`, `cheapest-first`, and `preference`. Unknown prices or quota readings are not treated as zero or as unlimited capacity. `comfortable` requires fresh health and enough measured headroom; `usable` needs positive headroom. A step with `capacity: unknown` explicitly permits uncertain capacity but still honors hard exhaustion and requirements. A pin to one exact model never silently changes to another.

Tier and strength tags are user declarations. Pacer does not infer a tier from a model name. An observed model list is a suggestion by default. To allow specific newly observed IDs, set `discovery.enabled: true` and list both permitted runners and exact model IDs. These models enter with unknown tier and strengths until explicitly declared, so discovery cannot satisfy a minimum-tier requirement by claiming one.

`dispatch.models` shows declared/allowed and advertised choices. `dispatch.refresh` asks observation adapters for bounded model, capability, usage, health, and actual-model readings; the service periodically refreshes them with backoff. Unsupported readings remain unknown. Adapter responses are normalized before the decision engine sees them. An enabled plugin may provide `observation.observe`; a configured `engine: plugin:PLUGIN_ID` may provide `decision.decide`. `engineFallback: ladder` enables an explicit local fallback; the default is to queue if the configured engine fails or times out. Plugins recommend or observe; Pacer still authorizes and launches work.

Learning is opt in. Accepted/rejected reviews are grouped by task kind, difficulty, runner settings, and observed actual model. Only independently reviewed attempts with a known actual identity and matching immutable settings can affect a candidate after at least 20 comparable reviews within `maxAgeDays`. Unknown identity and missing usage remain unknown. `dispatch.analytics` reports counts, outcomes, confidence interval, duration, and available usage readings. `dispatch learning-reset --repo .` resets derived evidence for a repository; add `--exclude` to keep that repository out of learning. History and task results remain intact. This is an advisory ranking signal, not proof of model quality.

## History and limits

`dispatch.list` pages work roots, child work, or all work by status; the app shows these filters in Tasks. `dispatch.tree` returns the bounded work subtree, per-attempt decisions, requested and observed models, reviews, dependencies, and measured/unknown totals. Queued time across attempts, execution time, dependency wait, capacity wait and parent time waiting for children are shown separately. Open wait intervals are provisional. Account usage is grouped by account, quota window and reset epoch; overlapping parent and child observation intervals are merged before reporting observed percentage movement. It is a shared-account reading, not usage attributed solely to this work. Missing or stale readings remain unknown. `dispatch.events` returns at most 500 ordered events and a monotonic `next` cursor plus `hasMore`; keep requesting while `hasMore` is true, even when a scoped page contains no visible events. The app's Work panel and TUI use the same service data. Work event and decision rows are retained with the local service state; task archival can leave an `Archived work` lineage placeholder. There is no automatic work-history pruning in this version.

Root delegation limits default to depth 3, 20 descendants, and four concurrent tasks. Children inherit hard requirements and can narrow those limits; they cannot broaden an ancestor's permissions. A child request is rejected when it cannot make progress because its parent and other running work occupy the eligible slots. Remote executors do not yet carry scoped child grants, so delegated planners run locally. Model-list and exact-model evidence varies by provider; unknown facts are shown explicitly.
