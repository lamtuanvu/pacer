# Orca panel for pacer — design

Status: draft, for maintainer review.
Author: planning session, 2026-11-19.

## Intent and why

The Orca plugin that let pacer show up inside Orca was removed on 2026-10-20
([ADR retire-orca-plugin](../decisions/2026-10-20-retire-orca-plugin.md)) because Orca's plugin
API couldn't support it: no panel-to-worker call (buttons injected `: pacer '<json>'` text into a
console), no reload API (updates left a stale panel), manual dev-folder installs only. That ADR's
own "Revisit when" clause named the condition: "Orca gains a plugin API that lets a panel act
through the pacer API and reload itself, and users ask for an in-Orca surface again."

Orca's plugin system has since grown exactly that: a `worker-panel` template with a typed
panel↔worker protocol (`PluginRequests`/`PluginPanelEvents` in `protocol.ts`, `orca.panels.handle`/
`post` in the worker, `plugin.request`/`plugin.on` in the panel), persistent `orca.storage`, and
real reload/update tooling (`plugin dev reload`, `plugin restart`, `plugin update`, catalog
`plugin install`). This is substantially the `plugin.invokeCommand` action pacer had drafted and
never posted upstream (recovered from git history: commit `00517e62e`, path
`docs/upstream/orca-panel-worker-call.md`, deleted when the plugin was removed).

The reason to build this now: reduce context-switching. The user wants to stay in Orca and act on
what pacer needs from them (reviews, stuck tasks, budget) without alt-tabbing to the pacer app or
tray for the common cases.

## Goals

- A small Orca panel — one `status` bar item and one sidebar `panelTab` — that carries the part
  of pacer you need while working in an Orca worktree, and lets you act on it without leaving
  Orca. Revised 2026-11-22 after the maintainer approved the panel design (the "Pacer Orca Panel"
  design canvas): the panel shows, in order, the planner's pace (usage meter, mode, advice); what
  needs you (attention items, answering a question in place, accepting or rejecting a requested
  review); delegating from the focused worktree; what is running, with stop, watch in Orca and
  open its worktree as an Orca workspace; who runs next; and what finished today. A menu pauses
  or resumes delegation and holds a mode. The status bar item states pace and how many items need
  you.
- Scoped to the Orca workspace currently focused by default: the lists and counts match the repo
  that workspace is in, with an All repos view one tap away (counts per repo and every repo's
  items, each labelled with its repo).
- The worker is an ordinary pacer v3 client: HTTP to a running `pacer serve`, the same bearer-token
  auth every other client (CLI, TUI, app) already uses. No pacer-side plugin registration, no
  special-cased backend.
- Live updates through pacer's existing `GET /v3/events?since=` SSE stream, not polling — the panel
  should never be stale without something telling it to refresh.
