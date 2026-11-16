# Task: owner parity PR A — rebase onto PR B and close the security review findings (fix round 1)

Executor: cursor-agent (default model, frontier tier). Security-sensitive: capability authority and secrets. No subagents. Finish the rebase, fixes, tests, live validation and the handoff update before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-a, branch `fix/owner-call-authority`, head `72d0f8df9`. A's own commits are `eed652db3`, `ec98d8174`, `72d0f8df9` on top of the old wave 3 PR 6 head `2951c0aeb`. Run `bun install --frozen-lockfile` after rebasing. Build only the crates you touch (one cargo command at a time, `CARGO_INCREMENTAL=0`, `CARGO_BUILD_JOBS=4`); never release or `--workspace` builds. Other Rust workers run at the same time; keep memory modest.

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,repository}.md`, ADR 0027, and:
- Your original brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-a.md.
- Your handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-a-handoff.md.
- The security review (verdict PASS): /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-a-review.md. §4 "Overlap with PR B, and rebase guidance" is your rebase recipe; §Findings lists N1–N9.

## 1. Rebase onto PR B

PR B (`fix/owner-sealed-door-calls`) is reviewed PASS and now sits at `c28deb114`, on wave 3 PR 6 (#931) head `8904de8bf`, which is current `main` plus PR 6. Rebase A's three commits onto it:

```
git rebase --onto c28deb114 2951c0aeb
```

Follow review §4:
1. Drop A's seal line in `crates/server/src/native/plugins.rs`; that code no longer exists in B.
2. Move `session.seal_call_authority(...)` out of `call_sealed` into B's `prepare_sealed`, immediately after `session_for_call_in(...)` and before `bind_core_methods` and the hello, using `&sealed.authority`, so one line seals both the bridge and the door.
3. Resolve the expected conflicts (§4 item 5): `test/plugin-conformance-native-owner.test.ts` (keep B's `ROUTED_OBSERVATIONS` and doctor rows; drop `ROUTED_HTTP`/`ROUTED_MESSAGE` as A did, if the cases pass), `test/serve-plugin-native.test.ts`, `test/plugins-native-owner-call.test.ts`, `docs/testing/m2-ledger.md`, `CHANGELOG.md`, `registry.ts`. Keep both sides' intent; never take one side wholesale where the other side edited existing lines.

## 2. Close the review findings

- **N3.** Add a door test in `crates/server/src/native/plugins/tests.rs`: a door call without an owning call gets the TypeScript text "scoped capability requires an active owning call"; an owning one (a plugin that declares `hosts`, or an observation plugin) does not. Show it fails with the seal line removed.
- **N2.** Audit the undeclared `identity.sign` refusal flag-on as flag-off does (`refuseSign(…, "capability not declared")`, `src/plugins/host.ts:52`), so the signature audit log matches across modes. Add a test.
- **N4.** If B's sealed door path now reaches Core for the scenario, add a TypeScript-origin concurrent check that another plugin cannot get the assistant key; otherwise record why it still cannot be exercised.
- **N5 (nit).** Pin Core's `onRequest` name check (`registry.ts`, `coreMethods.includes(name)`) with a test, or record why not.
- **N6, N7.** In the handoff PR body, name the CT-11 head and correct the `pacer-plugin-runtime` test count to what actually ran.
- **N8.** CHANGELOG: "keeps a declared `*` host scope only inside an owning call" → say it "may use" it; ADR 0027: add the caveat that until the bridge authenticates callers (#918, PR G) a same-uid peer could reach the resolved key.
- **N1, N9** are handled by PR G and PR B/F respectively; do not fix them here, but keep the ADR caveat accurate.
- **DOOR_SECRET_TEXT** (§4 item 4) is out of scope: a separate PR H makes the serve door relay `plugin.doctor`/`plugin.ui.*` to Core. Keep the door failing closed with the owner's text and code.

## 3. Validate

Run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`, with both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`). Known: `native_run` capability tests fail in sbx-deny (setuid `/bin/ps`); the matrix "PR 4 endpoint shapes" activity-order race is pre-existing (rerun once and say so).

Required: `cargo fmt --all --check`; clippy `-D warnings` and tests for `pacer-plugin-runtime`, `pacer-server`, `pacer-endpoints`; `bun run typecheck`; `test/plugin-conformance-native-owner.test.ts`, `test/serve-plugin-native.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/plugins-native-owner-matrix.test.ts`, `test/plugin-conformance.test.ts`, and the assistant-key e2e test. Rerun the review's §4 list: `owning_call_authority` and `native_host_session`, the conformance relay cases on both doors, the assistant-key e2e, and the matrix assistant and planner rows. Every new test needs red evidence.

CT-11: rerun live validation on the rebased head following `docs/testing/live-validation.md` (`bun run live`), flag on and off, covering the owning-call seal on the door and the assistant secret/signature answers. Name the head in the report. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real API key or Keychain item. Tear down every process you start.

## Output

Commit with `git commit -s` (Conventional Commits). Do not push. Append a "Fix round 1" section to /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-a-handoff.md (rebase notes, per-finding status, tests, red evidence, CT-11 summary) and update its draft PR body. Report with `orca orchestration worker_done`. Always end with worker_done.
