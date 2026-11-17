# App live-update rendering

Date: 2026-11-17. Status: proposed, awaiting the maintainer's approval. Applies to: `app/src/data/store.ts`, `app/src/main.tsx`, `app/src/tray/main.tsx`, `app/src/screens/task-shared.tsx`, `app/src/settings/shared.tsx`, `app/src/workspace/view-host.tsx`, `app/src/screens/Screen.tsx`, `app/src/shell/**`, `app/src/screens/**`, `app/src/ds/Prose.tsx`; optionally `src/api/events.ts` and `docs/protocol.md` (phase 4).
Builds on:
- [service core responsiveness](2026-11-09-service-core-responsiveness-design.md), the service-side half of the same goal
- [UI implementation](2026-10-16-ui-implementation-design.md) and [app redesign](2026-10-27-app-redesign-design.md), which mention selectors but never define them
- [ADR clients-over-local-service](../decisions/2026-10-16-clients-over-local-service.md): clients read only through API operations and events (ARCH-1/2)

## Problem

The app stays current by applying the service's SSE events to one store, and that part works. What it costs on every change is out of proportion:

1. **Every change re-renders the whole app.** `main.tsx:73` copies the store into root state on every notification, and `TaskContext.Provider` gets a new `{ state, api }` object each time (`main.tsx:144`). About 97 `useTaskContext` call sites in 63 files then re-render. No component is memoized, and there are no selectors.
2. **Hidden views render too.** Up to five retained detail views (`DETAIL_VIEW_CAP`, `workspace/view-host.tsx:2`) stay mounted and re-render on every change. `hidden` and `inert` hide them but do not stop the work.
3. **Unchanged data still produces new state.**
   - The 5 s "waiting" poll fetches a whole snapshot and always returns a new state (`store.ts:103,176,270`).
   - Once any review has been accepted, every event, including a no-op, is wrapped in a new state object (`store.ts:163`).
   - An idle app therefore re-renders everything at least every 5 s. The tray, which runs its own instance of the same store, does the same.
4. **Each render does per-hook work.** About 109 `useQuery`/`useResource` hooks each `JSON.stringify` up to 200 tasks to compute a revision on every render (`task-shared.tsx:40-44`). `Prose` re-parses markdown on every render, and Dispatch filters and sorts tasks inline.
5. **Clocks re-render whole subtrees.** The top bar and Dispatch tick every second (`TopBar.tsx:55`, `screens/dispatch/Dispatch.tsx:280`), so a relative time like "updated 3s ago" re-renders everything above it.
6. **Event volume grows with the work.** The service sends up to one `task` event per running task per second (`src/link/pump.ts:336`). The client applies each one synchronously with no batching, so ten running tasks mean ten whole-app renders a second.

Users notice this as a sluggish app during busy periods. It also caused the assistant scroll bug: an unrelated re-render scrolled the chat log.

## Goals

1. **Render work proportional to change.** A component re-renders only when the data it reads changes. An idle app renders nothing.
2. **Bounded frequency.** However many events arrive, the app renders at most once per animation frame, and less while hidden.
3. **No new runtime dependency.** `app.js` is 57.6 KB of its 61.4 KB gzip budget (UI-3).
4. **Incremental migration.** Each phase ships alone, and existing components keep working until they are moved.
5. **Measured.** A browser test fixes render budgets so regressions fail CI.

Non-goals:
- Changing what the service sends, except the optional phase 4.
- Virtualizing lists. With up to 200 tasks, selectors and memoization are enough; reconsider if list sizes grow.
- Rewriting screens. Migration replaces how a component reads data, not what it shows.

## Design

### 1. The store notifies once per frame, and only for a real change

