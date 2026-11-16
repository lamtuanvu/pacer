# Task: owner parity PR A — seal native owner calls with the TypeScript owning-call authority

Executor: cursor-agent (default model, frontier tier). Security-sensitive: capability authority and secrets. No subagents. No time limit; finish implementation, tests, live validation and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-a, branch `fix/owner-call-authority`, stacked on wave 3 PR 6 (`test/native-owner-consumer-matrix` at `2951c0aeb`; a tests-and-docs fix round on PR 6 is running and you will be rebased onto it, then onto `main`). PRs B (`fix/owner-sealed-door-calls`: `crates/server/src/native/plugins.rs`, `bridge_call.rs`, `owner.rs`, `registry.ts` `nativeSpawnSpec`/`callNativeOwner` log tag, `src/serve/plugin-native.ts` log level), C (stderr log) and D (framing) are done and under review on sibling branches; keep your `registry.ts` changes to the functions the plan names for A so the later rebase stays small. Run `bun install --frozen-lockfile` first. Build only the crates you touch (one cargo command at a time, `CARGO_INCREMENTAL=0`, `CARGO_BUILD_JOBS=4`); never release or `--workspace` builds. Other Rust workers run at the same time; keep memory modest.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,repository,architecture}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`, ADR 0027, `docs/testing/m2-ledger.md`, `docs/testing/live-validation.md`, and:
- The plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md — maintainer decisions at the top, "PR A" in §2, and the §1 triage of items 1, 2, 6 and D1 (root causes, TypeScript references, tests).
- PR 6 review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-review.md, N1: Core auto-issues a granted manifest's exact `net.http` hosts **and exact `fs.read` paths** for any owner call without host resources (`autoIssueFromManifest`); a ping read an exact-path file flag-on where TypeScript refuses.
Recheck every cited file:line against your base. If the code contradicts the plan, follow the code and record the deviation; stop and ask through `orca orchestration` only if a deviation changes the security model.

## Maintainer decisions that apply

- Q1: the assistant's resolved API key may cross Core's own bridge connection to the owner (0600 socket, same uid, then the child's stdin). Do not port the Keychain lookup into the owner. Only the assistant path gets this; every other credential-bound call stays refused exactly as PR 4 left it (keyless/keyed `endpoint.models`, `endpoint.test`, `classifier.ask`). The key must never be logged, persisted, echoed in errors, or reachable by any other call or plugin; scope it to the one owning call and drop it when the call ends.
- Q4: exact TypeScript text only for the no-owning-call refusal ("scoped capability requires an active owning call"); per-resource refusals inside an owning call keep their current text with equal codes.

## Scope

As "PR A" in the plan: items 1 (with N1's `fs.read` half), 6 (per Q4), 2 (per Q1), D1, and the explicit wildcard seal. An owner call carries the same owning-call authority TypeScript gives it: no scoped capability (`net.http`, `fs.read`, and every other scoped kind) is answered for a call that TypeScript would refuse, including calls with no host-issued resources. Audit every capability kind in `crates/plugin-runtime/src/capability.rs` (`core_capability`, `session_for_call_in`, `answer`) and the TypeScript issuer (`src/plugins/native-call-authority.ts`, `registry.ts` `nativeIssueCallAuthority`, `callNativeOwner` `coreMethods`) and state per kind what is admitted and why.

## Tests

Flip `ROUTED_HTTP`, the exact-path `fs.read` case (added by the PR 6 fix round; if it isn't in your base yet, add your own) and the no-owning-call `ROUTED_MESSAGE` cases to plain passing tests; the matrix assistant row flips; a zero-listener-hits check; the Rust empty-resources refusal; a test that the assistant key is not visible to a concurrent or later call or another plugin and does not appear in logs or error text; keyed and keyless endpoint/classifier calls still refused. Every new test fails without its fix; save red logs.

## Checks

Serial inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer` (real CARGO_HOME, RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`. Both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`); report counts that ran. The PR 6 conformance and matrix tests may still use fixed `/tmp/pcn` and `/tmp/pom-<row>` roots in your base; other workers run them too, so if a run fails with a vanished home, rerun once and say so. `cargo fmt --all --check`; clippy `-D warnings` and tests for `pacer-plugin-runtime` and any crate you touch; `cargo xtask loc --check` (state CRATE-1), `cargo xtask deps`; `bun run typecheck`; `test/plugins-native-owner-matrix.test.ts`, `test/plugin-conformance-native-owner.test.ts`, `test/serve-plugin-native.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/native-plugin-ops.test.ts`, `test/native-plugin-ops-stdio.test.ts`, assistant tests, `test/plugin-conformance.test.ts`; `git diff --check`. Save logs under `.work/fixtures/parity-a/` in this worktree.

## Live validation (CT-11)

Per the plan's PR A: on a `bun run live up --front-door rust --native-plugin-host` sandbox install an HTTP-scoped fixture plugin, grant `net.http`, run `plugin.doctor`, capture refusal text and listener hits on both doors; the same for an exact `fs.read` path; an assistant turn against the sandbox endpoint fixture (security stub Keychain, fake key per SEC-2) answers flag-on, and the key appears nowhere in sandbox logs; a flag-off sandbox with the same steps and text; `bun run live report`. Temporary sandboxes only; never ports 4317, 11434, 1234, 41343; tear down and confirm no processes, sockets or sidecars remain. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app` or `com.pacer.serve`.

## Commits and output

Conventional Commits, signed off (`git commit -s`, identity Vu Lam <lamtuanvuqs@gmail.com>), small logical commits. Do not push. Never commit `.work/`. No machine paths or personal emails in tracked files. Update the ledger and CHANGELOG (REPO-7), and ADR 0027 if the secret crossing needs recording.

Write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-a-handoff.md`: commits, per-file changes, the per-capability-kind authority table, the assistant key's path and lifetime with code references, deviations, test results with counts and red evidence, LOC and CRATE-1 text, live report summary with UNVERIFIED items, follow-ups, and a draft PR body following `.github/pull_request_template.md` (include the executor and model tier line). Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-a.md exactly. End with orca orchestration worker_done.
