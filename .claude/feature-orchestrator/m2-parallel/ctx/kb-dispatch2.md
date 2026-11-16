# Task: keyboard check of the reachable changed Dispatch board controls (corrected scope)

Executor: codex (independent UI reviewer; not the implementer). Small task: every row below must have an observation before you report, so don't stop early.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, head f5168b0f9. Check that `git status --short` is clean. Read `.work/reviews/m2-integration-ui-kb-dispatch.md` (previous attempt) and reuse its probe `.work/kb-dispatch-probe.ts`, the seeds `.work/reviews/kb-dispatch/seed*.jsonl` and the missing-op proxy `.work/ui-a11y-missing-proxy.cjs`.

Corrected scope, from code (`app/src/screens/dispatch/Dispatch.tsx` lines 59-91 and `crates/read-model/src/attention.rs` lines 190-240). `NeedsYouList` renders only on the board `#/`, with one action per card.
- A card whose item has a task id and kind question, failed or review shows a destination `ButtonLink`.
- Otherwise it shows `itemActions`. A managed task in state `limit` produces an item of kind `limit` with first action `dispatch.retry` and no destination.
- That limit card is where this branch's change is reachable: a Retry `ActionButton` when hello lists `dispatch.retry`, and an "Open task" link to `#/workspace?task=<id>` when it doesn't.
- The board shows at most three cards, so seed only the fixtures each row needs (for example one managed `limit` task and one managed question task) so they appear in the top three.
- The `#/needs-you` page (NeedsYou.tsx) is unchanged by this branch and out of scope.

| Row | Required observation |
| --- | --- |
| A | Board, managed `limit` card, op present: a Retry button renders; Tab reaches it; focus is visible (outline contrast against the card and page); Enter runs `dispatch.retry` once (one request, HTTP 200); on a second fresh `limit` fixture Space does the same; record activeElement after each |
| B | Board, managed `limit` card, `dispatch.retry` removed via the proxy: no Retry; an "Open task" link renders; Tab reaches it; focus visible; Enter navigates to `#/workspace?task=<id>`; record activeElement |
| C | Board, managed question card: the "Answer" destination ButtonLink renders; Tab reaches it; focus visible; Enter navigates to `#/workspace?task=<id>` |
| D | Screenshots of the focused control in rows A and B at 1440 and 375 widths, light and dark (8 PNGs); visually inspect each and record the outline's computed contrast |

If the read model does not produce a `limit` card from your seed, show the seeded task JSON and the snapshot's attention item, and explain. Don't substitute another control.

Rules:
- Start with `bun run live up --front-door rust --native-test-ops --seed ui`, with the real CARGO_HOME and RUSTUP_HOME, CARGO_INCREMENTAL=0, CARGO_BUILD_JOBS=4, TZ=Asia/Ho_Chi_Minh and a disposable HOME and PACER_HOME.
- Do NOT wrap `live up` in sbx-deny.
- Use session ids prefixed `kb-dispatch2-` and run one session at a time. Stop everything you start, including the proxies and Chrome.
- Don't edit tracked files.
- Never touch the maintainer's real pacer install, ~/.pacer, com.pacer.serve, port 4317 or the model ports.

Write `.work/reviews/m2-integration-ui-kb-dispatch2.md`:
- a verdict for each of rows A–D, with evidence paths;
- contrast numbers;
- the harness report Summary line;
- the cleanup.

Report with orca orchestration worker_done. Always end with worker_done.
