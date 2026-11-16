# Task: harden two owner tests — a pid-0 kill and a Linux connection reset

Executor: cursor-agent (default model, standard tier: two small test fixes). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/test-hardening, branch `test/owner-flake-hardening`, based on `main` after PR #971 (owner bridge caller auth) merged.

Read and follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md first. Never use `git stash`.

## 1. `test/native-plugin-crash.test.ts`: never `process.kill(0)`

"a crash mid-call fails that call as plugin_unavailable naming the plugin" waits until `<plugin>/held` exists, then does `process.kill(Number(readFileSync(held)), "SIGKILL")`. If the file is read after it is created but before the pid is written, `Number("")` is 0 and `process.kill(0, "SIGKILL")` kills the test runner's whole process group. Review: `.work/reviews/parity-h-ci-rereview.md` advisory F1 (seen once in a loaded run; also on main). Fix: wait until the file holds a positive integer pid (and fail the test with a clear message on timeout); check the fixture plugin writes the pid atomically or at least in one write. Look for the same pattern (`process.kill(Number(...))`, reading a pid file then killing) in other tests and fix every instance (`rg "process.kill\(Number"`, `rg "kill\(.*readFileSync"`).

## 2. `crates/plugin-runtime/tests/bridge_caller_auth.rs`: tolerate a reset after refusal

`a_wrong_proof_is_refused_and_the_connection_closed` failed on Linux CI (Rust ubuntu): `read_line` returned `ConnectionReset` (os error 104) at line ~275. The test writes a wrong proof and a sealed call in one write; the owner refuses and closes with the call bytes unread, and Linux AF_UNIX resets the peer, so the refusal line can be lost. Decide with evidence:
- If the owner is meant to deliver the refusal reliably, fix the product (for example shut down the write side and drain briefly before closing) and keep the test strict; or
- if losing the refusal text for a peer that failed authentication is acceptable (the security property is that nothing runs), make the test accept either the `-32001` refusal followed by EOF, or a reset — and keep asserting that no plugin was started.
State the choice and reason in the handoff. Reproduce on Linux if you can (for example a `docker run` with the repo mounted, no network needed, no real credentials); otherwise explain the macOS behaviour and reason from the Linux AF_UNIX semantics. Check the other tests in that file for the same write-then-close pattern.

## Checks and delivery

fmt, clippy `-D warnings` and tests for `pacer-plugin-runtime`, typecheck, the crash suite 10 times and the caller-auth Rust test 50 times in a loop (`cargo test -p pacer-plugin-runtime --test bridge_caller_auth -- --test-threads=1` repeated). Show red evidence where possible (for item 1, a fixture delay that leaves the file empty shows the old code would read 0; do not actually call `process.kill(0)`).

CT-11: test-only changes need no live run unless you change product code in item 2; then run `bun run live` with the Rust front door and the owner flag on, and show an authenticated plugin call still works.

Commit with `git commit -s` (`test(plugins): …`, or `fix(plugins): …` if product code changes). Do not push. Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/test-hardening-handoff.md with a draft PR body. A QA review follows.
