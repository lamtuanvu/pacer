# Task: plan M2 wave 1, repo and config corner cases (read-only)

Executor: cursor-agent (default model). Planning across Rust and TypeScript with exact-parity constraints; too broad for a small model. Read-only: do not build, run tests, commit or push.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-wave1-plan, detached at origin/main `acab1eca4` (#870 merged). Nothing is built there; do not build.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{architecture,rust,rust-crates,api-protocol,security,code-and-testing,repository}.md`, `.project/reviewers/{architecture,protocol-compat,qa,security}.md`, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`.

Input: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/m2-waves-inventory.md, "Plan 2: Config and host" and "Proposed waves" item 1. It was written against an earlier head; recheck every claim at `acab1eca4`.

## Scope

Wave 1 covers the selective forwards that remain in `repo.list`, `repo.add`, `repo.remove`, `config.set`, `runner.set`, `project.strategy.list/get/set/remove` and `strategy.preview`. The host ops (`host.check/clean/repo.setup`) belong to wave 2; exclude them.

For each op, list every input that still forwards to TypeScript today: cite the Rust forward decision (file and line) and the TypeScript behavior Rust would have to match (file and line). Classify each as:
- **port now**: Rust can match TypeScript exactly with pure code, no plugin or Core bridge (for example legacy or unusual JSON registry shapes, YAML byte cases);
- **needs a bridge**: depends on state or capabilities only TypeScript has (for example `runner.set` model validation through `availableModels`, `config.set` `planner` install, `execution.backend` readiness, `strategy.preview` provider inputs); name the bridge and the later wave that owns it;
- **keep forwarded by design**: say why.

## Deliverable

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave1-repo-config.md` with:
1. A table per op: forwarded input, classification, Rust location, TypeScript reference, test that would prove parity.
2. A PR split for the "port now" items, each under about 1,500 changed lines, in dependency order. For each PR: files and crates touched, the CRATE-1 budget of each crate touched (count current LOC with `rg`/`wc` the way `xtask/` counts it, without running cargo), new differential tests (stdio and HTTP goldens, exact on-disk bytes, lock races), and the CT-11 live surfaces (CLI, HTTP/stdio, web settings).
3. Ledger rows in `docs/testing/m2-ledger.md` each PR would change.
4. Risks and open decisions for the maintainer, phrased as questions.
5. A ten-line summary at the top.

Mark anything you could not confirm from the code as UNVERIFIED. Report with `orca orchestration worker_done` and the plan path. Always end with worker_done.


Do the read-only planning task above. Report with orca orchestration worker_done.
