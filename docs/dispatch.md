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

## Interactive lanes

```sh
pacer delegate --interactive --goal 'Build the feature end to end' --repo . --group feature-x --json
pacer delegate --interactive --goal 'Second lane, same feature' --repo . --group feature-x --json
pacer send TASK_ID "use approach B"
pacer send TASK_ID "use approach B" --force
```

`--interactive` runs a `pacer delegate` task with a live terminal instead of a one-shot run: it is routed and budgeted through the same choice ladder as any delegated task (`pacer dispatch preview`), and becomes eligible for `needs_input`, review and retry once it settles, same as a non-interactive task. It needs an Orca-backed execution strategy (`execution.backend: orca`); on the direct backend it still runs, with the same terminal access ordinary interactive launches already have.

`--group NAME` nests every lane sharing that name under one Orca worktree, so they stay visible together in Orca's own UI. The group's parent worktree is created once per repository and group name and reused by later lanes; it is otherwise inert (no agent runs there).

`pacer send TASK_ID "<message>"` delivers one line of text into a running interactive lane's live Orca terminal, without starting a new attempt. It is recorded on the task's activity timeline. If another `pacer send` call delivered a message in the last 60 seconds, a second call from a different caller (identified by the OS user name) is refused with that caller's name; `--force` sends anyway and the takeover is recorded. This is a cooperative lease between pacer's own callers, not a lock on Orca's own terminal UI: pacer cannot see a person who is typing directly in Orca's app.

