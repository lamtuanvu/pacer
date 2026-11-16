# Task: keyboard check of the changed Dispatch and Needs you managed actions

Executor: codex (independent UI reviewer; not the implementer). Small task: every row below must have an observation before you report, so don't stop early.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head f5168b0f9. The app is unchanged since 4d11aeb82. Check that `git status --short` is clean. This branch changed `app/src/screens/dispatch/Dispatch.tsx` (`git diff a8331c6b4 HEAD -- app/src/screens/dispatch/Dispatch.tsx`):
- `dispatch.answer` actions render as an Answer link to `#/workspace?task=<id>`;
- `dispatch.retry` renders the Retry `ActionButton` when the service lists the op, and an "Open task" link when it does not.

On the board (`#/`) a card shows one action (the destination `ButtonLink`). On the standalone Needs you page a card shows two actions through `itemActions`. Reuse the probe and fixture setup of `.work/reviews/m2-integration-ui-kb-live-b.md`: session setup, the managed failed and question fixtures, and the headless Chrome keyboard script `.work/kb-b-actions.ts` or `.work/focus-compare.ts`. For the missing operation, reuse `.work/ui-a11y-missing-proxy.cjs` (it removes one named op from hello and forwards through the guarded public proxy).

| Row | Surface | Required observation |
| --- | --- | --- |
| 1 | Needs you page, managed question card | Tab reaches Answer link; focus visible (outline and contrast against surroundings); Enter navigates to `#/workspace?task=<id>`; record activeElement after navigation |
| 2 | Board `#/`, managed question and managed failed cards | Tab reaches the destination ButtonLink; focus visible; Enter navigates to the stated destination |
| 3 | Needs you page, managed failed card, op present | Tab reaches Retry button; Enter and Space each run `dispatch.retry` once (one request, HTTP 200; use separate fixtures per key); record activeElement after success (BODY is a known pre-existing pattern after successful managed actions; record, do not classify) |
| 4 | Needs you page, managed failed card, `dispatch.retry` missing (proxy) | No Retry button; "Open task" link present; Tab reaches it, focus visible, Enter navigates to `#/workspace?task=<id>` |
| 5 | Needs you page, managed question card, `dispatch.answer` missing (proxy) | Record what renders for the Answer action and whether it is keyboard-reachable and activatable |
| 6 | Light and dark, 1440 and 375 widths, rows 1 and 4 | Focus ring visible in each; screenshot per case |

Rules:
- Start with `bun run live up --front-door rust --native-test-ops --seed ui`, with the real CARGO_HOME and RUSTUP_HOME, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4, TZ=Asia/Ho_Chi_Minh and a disposable HOME and PACER_HOME.
- Do NOT wrap `live up` in sbx-deny. Sandbox only scratch commands that don't start their own sandbox.
- Use session ids prefixed `kb-dispatch-` and run one session at a time. Stop everything you start, including the proxy and Chrome.
- Don't edit tracked files.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or the model ports.

Write `.work/reviews/m2-integration-ui-kb-dispatch.md`:
- a verdict (PASS, FAIL or UNVERIFIED) for each row, with evidence paths (probe JSON, screenshots);
- contrast numbers;
- the harness report Summary line;
- the cleanup.

Report with orca orchestration worker_done. Always end with worker_done.


Carry out the independent review described above and write the report.
