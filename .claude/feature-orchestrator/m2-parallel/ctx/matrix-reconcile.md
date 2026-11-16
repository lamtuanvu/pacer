# Task: fix the consumer matrix's reconcile-row race and Link-latency remedy leak (test-only)

Executor: cursor-agent (default model, standard tier: test-only timing fixes in one file). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/matrix-reconcile, branch `test/matrix-reconcile-race`, stacked on `test/matrix-usage-refresh-race` head `e05054de9` (the usage-refresh settle fix, reviewed PASS, being merged separately; that commit is on current `main` `8f0aa6c01`). Add one new signed-off commit (`git commit -s`, author Vu Lam <lamtuanvuqs@gmail.com>, Conventional title starting `test:`). Do not push. Do not change product code.

Inputs:
- Review with the diagnosis and remedy: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/matrix-race-review.md, finding F1 (reconcile row reads `install-manifest.json` between the reconcile commit's file write and its manifest write) and "Point 4" (setup.health `{"kind":"remedy","check":"Link latency"}` action not covered by `linkLatencyMasked`).
- CI failure excerpt: /Users/vulam/orca/workspaces/pacer/pinfish/.work/fixtures/matrix-race/ci-941-reconcile.log.
- The earlier executor's unreviewed draft (pre-#942 file, takes the "manifest differs" approach and masks Link-latency remedies): /Users/vulam/orca/workspaces/pacer/pinfish/.work/fixtures/matrix-reconcile/executor-draft.test.ts. Use it as a reference only; the file on this branch already has #942's strict reconcile row and key-order test.
- Project rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/code-and-testing.md`, `.project/reviewers/qa.md`.

## Change (test/plugins-native-owner-matrix.test.ts only)

1. Reconcile row: after the restored rules file appears, wait for the reconcile transaction to finish before observing (poll until `install-transaction.json` is absent, checked after the file was seen, and/or until the manifest differs from the pre-restart text), with a bounded deadline that fails loudly. Then assert the reference mode's `manifest after refresh` carries an `integration` fingerprint, so an all-modes-stale read fails.
2. Link latency: extend the existing mask so a setup.health remedy action whose `check` is `Link` or `Link latency` is normalized the same way as the check itself. Mask nothing else.
3. No comparison is weakened otherwise: `expectIdentical`, known lists and row coverage unchanged.

## Evidence

- Red then green: temporarily delay the manifest write in forward mode only (as the reviewer did) and show the old row fails with the CI diff and the new row passes; temporarily delay it in every mode and show the new `integration` assertion fails. Revert every temporary edit; `git status` clean except your commit.
- For the Link-latency mask, show a run where a remedy appears in one mode (for example a temporary threshold change or a delayed snapshot) fails on old code and passes on new.
- `bun run typecheck`; the full matrix file at least 3 times (19 pass each).

Environment: run inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache` (the shared sccache server is running; never stop it or start it inside a disposable HOME), `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET -u PACER_HOST_SOCKET_KEY -u CARGO_TARGET_DIR`, with both front doors built from this head and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`). Run `bun install --frozen-lockfile` first. One matrix run at a time; do not add CPU load (`yes`) — other workers share this machine. Before you finish, stop every process you started (serve doors, loops, scripts) and confirm none remain.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real API key or Keychain item.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/matrix-reconcile-handoff.md: the change, red/green evidence with log paths under `.work/fixtures/matrix-reconcile/`, commands and results, and a draft PR body (title `test: wait for the startup reconcile commit in the consumer matrix`). CT-11 live validation does not apply (test-only). Report with `orca orchestration worker_done`. Always end with worker_done.
