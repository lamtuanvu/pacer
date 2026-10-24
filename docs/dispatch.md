# Dispatch preview

Pacer can preview an executor/account/model choice using a configurable strategy ladder. This is an experimental read-only foundation: existing `route` and `delegate` behavior is unchanged, and executors still cannot delegate child tasks.

```sh
pacer dispatch preview --repo . --goal 'Investigate a rendering bug' --kind debug --json
pacer dispatch preview --repo . --goal 'Review architecture' --min-tier medium --tools
```

The authenticated service operation is `dispatch.preview`; MCP exposes `dispatch_preview` with the same input. Inputs are `repo`, `goal`, optional `kind`, `model`, `requirements` (`minTier`, `tools`, `context`) and `preferences` (`models`, `strengths`). Unknown task kinds are allowed and only match a step explicitly declaring that kind or a generic step. Omitted kinds are not inferred. Goal text is validated but excluded from decision snapshots; the current engine uses explicit structured requirements.

Preview reads existing cached usage observations. It does not refresh providers, launch work, reserve capacity, enable nested delegation or activate a strategy. Status/normal usage readers populate their existing caches separately. Missing or stale facts stay unknown, so a first preview may recommend queueing. Provider refresh, live admission and child delegation are later delivery slices.

## Configure models and the ladder

Existing fixed-model runners remain singleton choices. A runner without a model exposes one unresolved executor-default choice; it has unknown tier/capabilities until evidence establishes them. Use an accounts-form strategy to declare multiple model choices on a runner:

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
    - id: capable-headroom
      capacity: comfortable
      rank: [task-fit, spare-capacity]
    - id: usable-fallback
      capacity: usable
      rank: [task-fit, spare-capacity]
  onNoMatch: queue
```

Model IDs above are illustrative; configure exact IDs supported by your executor/account. Model declarations authorize preview choices only: they do not change the runner's existing execution `model`. Do not assume legacy delegation will execute the preview winner. Endpoint model declarations must belong to the endpoint's configured connection model list. Tier and strengths are your declarations, not a quality certification or automatic classification. Discovery cannot expand the allowlist.

Pacer applies existing routing/project permissions, planner exclusion, availability and concurrency checks before evaluating steps. All task requirements remain mandatory through fallbacks. It walks steps in order and ranks candidates in the first qualifying step. Step model preferences precede task model preferences; each `rank` list then applies lexicographically, with stable candidate identity breaking ties. `task-fit` counts matching configured strength tags. No learned ranking is enabled.

Ranking factors: `task-fit`, `spare-capacity`, `burn-before-reset`, `cheapest-first`, `preference`. Missing cost/burn information stays unknown and follows comparable known values. The current cached-status adapter supplies no monetary prices, so cheapest-first may tie. Burn uses remaining headroom per hour before reset. Shared account quota pools are reused by every model, not added together.

`comfortable` requires fresh health and measured headroom of at least 20 percentage points after reserve in every quota window by default. `usable` requires positive measured headroom after reserve. Unmetered accounts still require health; missing readings are not unmetered. `unknown` explicitly allows uncertain capacity, while hard observed exhaustion and task requirements still exclude candidates. Reset/expiry observations cannot count as fresh. Adapter errors are fixed structured states rather than raw provider responses.

## Read the result

JSON includes the engine/version, immutable decision request snapshot and hash, proposal and hash, matched/skipped steps, ranked choices/factors, exclusions and uncertainty. Requested model bindings and observed actual model identity are separate. A valid recommendation is not admission: capacity can change after preview. `queue`/`fail` are recommendations in this release, not actual task-state changes.

Pacer's control layer owns authorization, eligibility and future reservations/launches. Decision engines only recommend existing candidate IDs. The local ladder uses a replaceable typed interface; another conforming engine can be injected by service integration, but arbitrary remote/plugin engines are not configurable in this release. Invalid or timed-out engine output cannot select a runner. Observation adapters use serializable scoped envelopes suitable for a later plugin binding; existing plugin-owned readers retain their ownership.