An executor that calls `pacer ask` on an interactive lane leaves its worker and terminal running (an ordinary delegated task's worker stops there instead), so `pacer answer`/`dispatch.answer` can deliver the answer live into the same process and resume watching it, instead of starting a fresh attempt. If the worker has since exited, answering falls back to a normal respawn, exactly like any other task.

## Native subagent control

New managed work uses strict delegation enforcement. Pacer admits a local executor only after a canary has observed a native subagent call and its matching denied tool result for the selected account, CLI version, launch mode and repository. A missing or stale certificate queues the work with an exclusion reason. Conversation and interactive launches, remote hosts and Orca remain ineligible until their exact launch paths can be verified. Existing managed tasks saved before strict enforcement retain their cooperative policy.

Open **Settings → Dispatcher → Native subagent control** or run `pacer dispatch enforcement --repo .` to inspect each executor. `pacer dispatch probe --repo . --executor RUNNER` starts a background check that may use account quota; its response includes a job ID for `pacer api call job.get`. The app follows that job automatically. Connect that executor's native Pacer integration before probing. Claude Code currently has a certifying native tool-result observer. Codex, Cursor and permission-only adapters remain uncertified until a host-observed probe proves child startup was prevented. Project-level native control overrides are also left uncertified until they can be probed in the exact launch environment.

Certificates expire within 24 hours, so the service also renews them on a timer. Because a probe spends the quota of the account it certifies, it runs only with your consent: `pacing.planner_probe` is `ask` by default, and nothing is probed until you answer in Dispatcher or through `dispatch.enforcement.consent`; `auto` renews without asking and `off` disables scheduling while leaving manual verification available. Scheduling also stops short of probing when `pacing.planner_reserve_headroom` would be breached, when headroom cannot be measured, during failure backoff, past a daily ceiling, and when the runner is not listed in a routing rule. An over-ceiling probe cost or repeated repository switching pauses probing for at least 24 hours, then scheduling retries when eligible; the daily ceiling still applies. Dispatcher and `pacer doctor` show the consent state, the next eligible probe and the last measured cost; declining consent is a recorded answer, and probing turned off is a setting rather than a fault.

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

## Explain a route

`dispatch.explain` (and `pacer route --explain --repo . --goal 'Fix the login bug' [--kind debug] [--executor codex] --json`) answers "where would this go?" without doing anything. It reuses the same ranking, candidate and ladder code as `dispatch.preview` and the runner, so the answer cannot drift from the real route.

It is read only: it starts nothing, reserves nothing, writes nothing, publishes no event and spawns no agent. It never calls the model classifier (the kind is detected with the rules classifier when you give none), never starts a plugin (a plugin decision engine is used only if its plugin is already running; otherwise the ladder is used and `engine.fallback` says `engine_not_running`), and reads the task store through a read-only connection. It is refused for executor sessions.

Params: `repo`, `goal`, and optionally `kind`, `executor` (a preference for this task only), `model`, `requirements`, `preferences`, `delegationEnforcement`, `difficulty` and `strategyDraft` (an unsaved draft, as `strategy.preview` takes it). Errors: `invalid_input`, `unknown_executor`, `too_large`, `not_allowed`.

Result: `outcome` is `select`, `queue`, `fail` or `override`. `override` means your requested executor was chosen. If it is blocked or its budget is used up the outcome is `fail`; if it is unavailable for another reason, the ladder's pick is returned with an `override_unavailable` reason. `reasons`, `fallbacks[].reason` and `uncertainty` are `{code, outcome, subject?, facts, text}`; clients show their own copy for `code` and `facts`, and `text` is plain English for the CLI. A new code is an additive change; clients show generic copy for codes they do not know.

`planner` is `unknown` (`planner_not_measured`, or `planner_is_executor`) until a planner adapter reports tokens. `window` carries the planner account's current usage and pace from the cached status; it is not a projection.

The explanation does not model admission-time factors, and names them in `uncertainty`: capacity reserved by running work (`reserved_capacity`), configured classifier hooks (`admission_hooks`) and locks taken after you looked. It also marks `enforcement_unverified` when the native-control version has not been checked in this process, and `cached_preview` always. `revision` is the same for two calls over the same facts.

Known differences from the admission stage: capacity reserved by running work is reported in `uncertainty` and not subtracted from headroom; a busy non-reentrant plugin engine is not detected (only a `ready` plugin is called); a requested executor outside the project's executor policy is not refused here; `strategy.source` is `strategy` or `built-in`, never `project`; a slot-full requested executor returns `queue`.

Reason codes: `step_match`, `capacity_comfortable`, `capacity_usable`, `capacity_unknown`, `override`, `planner_account`, `runner_disabled`, `not_configured`, `blocked_by_user`, `quota_exhausted`, `not_installed`, `signed_out`, `unavailable`, `ineligible`, `runner_unhealthy`, `requirements_not_met`, `pinned_to_other_model`, `executor_busy`, `machine_busy`, `host_unreachable`, `host_reachability_unknown`, `host_paused`, `repo_not_on_host`, `needs_new_worktree`, `local_grant_required`, `enforcement_uncertified`, `other_exclusion`, `step_kind_mismatch`, `step_no_candidates`, `no_step_matched`, `paused`, `engine_failed`, `override_unavailable`, `planner_not_measured`, `too_few_samples`, `planner_is_executor`, `cached_preview`, `capacity_unmeasured`, `default_model_unresolved`, `enforcement_unverified`, `engine_not_running`, `learning_unavailable`, `tasks_unavailable`, `reserved_capacity`, `admission_hooks`.

## Import a GitHub issue

`issue.import` and `issue.search` let a client start a task from a GitHub issue (the New task composer's "From an issue" option). Both are read only: they start, reserve and write nothing, and they are refused for executor sessions.

- `issue.import` params: `repo`, the key of a repository pacer already knows (`repo.list`), and `issue`, a number (`"217"` or `"#217"`) or an issue URL in that repository. Result: `repo`, `github` (`owner/name`), `number`, `title`, `body`, `labels` (names), `url`, `state` (`open` or `closed`) and `truncated: {title, body}`.
- `issue.search` params: `repo`, `query` (GitHub search syntax), and optionally `state` (`open` by default, `closed` or `all`) and `limit` (1–50, default 20). Result: `repo`, `github` and `issues`, each with `number`, `title`, `labels`, `url` and `state`, but no body. A query with a `repo:`, `org:` or `user:` qualifier is refused (`invalid_input`). Identical searches within 30 s share one `gh` call, including one still running, and failures are not cached. At most two `gh` processes run at once and up to eight more wait; further calls fail at once with `unavailable` (`gh_failed`).

The GitHub repository comes from the checkout's `origin` remote, never from the request; a URL for another repository is refused, and anything gh returns that is not this repository's issue (another repository's item, a pull request, a moved issue) is refused or dropped from search results. pacer calls `gh issue view` or `gh issue list` with an argument vector and the user's own `gh` login. It never reads, stores or sends the token. `gh` gets only the environment it needs (home, path, locale, `XDG_*`, proxy and certificate settings, `GH_TOKEN`, `GITHUB_TOKEN`, `GH_CONFIG_DIR`); pacer's own tokens and endpoint keys are not passed. Its output is capped at 4 MiB while it is read.

Issue text is untrusted. It is returned as plain text: control characters, invisible format characters (bidirectional overrides, zero-width and tag characters) and variation selectors are removed, HTML comments and link reference definitions (Markdown a rendered preview does not show) are removed from the body, the title is cut to 300 characters and the body to 64 KiB of UTF-8, and `truncated` says when that happened. Clients render it as text, and the user confirms the request before it becomes a task.

Errors carry `data.reason` over HTTP:

| Reason | Code | When |
|---|---|---|
| `gh_missing` | `unavailable` (503) | `gh` is not on the service's `PATH` |
| `gh_unauthenticated` | `not_allowed` (403) | `gh` is not signed in to github.com |
| `rate_limited` | `rate_limited` (429) | GitHub's rate limit was reached |
| `not_github` | `invalid_input` (400) | the `origin` remote is not a github.com repository |
| `unknown_repo` | `invalid_input` (400) | `repo` is not a registered repository key |
| `repo_mismatch` | `invalid_input` (400) | the issue URL names another repository |
| `repo_not_found` | `not_found` (404) | the repository is missing or not visible to the `gh` login |
| `issue_not_found` | `not_found` (404) | the issue does not exist or is a pull request (also `invalid_input` for a malformed reference) |
| `gh_failed` | `unavailable` (503) | `gh` timed out, failed otherwise or returned unexpected output |

## History and limits

`dispatch.list` pages work roots, child work, or all work by status; the app shows these filters in Tasks. `dispatch.tree` returns the bounded work subtree, per-attempt decisions, requested and observed models, reviews, dependencies, and measured/unknown totals. Queued time across attempts, execution time, dependency wait, capacity wait and parent time waiting for children are shown separately. Open wait intervals are provisional. Account usage is grouped by account, quota window and reset epoch; overlapping parent and child observation intervals are merged before reporting observed percentage movement. It is a shared-account reading, not usage attributed solely to this work. Missing or stale readings remain unknown. `dispatch.events` returns at most 500 ordered events and a monotonic `next` cursor plus `hasMore`; keep requesting while `hasMore` is true, even when a scoped page contains no visible events. The app's Work panel and TUI use the same service data. Work event and decision rows are retained with the local service state; task archival can leave an `Archived work` lineage placeholder. There is no automatic work-history pruning in this version.

Root delegation limits default to depth 3, 20 descendants, and four concurrent tasks. Children inherit hard requirements and can narrow those limits; they cannot broaden an ancestor's permissions. A child request is rejected when it cannot make progress because its parent and other running work occupy the eligible slots. Remote executors do not yet carry scoped child grants, so delegated planners run locally. Model-list and exact-model evidence varies by provider; unknown facts are shown explicitly.

## Token accounting

Pacer records how many tokens each attempt used, next to the quota percentage it already tracks. Tokens describe work volume; they are not a cost, and different providers' counts are not comparable. Pacer never converts one into the other.

After an attempt ends, an extractor for its executor reads the run log pacer already wrote and keeps only numeric usage fields. Prompt text, output text, tool paths and keys are never copied. Each attempt gets a coverage label:

| Coverage | Meaning |
| --- | --- |
| `measured` | The executor reported input and output usage for the whole run. |
| `partial` | A total without a breakdown, or usage up to the point the run was killed. Treat it as a lower bound. |
| `unknown` | The log was empty, unreadable, malformed or from an executor that reports no usage. Never shown as zero. |

Extractors in this release:

- **Codex** (`partial`): the `tokens used` total that Codex prints as the last output of a run. Only that final trailer counts, and it is marked self-reported because stdout text can be written by repository code.
- **Claude Code** (`measured`): the `usage` on the final `result` event of its `stream-json` output. A run that ended without one keeps the usage of the assistant messages seen so far, as `partial`. Pacer replaces the raw stream with its result text when it writes the log, so it keeps the numeric usage in a `usage.jsonl` file beside the run. Claude history from before this release, and remote Claude runs (plain text), stay `unknown`.
- Other executors are `unknown` until their output can be read.

`total` is the provider's own total, or input plus output when the provider splits them. Cache reads and cache writes are stored separately and left out of `total`. Counts that are negative, fractional or above 10⁹ are rejected and the attempt is recorded as `unknown`.

The numbers are stored with the attempt and indexed in the `attempt_usage` table of the task database. On start, the service fills the index for existing history from logs (gzipped archives included). The backfill only adds rows: it never edits task files, task records or logs, and running it again changes nothing.

### Roll-up

Each attempt belongs to exactly one work node, so totals never count an attempt twice and a parent's total is never added on top of its children's. `totals.tokens` on a work tree sums every node's attempts into `total`, `input`, `cacheRead`, `cacheWrite` and `output`, with `measuredAttempts`, `partialAttempts` and `unknownAttempts`. `lowerBound` is true whenever any attempt is `partial` or `unknown`, so show the number as "at least". Numeric sums remain unchanged for compatibility: unreported fields add nothing. The additive `reported` object has `input`, `output`, `cacheRead` and `cacheWrite` booleans, each true only if at least one attempt supplied a non-null count for that field. A reported zero is a measured count; a false flag means the field was not reported, even when its numeric sum is zero. Clients should omit those fields or label them "Not reported". The additive companion `complete` object has the same four field flags, true only when every attempt supplied that field (all false for an empty roll-up). If `reported` is true but `complete` is false, the sum is a lower bound for that field: Session Details shows "≥ N" and "Some attempts did not report this field." Complete fields remain exact. Session Details shows only the total and partial note when `lowerBound` is true.

`byExecutor` groups the same sums and per-field `reported` and `complete` flags by agent, account and model, largest first. Task detail returns the same block as `tokens` for that task, and each attempt carries `tokens`. An attempt whose task record has no tokens (backfilled history) takes them from the `attempt_usage` index, so every view shows the same numbers. A node whose task record can no longer be read keeps its index rows, or counts as one `unknown` attempt. `planner` and `decision` report `coverage: "unknown"` until planner attribution exists.
