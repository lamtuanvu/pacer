# Task: M2 wave 2 PR 1 — serve host check, clean and repo setup on the internal host-effects bridge (TypeScript)

Executor: cursor-agent (default model). Security-sensitive TypeScript bridge with auth sealing and fake-ssh tests; not a small task. No time limit; finish implementation, tests and the handoff before reporting.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave2-pr1, branch `feat/host-effects-bridge` at origin/main `acab1eca4`. TypeScript only: run `bun install`; do not build Rust (four Rust workers are running; disk and memory are shared).

Read first: AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,code-and-testing,repository}.md`, `.project/reviewers/{security,qa}.md`, `docs/testing/m2-ledger.md`, and the plan `/Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave2-host-effects.md` in full, especially §2 (bridge design), §3 (security), "PR 1" and §7. The maintainer accepted all eight recommendations (Q1 whole-operation kinds; Q2 ship the sealed stdio method now; the rest apply to later PRs). Recheck every cited file:line; the plan was read, not run.

## Scope (PR 1 only)

- New `src/api/host-effects-bridge.ts`: request `{"request": {"kind": "host.check" | "host.clean" | "host.repo.setup", "params": {…}}}`; dispatch to the exact reference operations (`core.hosts.checkJob`, `cleanJob`, `setupJob`), so the reply, `{job}` shapes, error codes, hints and on-disk effects equal a direct call. Invalid kind → `invalid_input`. No new command text; params pass through to the reference op's own validation.
- HTTP `POST /_internal/host-effects` beside the existing `service-effects` route in `src/serve/http.ts`, with the same sealing: internal bearer token, `x-pacer-auth: bearer` only, cookie or task auth refused as every internal route does. No deadline added.
- stdio `_internal.host.effects` beside `_internal.msg.effects` in `src/api/stdio.ts`, sealed by `PACER_NATIVE_CONFIG_SYNC_KEY`; a wrong key or `PACER_WORK_GRANT` answers `unknown_op`, exactly like the existing sealed methods.
- No Rust changes, no ledger totals change (internal route only). Do not register the ops natively; that is PR 2.

## Tests

`test/host-effects-bridge.test.ts`: kind dispatch and invalid kind; HTTP auth (missing token 401, cookie auth 403, task auth refused); sealed stdio (wrong key and work grant → `unknown_op`); against the existing fake ssh (`test/fixtures/bin/ssh` with `PACER_FAKE_HOST_HOME`; see `test/helpers.ts`), the bridge's `state/jobs/<id>.json`, `state/host-checks.json` and `cache/remote-usage/<account>.json` are identical to a direct `callOp` run, for each kind including a refusal case. Follow the `test/fixtures/install-apply-core.ts` pattern if a test core is needed. Tests use temp homes and no fixed ports.

## Checks

Serial in sbx-deny with disposable HOME and PACER_HOME, TZ=Asia/Ho_Chi_Minh: `bun run typecheck`, the new test and the existing host and internal-bridge tests (`rg -l "service-effects|_internal\.msg\.effects|host\.check" test`), `bun run protocol:doc` if the internal route affects generated docs (it should not; confirm), `git diff --check origin/main..HEAD`.

CT-11: the route is internal and unreachable publicly until PR 2, so no live session is needed for PR 1; say so in the handoff for the PR description. Do not add a CHANGELOG entry unless the repo's convention records internal routes (check recent entries).

Commits: Conventional Commits, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>` (check `git config user.email`; the repository-local config has it). Do not push.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, port 4317 or ports 11434, 1234, 41343. Never contact a real SSH host.

## Handoff

Write `.work/reviews/wave2-pr1-handoff.md` in the worktree: commits, the bridge contract, sealing evidence, test results with counts, parity evidence against direct `callOp`, the CT-11 statement, and anything left for PR 2. Report with `orca orchestration worker_done`. Always end with worker_done.


Do the task above end to end. Report with orca orchestration worker_done.
