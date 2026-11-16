# Task: independent security review of owner parity PR A — seal native owner calls with the TypeScript owning-call authority (REPO-10)

Executor: cursor-agent (default model, frontier tier). Security review: capability authority and secrets. Read-only: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-a, branch `fix/owner-call-authority`, head `72d0f8df9`, three commits on wave 3 PR 6 at `2951c0aeb` (`eed652db3` seal owning calls, `ec98d8174` assistant secrets and signatures from Core flag-on, `72d0f8df9` docs).

Inputs:
- Handoff with the per-capability authority table and the assistant key path: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-a-handoff.md.
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-a.md (maintainer decisions Q1 and Q4).
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md ("PR A", items 1, 2, 6, D1).
- PR 6 review N1: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-review.md.
- Project rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,code-and-testing,repository,architecture}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`. Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **Admission (items 1, N1):** with manifest auto-issue removed, no scoped capability of any kind (the handoff says 67 scoped methods) is answered outside an owning call, flag-on, on both the serve and stdio owner doors, including calls with no host-issued resources and lazily started children. Check the explicit-wildcard seal (`explicitWildcardGrant`) cannot widen a grant beyond what TypeScript allows. Confirm nothing that worked flag-off now breaks flag-on because a previously auto-issued resource is gone (search Core's issuers and the consumers in PR 6's matrix).
2. **Secrets and signatures (item 2, Q1):** Core now answers `capability.secrets.resolve` and `capability.identity.sign` flag-on. Q1 approved only the assistant's resolved API key crossing Core's own bridge connection for its own call. Verify:
   - which callers and plugins can reach these two answers; that it is limited to the owning call that was issued the alias or identity, exactly as TypeScript scopes them, and nothing else (keyed or keyless `endpoint.models`, `endpoint.test`, `classifier.ask` stay refused as PR 4 left them);
   - `identity.sign`: was it in the maintainer's Q1 scope? State what it signs, with which key, for whom, and whether any plugin could obtain a signature it couldn't get flag-off. The worker flagged an "undeclared identity.sign audit" follow-up — assess whether it is blocking;
   - the key is never logged, persisted, echoed in errors or replies, retained after the call, or readable by a concurrent call, another plugin, or an unsealed `_host.plugin.call` (remember PR 5's R1 shared-session issue, fixed separately in PR B but not in your base);
   - the bridge connection the key crosses is Core's own; consider a same-uid peer on the socket (#918 is not fixed yet: is the key reachable by such a peer during the call window?) and state the residual risk until PR G.
3. **Refusal text (item 6, Q4):** exact TypeScript text only for the no-owning-call refusal; per-resource refusals keep their text with equal codes.
4. **Overlap with PR B:** PR A adds one seal line to `crates/server/src/native/plugins.rs` `call_native`, which PR B rewrote onto `call_sealed`. Identify what that line must become after the rebase onto B (B's door call path) so the door's native calls also carry the owning-call seal and secrets/identity forwarding — the worker's `DOOR_SECRET_TEXT` follow-up. Say whether PR A is safe to merge before or after B and what must change at rebase.
5. Tests: every new or flipped test fails without its fix (rerun at least the admission and the key-scoping mutations); CT-11 evidence names this head and shows 0 listener hits and 0 key hits; docs, ledger, CHANGELOG and ADR 0027 accurate; no machine paths or personal emails; commits signed off and Conventional.

## Checks

Inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`, both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` with `--features test-ops`): clippy `-D warnings` and tests for `pacer-plugin-runtime` and any crate the PR touches; `bun run typecheck`; `test/plugin-conformance-native-owner.test.ts`, `test/plugins-native-owner-matrix.test.ts`, `test/serve-plugin-native.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/native-plugin-ops.test.ts`, `test/native-plugin-ops-stdio.test.ts`, the assistant tests the handoff names, `test/plugin-conformance.test.ts`. Report counts. `native_run` tests fail inside sbx-deny for a known sandbox reason (setuid `/bin/ps`); note, don't chase. One cargo command at a time; keep memory modest.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real API key or real Keychain item.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-a-review.md: verdict (PASS / FAIL / UNVERIFIED) against `72d0f8df9`, findings with severity (blocking / nonblocking / nit) and code references, the rebase guidance for item 4, and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/review-parity-a.md exactly. End with orca orchestration worker_done.
