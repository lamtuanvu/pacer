# Task: independent re-review of the coordinator's fixes on wave 3 PR 1 (REPO-10)

Executor: OpenCode GLM (medium tier, glm-5.2), independent reviewer. Small scope: two commits written by the coordinator after the security and architecture reviews. You did not write them. Read-only: do not edit tracked files, commit, push, build or start live sessions. You may run `git` and read files. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr1, branch `refactor/plugin-capabilities-crate`, head `a98331845`. Review `git diff 538a53310..HEAD` (commits bd9e92e72, a98331845). Prior reviews: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr1-security-review.md (F1–F3) and /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr1-arch-review.md (N1–N6).

Intended fixes:
- Security F1: `PolicyReceipt` restored to the `pacer-plugin-host` root re-export, matching `origin/main`'s `crates/plugin-host/src/lib.rs` (compare with `git show origin/main:crates/plugin-host/src/lib.rs`).
- Arch N5: `pacer-plugin-runtime`'s `capability.rs` imports the host's `ORCA_PROVIDER` instead of its own identical constant (confirm the values were equal and every use still resolves).
- Arch N1: ADR 0026 status line now matches ADRs 0021–0024 (`Date:` plus `Status: Proposed. Accepted when the maintainer merges it.`).
- Arch N2: ADR 0026 states the runtime's size and budget (3,682; 4,500) and the host's budget (6,000), matching `.project/rules/rust-crates.md`; the #629 contrast names `bun-glob`.
- Security F2 (not taken, recorded): the ADR explains why `CredentialBindings::resolve` is `pub` and why moving `CredentialBindings` waits. Check the claim that host spawn specifications still use the credential reference check (`crates/plugin-host/src/spawn_spec.rs`, `credentials.rs`).

The coordinator ran `cargo fmt --all --check`, clippy `-D warnings` on the host, capabilities and runtime crates (clean) and the runtime tests (15 pass; the 2 Bun-fixture failures are the pre-existing `node_modules` ones listed in the handoff).

Check that each fix is correct and complete, introduces nothing else, and that the ADR text is accurate against the code and the crate table. Apply `.project/rules/{rust-crates,repository,documentation}.md` (whichever exist). REPO-4: signed off, Conventional Commits, identity Vu Lam; no machine paths or personal emails.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr1-rereview.md`: verdict (PASS, FAIL or UNVERIFIED) on the first line; scope, head, reviewer identity and model; per-fix status; new findings table (ID, rule, severity, location, evidence, remedy); what you could not check. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/rereview-wave3-pr1.md exactly. End with orca orchestration worker_done.