- Built on Orca's own reload/update tooling (`plugin dev reload` while developing, `plugin
  install`/`update`/`restart` once shipped) so "stale plugin after an update" can't recur.

## Non-goals

- Not a replacement for the pacer app, web UI, or tray. Settings, accounts, executor setup,
  routing and strategy management, insights, the session viewer, setup and anything else outside
  the scope listed under Goals stay in those surfaces; the panel opens the pacer app for them.
- Not rendered through pacer's `plugin.ui.render`/`plugin.ui.action` (`contributes.ui`). That
  protocol is scoped to letting *pacer plugins* (e.g. executor backends) contribute small bits of
  UI into *pacer's own first-party app shell* ([ADR 0010](../decisions/0010-plugin-ui-contributions.md)),
  specifically so untrusted plugin code never ships HTML/JS/CSS into the app's trust boundary. The
  Orca panel is a genuine pacer client, the same tier as the web app — it talks to pacer's real
  operations and renders as an Orca-hosted `"ui":"html"` page using pacer's own design tokens
  (`app/src/ds/tokens.css`), the way the web app renders with its own (`app/src/ds/`) components.
  Reusing the plugin-UI sandbox here would buy nothing and would
  import restrictions built for a different problem (no primary buttons, no text input, a mandatory
  "contributed by this plugin" banner, 64 KB/500-node document caps).
- Not an embedded, pixel-identical copy of the pacer web app inside an Orca editor view. Verified
  against Orca's own plugin sandbox: no UI frame (panel or editor) has network access — confirmed
  both in the authoring guide ("No network: requests outside the plugin's files fail") and in
  upstream's own `test-fixtures/hostile-panel` fixture, which asserts `fetch()` exfiltration is
  blocked by `connect-src 'none'`. `editor` surfaces are additionally scoped to a custom view bound
  to a file type via `orca.document.session()`, which doesn't apply here. Shipping the web app's
  built assets as plugin files and retrofitting its network calls to a worker bridge is possible in
  principle but is rejected (see Approaches).
- Not a return to "information-only." A read-only panel was the pre-2026-10-15 and
  2026-10-15-to-removal shape; it doesn't solve the stated problem (staying in Orca to *act*).

## Anti-goals

Would count as failure even if it technically runs:

- The panel goes stale after a pacer or Orca update because nothing reloads it — the exact failure
  that killed the original plugin.
- The worker falls back to spawning `pacer api --stdio` instead of talking to the running service —
  reintroducing the console/stdio workaround the user explicitly ruled out; HTTP to `pacer serve`
  is the only transport, matching every other client.
- Any pacer business rule (what counts as ready to review, what an action is allowed to do) gets
  reimplemented inside the Orca plugin instead of read from the service's own `attention[].actions`.
  The service remains the only place that decides what's actionable and how.

## Constraints

- **Governance.** P7 ("the Orca plugin is removed") and ARCH-6 are retired/established rules that
  currently forbid an Orca panel; amendment 0.18.0 says explicitly that it "does not revive the
  retired Orca panel (P7 and ARCH-6)." Reviving this needs a new ADR and constitution amendment.
  Only the maintainer adopts an amendment (by merging its PR) — this ships as a proposal, not a
  unilateral code change.
- **Orca plugin sandbox.** UI frames (panel, editor) get no network and no bare npm imports; only
  a `trusted-worker` process does, and it needs the user's `--approve` on first load (grants:
  `execution: trusted-worker`, capabilities `storage:own`, `workspace:read` (for the current
  workspace's path, to scope the queue) and `workspace:write` (for host `workspace.open` when the
  panel opens a task worktree in Orca), contributing a `panels` surface and, separately, a status
  bar item). Panel and worker communicate only through the typed `protocol.ts` request/event
  contract.
- **Orca plugin size caps.** 2,000 files / 50 MiB total / 1 MiB per transpiled file — not a
  constraint at this scope, but it's what rules out ever bundling the real web app (see Non-goals).
- **Pacer's API.** Loopback-only HTTP, bearer token from the 0600 token file (or the app's cookie
  session, which doesn't apply to a background worker), no CORS, 256 KiB request body cap. The
  worker is just another authenticated v3 client — no pacer-side plugin manifest or capability
  grant is needed for this (that system is for plugins pacer itself loads, e.g.
  `plugins/pacer-exec-orca`; unrelated to this).
- **Repo rules (AGENTS.md).** Tracked files hold no machine-specific paths or personal emails;
  commits are signed off (DCO) with Conventional Commit titles; PRs are squash-merged.

## Approaches considered

1. **Revive the old read-only panel, just rebuilt on the new reload tooling.** Cheapest, lowest
   governance risk. Rejected as insufficient: it fixes staleness but not the stated problem — the
   user would still tab out for every action, which is most of the friction.
2. **Native Orca panel calling pacer's real operations directly.** Worker calls `snapshot.get`,
   subscribes to `/v3/events`, and forwards attention-item actions (`task.review`,
   `dispatch.retry`, `attention.dismiss`/`snooze`, etc.) through `plugin.request`; panel renders
   as an Orca `"ui":"html"` page with pacer's own design tokens rather than Orca's generic
   component styling, since `orca plugin check`'s render-check kit only supports `"ui":"components"`
   panels and a branded look needed full CSS control anyway. **Chosen.** Business logic stays
   entirely in the service (the worker never decides what's reviewable, only displays what the
   service already decided); this
   is architecturally the same thing the web app and tray already do, just a third thin client.
3. **Generic renderer of pacer's `plugin.ui.render`/`action`.** Initially attractive (reuse,
   "automatically picks up new surfaces"), but rejected after checking ADR 0010: that protocol's
   entire reason to exist is sandboxing *untrusted plugin* UI inside *pacer's own app shell*. Using
   it for a trusted, maintainer-built Orca client imports restrictions designed for a different
   trust problem, for no benefit — the Orca panel isn't a guest inside another host; it is one.
4. **Ship the real pacer web app bundle as plugin files, bridge its network calls to the worker.**
   Rejected: doubles the UI surface to keep in sync with every pacer app change, needs retrofitting
   every network call in that bundle to a worker round-trip, and risks the file-size caps — all to
   recreate the exact drift risk that got the original plugin removed.

## Decided

- **Template and surfaces:** `orca plugin create --template worker-panel`. One `status` bar item
  (planner pace % and tone, from the snapshot's `planner`/`counts`) and one sidebar `panelTab`
  (the sections listed under Goals, from the snapshot's `planner`, `attention`, `tasks`,
  `executors`, `today`, `pause` and `repos`).
- **Transport:** confirmed against `src/serve/http.ts`: the token lives at `$PACER_HOME/token`
  (default `~/.pacer/token`, mode `0600`) and the service listens on `127.0.0.1:<port>`, where
  `port` is `$PACER_PORT` or the built-in default — no separate discovery file to read. The worker
  reads that token and calls `pacer serve` over loopback HTTP for operations (`POST
  /v3/ops/<name>`), and opens `GET /v3/events?since=<seq>` (SSE) to stay current; on each relevant
  event it calls `orca.panels.post(...)` so the open panel updates without a manual refresh. No
  `pacer api --stdio` path. `since` persists in `orca.storage` (a worker save drops in-memory
  state per Orca's own gotcha), and the SSE connection reconnects with backoff from the last stored
  `seq` — resuming via `since`/`Last-Event-ID` rather than refetching a full snapshot each time.
- **Action model:** render each attention item's server-supplied `actions: [{label, op, params,
  style?, confirm?}]` as buttons. A press shows the supplied `confirm` (if any) via the panel's own
  confirm affordance, then calls the named `op` with `params` through the worker — never a
  hardcoded mapping of "what reviewing means." `confirm` is the service's own string (the
  `Action` type in `src/attention/types.ts`). An action whose `op` is `ui.open` is the one
  client-side action: the worker opens that screen in the pacer app. Besides the service's actions,
  the panel offers only the direct task controls the pacer app also offers, each an op the
  service validates and may refuse: Answer adds the typed `text` to the service's own Answer
  action; Accept and Reject (`task.review`) appear only on an item the service raised as a
  `review`; Stop (`task.stop`, confirmed in the panel) and Watch (`task.attach`, target `orca`) on
  a running task; Delegate (`task.delegate`, repo = the focused workspace's repo); pause/resume
  delegation and holding a mode. Each sends the task's `expect_rev` where the op takes one, and a
  conflict reads "Already handled elsewhere". Which tasks count as running or done today follows
  the shared selectors in `src/view-model/selectors.ts` (they filter and order what the service
  derived; they decide nothing).
- **Reload/install story:** develop with `orca plugin dev watch --check`; ship via `orca plugin
  install <folder-or-repo>`, updated with `orca plugin update`. No manual dev-folder-only install.
- **Governance path:** a new ADR (e.g. `docs/decisions/2026-11-19-revive-orca-panel.md`) that
  explicitly answers the 2026-10-20 ADR's "Revisit when" clause, plus a constitution amendment that
  un-retires P7 (rewritten for this shape) and updates amendment 0.18.0's "does not revive" line.
  This lands before or alongside the first panel code — it's what makes the code legal under this
  repo's own rules, not an afterthought.
- **Location:** a new tracked folder analogous to `plugins/pacer-exec-orca`, e.g. `plugins/orca-panel/`,
  holding `orca-plugin.json`, `src/protocol.ts`, `src/worker.ts`, `src/panel.html`/`src/panel.ts`
  (the `"ui":"html"` frame and its thin DOM glue), `src/panel-view.ts` (the pure, DOM-free,
  `orca`-free view-model that carries the actual tested logic), and their tests. No
  machine-specific paths in anything tracked.
- **Scoping:** the worker calls `workspace.readContext` (capability `workspace:read`) for the
  focused workspace, resolves its path via `workspace.list`/`project.list`, and matches it against
  pacer's own `repos[].path` (from `snapshot.get`) to find that repo's `key`. Attention items,
  counts and the status badge filter to that `key`. When no workspace is focused or its path
  matches no known repo, the panel falls back to the global queue and says so (never a silent
  empty list that looks like "nothing to do").
- **Install UX:** pacer ships `pacer orca-panel install` / `pacer orca-panel update`, which shell
  out to `orca plugin install <this-plugin's-folder-or-repo>` / `orca plugin update <plugin-id>` on
  the user's behalf — the "convenience command" option, chosen over staying hands-off. This
  narrowly revises D3 of the 2026-10-20 ADR ("pacer never edits Orca's settings"): pacer may now
  invoke the `orca` CLI to manage *this plugin's own* install/update, and nothing else — it still
  never writes to Orca's config files directly, never touches other plugins, and (the actual cause
  of the 0.1.24 incident this ADR calls out) never writes to or replaces the user's own `pacer`
  CLI binary, symlink or PATH entry. The new ADR states this safeguard explicitly, not just the
  convenience.

