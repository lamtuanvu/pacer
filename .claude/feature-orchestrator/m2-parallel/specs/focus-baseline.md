# Task: is the post-action focus loss introduced or pre-existing? (base vs head)

Executor: codex. No time limit; finish both revisions and the comparison before reporting. Investigation only; do not change tracked files.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head 4d11aeb82, base origin/main 445241520. Read finding 1 in .work/reviews/m2-integration-ui-kb-live-b.md and its probe/evidence (session id and actions.json are cited there): after a successful managed action the active element became BODY for (a) Trace `#/tasks/<id>` Accept result (Enter and Space), (b) Trace Reject result via the reject dialog (Space), (c) Workspace task result Retry dialog "Retry task" submit (Space).

Suspect: this branch changed `useResultAction` in app/src/screens/review/ResultPage.tsx (`git diff 445241520 HEAD -- app/src/screens/review/ResultPage.tsx app/src/screens/task-shared.tsx`) to return before calling `done(...)` when the component unmounted during the request. Read the `done` callbacks passed by app/src/screens/trace/TaskActions.tsx, failure/Failure.tsx and the workspace Retry dialog, and state whether any of them moves focus, navigates or re-renders a focus target.

## Steps
1. Reproduce (a), (b), (c) at HEAD with the kb-live-b probe (reuse its script under .work/), session id `focus-head-`, `bun run live up --seed ui --front-door rust --native-test-ops`; record activeElement immediately after the response and after 1 s, plus whether the initiating component unmounted (MutationObserver or isConnected on the button).
2. Reproduce exactly the same three on base: scratch detached worktree of 445241520 (`git worktree add --detach /tmp/pacer-base-focus 445241520`), `bun install --frozen-lockfile`, `bun run live up --seed ui` with the TypeScript front door (no cargo build; the app UI is the same bundle source either way), session id `focus-base-`, same fixtures. Remove the scratch worktree afterwards.
3. Classify each: pre-existing (BODY on base too), introduced (base keeps a meaningful focus target), or inconclusive (explain). If introduced, name the exact line and the minimal fix (e.g. still run focus-restoring `done` work, or move focus to a stable target), but do not implement it.

Rules: under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny where possible, TZ=Asia/Ho_Chi_Minh, disposable HOME/PACER_HOME, Orca's built-in browser or the probe's headless Chrome; one live session at a time; never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or model ports; no cargo; stop everything you start.

Write .work/reviews/m2-integration-focus-baseline.md: per scenario base vs head activeElement with evidence paths, the `done` callback analysis, classification, and if introduced the proposed fix. Report with orca orchestration worker_done. Always end with worker_done.


Carry out the task described above.
