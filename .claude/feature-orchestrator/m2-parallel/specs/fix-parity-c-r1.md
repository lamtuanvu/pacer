# Task: owner parity PR C fix round 1

Executor: cursor-agent (default model, medium tier); GLM is out of quota. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-c, branch `fix/owner-plugin-stderr-log`, head `d853bef7a`. The coordinator rebased it onto wave 3 PR 6's fix round (`d207bbb5b`, open as #931). Sibling PRs A, B, C and D all edit the ledger's PR 7 gate line and CHANGELOG: change only the words about your own rows so later rebases stay small. Run `bun install --frozen-lockfile` first.

Input: the review /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-c-review.md; your handoff /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-c-handoff.md.

## Fix

- Nonblocking from the review: record in the ledger the transport notes the owner still does not log; record (or fix if small) the descendant that inherited stderr getting SIGPIPE/EPIPE once the reader stops 250 ms after exit, and compare with what TypeScript does when the plugin exits; update the CRATE-1 projection in the PR body (B is +200, so A+B+C is about 5,180 lines for `pacer-plugin-runtime`); run `bun run live native-plugin-owner` on a `--front-door rust --native-plugin-host` sandbox at the rebased head and record it.
- The rebase onto PR 6's fix round (`d207bbb5b`) resolved conflicts in `conformance/fixtures/plugin.ts` (both `barrierTimeoutMs` and `pingStderr` kept) and the ledger gate line (PR 6's admission wording kept, the stderr sentence replaced by yours): confirm both resolutions.

## Checks

Inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME under `/tmp`, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_HOST_SOCKET`; both front doors built and copied to a temp dir (`PACER_TEST_FRONT_DOOR` from `cargo build --locked -p pacer`, `PACER_TEST_NATIVE_FRONT_DOOR` from `cargo build --locked -p pacer --features test-ops`); report counts that ran. One cargo command at a time; other Rust workers run at the same time, keep memory modest. `bun run typecheck`; `cargo fmt --all --check`; `pacer-plugin-runtime` (clippy `-D warnings`, tests); `test/plugin-conformance-native-owner.test.ts`, `test/native-plugin-ops.test.ts`, `test/native-plugin-ops-stdio.test.ts`, `test/native-plugin-crash.test.ts`, `test/plugin-conformance.test.ts`; `git diff --check`. Save logs under `.work/fixtures/parity-c-r1/`.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343.

## Commits and output

Conventional Commits, signed off (`git commit -s`, identity Vu Lam <lamtuanvuqs@gmail.com>). Do not push. Never commit `.work/`. No machine paths or personal emails in tracked files.

Append a "Fix round 1" section to /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-c-handoff.md (per-finding status, commits, counts, live evidence with the head) and an updated draft PR body. Report with `orca orchestration worker_done`. Always end with worker_done; do not end your turn before that.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-parity-c-r1.md exactly. End with orca orchestration worker_done.
