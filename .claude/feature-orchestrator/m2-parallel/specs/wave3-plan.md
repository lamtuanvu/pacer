# Task: plan M2 wave 3, plugin process owner and consumers (read-only)

Executor: opencode with `opencode-go/glm-5.3` (frontier tier). Architecture-heavy planning across Rust and TypeScript; the largest dependency in M2. Read-only: do not build, run cargo, run tests, commit or push. You may use `git`, `rg`, `wc` and read files.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-wave1-plan, detached at origin/main `acab1eca4`. Another planner reads the same worktree; don't modify it.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/decisions.md`, `.project/rules/{architecture,rust,rust-crates,api-protocol,security,code-and-testing,repository}.md`, `.project/reviewers/{architecture,security,protocol-compat,qa}.md`, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`, and the ADRs under `docs/decisions/` about plugins and native ownership.

Input: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/m2-waves-inventory.md, "Plan 4: Plugin host" and "Proposed waves" item 3. Also the closed PR #629 analysis in /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/m2-stale-compare.md (section "#629") and issue #889 (`gh issue view 889`): some of that work overlaps wave 3. These were written against earlier heads; recheck every claim at `acab1eca4`.

## Scope

Wave 3 covers: the 12 plugin operations (`plugin.list`, `plugin.doctor`, `plugin.ui.list`, `plugin.settings.get/set`, `plugin.enable/disable/remove/install`, `plugin.ui.render/action/visibility`), which are native over HTTP but forwarded over stdio; making the native plugin process owner (`PACER_NATIVE_PLUGIN_HOST`) the default; and moving its consumers (usage readers, doctor, setup, planners) onto it. Find:
1. What exactly is native today per op and transport, what forwards, and why (file:line in Rust and TypeScript).
2. What the default-off process owner lacks before it can be on by default: conformance, IPC authorization, crash and restart, snapshot nesting, authority lifetime, deep JSON, process cleanup. Cite tests that exist and name the missing ones.
3. Each consumer of the TypeScript plugin host that must move, and in what order.
4. CRATE-1: `pacer-plugin-host` is about 11,700 LOC (near the 12,000 split line). Propose the crate split this wave needs (capabilities versus runtime, or another seam), with layers, and check it against `.project/rules/rust-crates.md` and the #629 split that was rejected (why it conflicted).

## Deliverable

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave3-plugin-host.md` with:
1. A ten-line summary at the top.
2. Per-op table: transport, native or forwarded, reason, Rust location, TypeScript reference, parity test that exists or is needed.
3. Default-on readiness gaps, each with evidence and the test or change that closes it.
4. A PR split in dependency order, each PR under about 1,500 changed lines: title (Conventional Commit), files and crates, CRATE-1 budget per crate (count LOC with `rg`/`wc` as `xtask/` counts it), new differential tests (stdio and HTTP goldens, exact on-disk effects, concurrency, crash), and CT-11 live surfaces (CLI, HTTP/stdio, web plugin UI, plugin settings). Mark which PRs can run in parallel.
5. The crate split proposal and whether it needs an ADR or a constitution amendment.
6. Ledger rows each PR changes.
7. Risks and open decisions for the maintainer, phrased as questions with a recommended answer.

Mark anything not confirmed from the code as UNVERIFIED. Report with `orca orchestration worker_done` and the plan path. Always end with worker_done.


Do the read-only planning task above. Report with orca orchestration worker_done.
