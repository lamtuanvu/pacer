# Task: owner parity PR B fix round 1

Executor: cursor-agent (default model, medium tier); GLM is out of quota. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-b, branch `fix/owner-sealed-door-calls`, head `9ab0eb6c0`. The coordinator rebased it onto wave 3 PR 6's fix round (`d207bbb5b`, open as #931). Sibling PRs A, B, C and D all edit the ledger's PR 7 gate line and CHANGELOG: change only the words about your own rows so later rebases stay small. Run `bun install --frozen-lockfile` first.

Input: the review /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-b-review.md; your handoff /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-b-handoff.md.

## Fix

- **Blocking (REPO-7):** add a CHANGELOG Unreleased entry for the user-visible behavior (flag-on reentrant plugins run concurrently, serve reports `ready` after an attached start, the `failing` refusal hint, call-scoped `capability.log` lines in the plugin log with their level); update `docs/testing/m2-ledger.md` (the PR 7 gate line no longer lists the reentrant and attached-start `idle` rows as red; the observation row now says bootstrap passes and events still wait for observation generations; R1–R4 status); ADR 0027 if its consequences describe the old door call path.
- Nonblocking from the review: name the commit in the CT-11 evidence (rerun `bun run live native-plugin-stdio` and `native-plugin-owner` on the rebased head on a `--front-door rust --native-plugin-host` sandbox and record the head); add a structural R1 test if the review's suggestion is small; fix the `door_hello` flag that sticks to the lane if small, otherwise record it; check the 1,000-byte log cut against TypeScript and match it or record why not.

## Checks

Inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`; both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`); report counts that ran. One cargo command at a time; other Rust workers run at the same time, keep memory modest. `bun run typecheck`; `cargo fmt --all --check`; `pacer-plugin-runtime` and `pacer-server` (clippy `-D warnings`, tests); `test/plugins-native-owner-matrix.test.ts`, `test/plugin-conformance-native-owner.test.ts`, `test/native-plugin-ops.test.ts`, `test/native-plugin-ops-stdio.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/native-plugin-crash.test.ts`, `test/serve-plugin-native.test.ts`; `git diff --check`. Save logs under `.work/fixtures/parity-b-r1/`.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

## Commits and output

Conventional Commits, signed off (`git commit -s`, identity Vu Lam <lamtuanvuqs@gmail.com>). Do not push. Never commit `.work/`. No machine paths or personal emails in tracked files.

Append a "Fix round 1" section to /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-b-handoff.md (per-finding status, commits, counts, live evidence with the head) and an updated draft PR body. Report with `orca orchestration worker_done`. Always end with worker_done; do not end your turn before that.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-parity-b-r1.md exactly. End with orca orchestration worker_done.
