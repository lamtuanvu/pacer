# Task: plan M2 wave 2, host effects (read-only)

Executor: opencode with `opencode-go/glm-5.2` (medium tier). Bounded planning for three forwarded ops plus a bridge. Read-only: do not build, run cargo, run tests, commit or push. You may use `git`, `rg`, `wc` and read files.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-wave1-plan, detached at origin/main `acab1eca4`. Another planner reads the same worktree; don't modify it.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{architecture,rust,rust-crates,api-protocol,security,code-and-testing,repository}.md`, `.project/reviewers/{architecture,security,qa}.md`, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`.

Input: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/m2-waves-inventory.md, "Plan 2: Config and host" (the `host.*` rows) and "Proposed waves" item 2; issue #889 (`gh issue view 889`) for the SSH transport that is not on main. Written against earlier heads; recheck every claim at `acab1eca4`.

## Scope

`host.check`, `host.clean`, `host.repo.setup` are forwarded because Core has no host effects bridge (`/_internal/host-effects`, `_internal.host.effects`); the Rust logic in `pacer-config-ops::host_check_clean_setup_ops` is unregistered. `host.terminal` stays separate (desktop dependent); plan it only as a later, separate item. Find:
1. Each effect the three ops need from Core (probe, clone, identity, transfer, cleanup), where TypeScript does it (file:line), and what the unregistered Rust code already covers.
2. The bridge design: route names, sealing (as other `_internal` bridges use `PACER_NATIVE_CONFIG_SYNC_KEY`), deadlines, error mapping, and why it is transitional. Compare with existing bridges (for example `/_internal/service-effects`, `/_internal/msg-effects`).
3. Security: remote command construction, path and argument injection, credential handling, what runs on the remote host. Cite SEC rules.
4. How to live-validate with disposable local fixtures only (no real remote unless the maintainer authorizes it).

## Deliverable

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave2-host-effects.md` with: a ten-line summary; per-op table (effect, TypeScript reference, Rust coverage, gap); bridge design; a PR split in dependency order, each under about 1,500 changed lines (title, files and crates, CRATE-1 budget per crate counted with `rg`/`wc`, differential tests over stdio and HTTP with exact on-disk effects, CT-11 live surfaces), marking which PRs can run in parallel with wave 1 and wave 3; ledger rows changed; risks and open decisions as questions with a recommended answer. Mark anything not confirmed from the code as UNVERIFIED. Report with `orca orchestration worker_done` and the plan path. Always end with worker_done.


Do the read-only planning task above. Report with orca orchestration worker_done.
