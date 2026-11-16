# Task: wave 3 PR 2 (#920) CI fix — deep-home stdio test fails on Linux

Executor: cursor-agent (default model). Security-relevant (private socket directory on Linux). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr2, branch `feat/plugin-ops-stdio-owner`, head `fa6a3bb98` (pushed; PR https://github.com/lamtuanvu/pacer/pull/920). Do not rebase. Another worker (wave 3 PR 5) is stacked on this head in a separate worktree; keep your change small and in new commits.

## Failure

CI `Test (ubuntu-latest, shard 1)` (run 43205014726, job 131140567591; `gh api repos/lamtuanvu/pacer/actions/jobs/131140567591/logs`): `test/native-plugin-ops-stdio.test.ts` "a deep home's owning connection binds in the private per-user directory" fails after 30 s with `no reply to 1`, which is the protocol `hello` reply. The test is not skipped, so `$XDG_RUNTIME_DIR` is set on the runner; the door gave no hello reply (likely it refused and exited because the directory is missing or fails the owner/mode check, or it hung). The door's stderr is never printed because the helper fails before `stop()`. macOS passes.

## What to do

1. Reproduce on Linux with Docker (OrbStack is available: `docker run --rm -v <worktree>:/src ...`). Use a Linux image with Rust and Bun (or install them in the container), build `cargo build -p pacer --features test-ops` inside the container with a container-local `CARGO_TARGET_DIR` (never write into the macOS `target/`), and run the test with `PACER_TEST_NATIVE_FRONT_DOOR` pointing at that binary. Try the GitHub runner's likely states: `XDG_RUNTIME_DIR=/run/user/<uid>` that does not exist, that exists with 0700 owned by the user, and with wrong mode/owner. Find out which one CI hits; if you can't tell, make the test robust to all of them. Do not mount or touch anything outside the worktree and a temp dir; the container must not see `~/.pacer` or the maintainer's home.
2. Fix:
   - In the test helper, surface the door's stderr when `hello` (or any reply) times out or the child exits early, so CI failures are diagnosable.
   - Make the deep-home test choose by the base directory's real state: when the base passes the same check the door uses (exists, real directory, owned by the current uid, no group/other access), assert the binding as now; otherwise assert the documented refusal (the door exits promptly, the message names `PACER_NATIVE_PLUGIN_HOST=0` and a shorter `PACER_HOME`, nothing is created in `/tmp` or the base). Neither branch may wait 30 s.
   - If the door hangs instead of exiting on refusal, or behaves wrongly with a usable base on Linux, fix the product code too and add a test that would have caught it.
3. Checks inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` (disposable short `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer`, real CARGO_HOME/RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`, `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_TEST_NATIVE_FRONT_DOOR -u PACER_HOST_SOCKET`): `bun run typecheck`; `test/native-plugin-ops-stdio.test.ts` with your macOS `--features test-ops` build; if Rust changed, fmt, clippy `-D warnings` and tests for `pacer-plugin-runtime` and `pacer-server`. Plus the Linux container run of the stdio test in each base-directory state, passing.

Commits: `test(plugin-ops): ...` or `fix(plugin-runtime): ...`, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push (the coordinator pushes). Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Stop and remove every container you start.

## Handoff

Append a "CI fix (Linux deep home)" section to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr2-handoff.md`: root cause with evidence, commits, the Linux runs per base-directory state, checks. Report with `orca orchestration worker_done`. Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/fix-wave3-pr2-ci.md exactly. End with orca orchestration worker_done.
