# Task: fix round 1 for the #629 salvage port

Executor: cursor-agent (default model). Rust fixes with parity tests plus a live rerun; not a small task. No time limit; finish fixes, checks, live rerun and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, branch `fix/port-629-salvage`, head `5f2d2fd78` on origin/main `acab1eca4`. Reuse its `target/`.

Read both reviews in `.work/reviews/` of the worktree in full: `port-629-review-sec.md` (B1, N1–N5, P1) and `port-629-review-qa.md` (F1–F7), plus your earlier handoff `port-629-salvage-handoff.md`. Same rules and constraints as the original brief (`/Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/port-629-salvage.md`).

## Coordinator decision on host cleanup (B1 and F5)

Match TypeScript `src/plugins/host-lease.ts`: a failed or invalid open with no provider session retires that open cleanly, and close failures retire the session regardless of the cleanup result (TypeScript line ~176), so nothing becomes sticky in `native_hosts.rs`. Remove the sticky `cleanup_failure` from the host path, or keep it only where TypeScript also refuses. The result must be that after a failed `open(B)` or a failed close, `close(A)` of a healthy session still reaches the provider. Update or replace `default_provider_cannot_certify_settled_open_failure` accordingly. Add regression tests: failed `open(B)` then `close(A)` succeeds with provider close count 1; failed close of A then `close(C)` still works. Wiring `NativeHosts::revoke` into runtime teardown (P2) is out of scope; note it for a follow-up issue in the handoff.

## Fixes

1. B1 and F5, as decided above.
2. N3: retire the session when `fetch` fails, as `HostLeaseBroker.fetch` does; add a test.
3. N4: test the snapshot-change retire before `run` (assert one provider close).
4. N1 and F4: add a broker-level test proving the production write path rechecks authority (an expired deadline at or before commit leaves the target absent). If that needs a seam, add the smallest test-only seam (for example `#[cfg(test)]` or a deadline the test controls); if none is possible without production complexity, explain in the handoff.
5. N2: track whether `renameat` ran. Before commit, a missing stage sets the sticky write failure as TypeScript does; after commit, skip the probe. Add a test.
6. P1: give process capture (`native_process.rs` `capture.write_bytes`) the deadline guard, as `capability-spawn.ts` does with `writeOwnerBytes`, and add a test.
7. F7: assert the specific limit error in `stdout_and_stderr_each_enforce_the_incremental_one_mib_limit`; give `native_orca_parameter_boundaries_match_actual_zod_codepoints` a `Drop` guard for its temp root.
8. F1: CHANGELOG `[Unreleased]` → `### Fixed` entries as F1's remedy describes (Rust front-door task rows; the flag-on plugin-host changes). Keep the wording plain and accurate to the final code.
9. F2: rerun live (session ids `live-port629-r1-rust` and `live-port629-r1-ts`) with a probe task carrying both `placement` and `question {text, at}`; capture row keys from `snapshot.get` and `GET /v3/snapshot` on both front doors and add a report row comparing them.
10. F6: rewrite the four commits authored as `vulam@Vus-MacBook-Pro-2.local` to `Vu Lam <lamtuanvuqs@gmail.com>` with a matching single `Signed-off-by`. The repository-local git config now carries that identity; check with `git config user.email` before committing. If you use a disposable HOME, commit outside it or pass `-c user.name=... -c user.email=...`. No commit on the branch may show the hostname address afterwards (`git log --format='%ae %ce %b' origin/main..HEAD | rg -i local`).

New fixes go in new signed commits (Conventional Commits); the identity rewrite is the only history rewrite. Do not push.

## Checks

As before, serial in sbx-deny with disposable HOME and PACER_HOME: fmt, clippy `-D warnings` for touched crates, `cargo test -p` for each touched crate (`native_run` may fail inside sbx-deny for the known `/bin/ps` reason; run it outside sbx-deny too and record both), `bun run typecheck`, the Bun tests touched, `cargo xtask loc --check` (record plugin-host LOC), `git diff --check origin/main..HEAD`.

## Handoff

Append a "Fix round 1" section to `.work/reviews/port-629-salvage-handoff.md`: per finding what changed (commit) or why not, tests added with red-without-fix evidence, check results, live session ids, report paths and Summary lines, plugin-host LOC, the CRATE-1 "why and named split" text for the PR description, follow-ups for the coordinator to file (P2 revoke wiring, any others), UNVERIFIED items. Report with `orca orchestration worker_done`. Always end with worker_done.
