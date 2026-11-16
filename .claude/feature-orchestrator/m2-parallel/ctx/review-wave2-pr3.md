# Task: independent review of M2 wave 2 PR 3, native host repo setup (REPO-10)

Executor: cursor-agent (default model, frontier tier). Security-sensitive: a consent-gated remote clone and identity write routed over the sealed host-effects bridge. Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr3, branch `feat/native-host-repo-setup`, one commit `6d588c5c9` on `077e4fb23` (#913). `origin/main` has since moved to include #901 (`874873f97`); conflicts are the coordinator's job, but note any semantic overlap you see with #901's `native.rs` / `serve` / ledger changes.

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave2-pr3-handoff.md.
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/wave2-pr3.md.
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave2-host-effects.md ("PR 3", §3 security, §5, §6).
- PR 2's review and re-review for the patterns this follows: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr2/.work/reviews/wave2-pr2-review.md and `wave2-pr2-rereview.md`.
- Project rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,repository,architecture}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`. Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **Consent gate:** `consent` must be literal `true`; every other value (missing, `false`, `"true"`, `1`, null, extra wrapper) is refused natively with the TypeScript error body byte for byte, and no effect or core trace happens. No path reaches the bridge without it.
2. **Refusal order and bodies:** enforcement token, unknown alias, non-canonical key, repo-not-mapped: native replies byte-identical to the TypeScript core in the same order the core checks them. Work-grant callers forward.
3. **Admitted routing:** HTTP admitted → whole-operation bridge kind `host.repo.setup` with the original params; stdio admitted → forwarded. The bridge call carries no extra authority; `clone`/`identity` params pass through unchanged; the consent-preview mismatch (`capability_denied: configured clone changed after consent`) passes through.
4. **Tests:** `test/native-host-setup-parity.test.ts` and the Rust tests really compare native vs forwarded (replies, job file steps, the fake host checkout, `git config --local`, `host-checks.json`, the exists-skip and identity-only variants); rerun at least the consent mutation yourself and confirm it goes red.
5. Registration consistency: `native.rs` OPS and predicate, `native/tests/mod.rs`, `serve/tests/listener.rs`, `test/native-dispatch.test.ts`; why did `serve/tests/listener.rs` change?
6. Ledger 160/86/71 and row 15 wording, CHANGELOG folded into the existing bullet; CRATE-1 text; no machine paths or personal emails; commit Conventional and signed off.
7. CT-11: live report (4 PASS, 4 UNVERIFIED) claims match the code and plan §6.

Run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_TEST_NATIVE_FRONT_DOOR` unless pointing it at your own `cargo build -p pacer --features test-ops` copy in a temp dir. One cargo command at a time, debug only. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`; never ports 4317, 11434, 1234, 41343; never a real SSH host.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave2-pr3-review.md: verdict (PASS / FAIL / UNVERIFIED) against `6d588c5c9`, a findings table (ID, severity blocking/nonblocking, code reference, evidence, fix), and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.