## What's left to the builder

- The full mapping from attention `kind` (`question`, `review`, `failed`, `limit`, `stuck`,
  `account_signin`, `executor_down`, `host_down`, `planner_quota`, `setup`, `update`) to how each
  renders in the list — start with the ones that actually drive the "review queue" use case
  (`review`, `failed`, `limit`, `question`) and fall back to a plain labeled row with its generic
  `actions` for the rest; there's no need to special-case every kind in v1.
- Exactly which Orca capability (if any beyond `storage:own` and `trusted-worker` execution) covers
  reading the pacer token file and making outbound HTTP/SSE requests — confirm against
  `references/host-api.md`/`references/manifest.md` while scaffolding; this doc does not guess it.
- Final plugin id/publisher, and whether `pacer orca-panel install` points `orca plugin install`
  at a local folder, this repo, or a catalog entry — a product/packaging call, not an
  architectural one; the command's job (invoke `orca plugin install`/`update` for this plugin only)
  is decided regardless of source.
- Test shape: `worker.test.ts` covers the worker's request handlers and live-loop behavior against
  a real loopback pacer fixture, using `orca/testing`'s mount/host mocks per `references/testing.md`.
  The html panel itself has no `orca plugin check` equivalent (that kit only mounts
  `"ui":"components"` panels), so `panel-view.ts` carries every rendering decision as plain,
  DOM-free functions covered by `panel-view.test.ts`'s plain `node:test` cases, leaving `panel.ts`
  (the actual DOM writes) as the one untested surface — exercised only by manual/live-Orca checks.
- The exact ADR/amendment wording and principle numbering — draft it, but the maintainer decides
  the final text since only they adopt amendments.