- **Batching:** `dispatch` applies events to the state immediately but schedules one notification for the next animation frame, with a 100 ms timer as a backstop. Embedded webviews throttle or stop `requestAnimationFrame` when the window is occluded, so whichever fires first wins, and it cancels the other. WebKit can throttle timers too in an occluded window. State stays current either way, and a `visibilitychange` or `focus` event flushes any pending notification at once. While the document is hidden, notifications go out at most once a second. Listeners run once per batch.
- **No-op identity:** a reducer returns the *same* state object when nothing changed. This covers:
  - the waiting poll when `service.waiting` is unchanged;
  - `notify` events, which only advance `seq` and `at` (the store already drops `liveness`). Both move to a side field that no component renders from (the only reader of `snapshot.seq`, the store's duplicate-event check at `store.ts:117`, reads the side field instead): every event advances them, so in the snapshot they would defeat every equality check;
  - the `acknowledgedReviews` wrapper, which re-applies only when it changes something.
- **Structural sharing stays as it is:** unchanged rows keep their references. This is what makes selector equality cheap.

### 2. Components read slices with a selector hook

A new `useStore(selector, equals = Object.is)` in `app/src/data/use-store.ts`:
- it is built on `useSyncExternalStore` from `preact/compat`, which the bundle already includes (the DS imports `preact/compat`), so it adds only a few lines;
- `preact/compat` has no selector variant, so the hook memoizes its selection. `getSnapshot` returns the previous selected value while the store state is the same object, or when the new selection is equal by `equals`. A fresh array or object from a selector therefore never causes a render loop;
- it re-renders its component only when the selected value changed by `equals`;
- `shallowEqual` handles arrays and objects of references;
- `memo` from the same module is likewise free to use.

`TaskContext` then carries `{ api, store }`: stable values, and no state.

```ts
const running = useStore(s => s.snapshot?.counts.running ?? 0);
const task = useStore(s => s.snapshot?.tasks.find(t => t.id === id));   // same row reference until that task changes
const repos = useStore(s => s.snapshot?.repos, shallowEqual);
```

`useTaskContext()` keeps working during migration: it reads `useStore(s => s)`, so unmigrated components render exactly as they do today. Each migrated component narrows its selector. The order of migration follows render cost, with the shell first:
1. `Layout`, `TopBar`, `StatusBar`, `AssistantHost`
2. `Dispatch`
3. `TasksPage` and `Trace`
4. Workspace and Session
5. Settings, the long tail

The root stops copying state, so `App` renders only on route and auth changes.

This follows UI-6: derived values that more than one surface needs (counts, attention ordering, the running-root grouping) become selectors in `src/view-model/`. The TUI can then share them.

### 3. Query revisions are computed once per change

`queryRevision` keeps its per-op semantics but runs once per store batch instead of once per hook per render. For example, `dispatch.list` stays keyed by `[id, state]`, so a progress tick does not refetch it.
- The store computes each revision once per batch and caches it by `(op, params)`. The cache is invalidated when the snapshot, `invalidations` or `activity` changes identity (`task.diff` and `task.session` revisions read activity). `seq` and `at` no longer move the snapshot, and some events (`message`, `plugin`, `config`) change only `invalidations`; `msg.log`, for example, must still refetch on a `message` event.
- `useQuery` reads its revision through `useStore`.

The 109 per-render `JSON.stringify` calls become one per revision kind per batch, and a query still refetches exactly when it does today.

### 4. Hidden views pause

`view-host` wraps each retained view in a `Freeze` boundary. While the view is hidden, it returns the last rendered vnode, so Preact skips the subtree.

A parent boundary cannot stop children that subscribe to the store directly, so `Freeze` also provides a `FrozenContext`. While frozen, `useStore` keeps returning its last value and records that the view is stale, and the view renders once when it is shown again. Focus and scroll restoration (`capturePosition`) stay as they are.

### 5. Clocks live in leaves

- One shared clock, `useNow(periodMs)`, runs one interval per period across the app and pauses while the document is hidden.
- Relative times render through a `<RelativeTime at=…/>` leaf. "Updated 3s ago" then re-renders a text node, not the Dispatch page.
- `Dispatch`'s `useTick` and `TopBar`'s 1 s interval move into such leaves.
- Every polling loop listed in the investigation (5 s, 2 s and 1.5 s job and config polls) pauses while the document is hidden and resumes with an immediate refresh.

### 6. Expensive leaves memoize

- `Prose` memoizes its parse by text. While an answer streams, it parses only the new tail.
- Conversation and thread rows use `memo`; the assistant conversation is already cached.
- Dispatch moves its `filter` and `sort` work into memoized selectors keyed by the task-array reference.

### 7. Optional, protocol: waiting without polling (phase 4)

The 5 s poll exists only because `service.waiting` has no event. `waiting` comes from the service's slow-I/O state, so it does not belong on `counts`. The existing `liveness` event does not fit either: it reports per-task message-broker liveness, and the app store ignores it.

The proposal is a new `service` entity event carrying `waiting`, so the client can drop the poll:
- clients that do not listen for it are unaffected, and it is listed in `hello.events`;
- protocol-compat review decides whether a new event type counts as an addition under API-1;
- the v2-compat mapping and Rust read-model parity (`crates/read-model`) still apply.

This is separate from phases 1 to 3, which need no service change.

## Measurement and validation

- **Render probe:** a dev-only render probe, compiled out of production builds, counts renders per component name. A browser test (`test/app-render-budget-browser.test.tsx`) drives the existing app fixtures and asserts:
  - an idle app with ten running tasks renders 0 times in 10 s, apart from clock leaves;
  - one `task` progress event re-renders the task's row and the counts, and does not re-render `Layout`, Settings or hidden views;
  - 50 events in one frame cause one notification;
  - a hidden document stops clock leaves and polls.
- **Baseline:** record the same counts on `main` before phase 1, and report both sets of numbers in each PR.
- **Live validation:** run CT-11 live validation on a seeded sandbox, with real SSE traffic. Record renders per second while tasks run, and check that the screens (Dispatch, Tasks, a session, Settings, the assistant, the tray) still update with the correct data.
- **Size:** UI-3 is checked on every phase. The hook, `Freeze`, `useNow` and `RelativeTime` together should cost under 1 KB gzip.
- **Desktop webview:** run the batching checks in WebKit (`PACER_TEST_WEBKIT=1`) as well as Chromium, including an occluded or hidden window.

## Phases

| Phase | Content | Risk |
|---|---|---|
| 1 | Store batching and no-op identity (§1); clocks in leaves and paused polls (§5); `Prose` memo (§6); render probe and budget test with the baseline | Low: no component API change |
| 2 | `useStore`, `TaskContext` without state, migrating the shell, Dispatch, Tasks, Trace and the assistant (§2); query revisions (§3) | Medium: stale-data bugs if a selector reads too little. Tests compare rendered output before and after |
| 3 | `Freeze` for hidden views (§4); migrating Workspace, Session, Settings and the tray | Medium: focus and scroll restore paths |
| 4 | Optional `waiting` event field and removal of the poll (§7) | Protocol: additive field (API-1), v2 and Rust parity |

Each phase is one PR. Phase 1 alone should remove most idle renders and the five-second whole-app render.

## Governance

- **Rules:** UI-3 (budgets), UI-6 (shared view model), UI-20 (DS components receive props and never import the store), ARCH-1/2, and API-1 for phase 4.
- **Reviewers:** `.project/reviewers/ui-accessibility.md` and `qa.md` on every phase, with render-count evidence for performance, plus `protocol-compat.md` for phase 4.
- **No ADR is needed** unless phase 4 is accepted. The selector hook is an app-internal convention, recorded in the app README.

## Open decisions

1. **Selector hook or signals.** `@preact/signals` gives finer-grained updates, but adds about 4 KB gzip, which would exceed UI-3 with today's headroom, and it changes the component idiom. Proposed: the selector hook on `preact/compat`'s `useSyncExternalStore` now; revisit signals only if profiling shows selector cost matters.
2. **Hidden-document cadence.** Notify every 1 s while hidden, or not at all until the document is visible (applying events to the state either way)? Proposed: 1 s, so the tray and notices stay current.
3. **Phase 4.** Is a new `service` event type acceptable as an additive change, or does it need a protocol minor version?
