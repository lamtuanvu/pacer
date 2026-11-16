# Task: wave 3 PR 5 fix round 1 — shutdown with an in-flight call, and review findings

Executor: cursor-agent (default model, frontier tier). Security- and reliability-sensitive (process teardown, owner lock). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr5, branch `feat/owner-crash-backoff`, head `89eb2d758`. Your four commits were rebased by the coordinator onto the current #920 head `023479743` (which is rebased onto `main` with #923); the only conflicts were import lines in `scripts/live/cli.ts` and `test/live-harness.test.ts`. Not pushed.

Reviews (read both in full):
- /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr5-security-review.md — FAIL: B1 blocking, N1–N10. The reviewer's B1 probe is at `.work/fixtures/wave3-pr5-review/shutdown-inflight-probe.test.ts` in this worktree.
- /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr5-arch-review.md — PASS, F1–F7.
Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr5-handoff.md.

## Fixes (coordinator decisions)

- **B1 (blocking):** serve shutdown must not wait on the owner lock held by an in-flight plugin call (`serve_host.rs` `shutdown` awaits `self.owner.lock()`; `native/plugins.rs` `call_native` holds it for the whole call, up to 30 s). Shutdown must begin terminating the owner's children at once with SIGTERM → 2 s → SIGKILL, fail in-flight calls (`plugin_unavailable` or the existing shutdown error), and let serve exit within about the 2 s grace, as at base (41 ms) and in TypeScript (16 ms). Do not hold the lock across child I/O if that is the cleanest fix; whatever you change, keep the ownership gate and the crash/backoff bookkeeping correct and race-free (shutdown racing a crash or a restart). Turn the reviewer's probe into a real test (flag-on serve, a `plugin.ui.action` the plugin never answers, SIGTERM serve: serve exits in well under 30 s, the child gets SIGTERM promptly and is gone, no orphan), show it red at `89eb2d758`, and do the same for stdio teardown with an in-flight call if the same lock pattern exists there.
- **N1:** when the transport closes while the child lives, send SIGTERM at once and SIGKILL after the grace, like `src/plugins/process.ts`; add a cooperative-child test (exits on SIGTERM, recorded as `exited on SIGTERM`).
- **N2:** mirror `failing` in the owner floor: once a plugin has three crashes in the window, the owner refuses to start it until an enable clears it (the same rule Core applies). Test that an attached stdio door cannot restart a `failing` plugin. Keep the CHANGELOG/ADR claim accurate.
- **N3:** say "on another port" (a second serve on the same port fails earlier with `EADDRINUSE`, exit 1) in the CHANGELOG and ADR 0027. Do not move the TCP bind.
- **N4 / arch F2:** `deliver_crashes` drops a report when Core is restarting; correct the handoff and PR text (no retry) and record the gap as a follow-up.
- **N5:** record as a known limit (forwarded `plugin.enable` does not clear the owner floor; bounded by the call deadline) in the handoff and ledger row; no code.
- **Arch F6:** refuse the `crashed` kind on an attached connection's Core (only owning doors receive crash reports), with a test, if it is a small guard; otherwise record why not.
- N6, N7, N8, arch F7: keep as recorded follow-ups.
- **Docs and PR text:** arch F1 / N9: the draft PR body states why `pacer-server` is above 8,000 and names the next split (the native plugin service and transports out of the server into a plugin-service crate between `pacer-plugin-runtime` and `pacer-server`, as #920's PR text describes) and when; arch F3: one clause that `pacer-plugin-runtime` (now ~4,607) is above its planned ≤ 4,500 band and why; arch F4: refresh the handoff's commit table and counts to the final head; arch F5: Linked issue says the wave 3 plan is the tracking artifact, no separate issue; N10: every CT-11 run in the evidence names its head.

## Checks

Serial inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (real CARGO_HOME, RUSTUP_HOME, `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`, `env -u PACER_TEST_NATIVE_FRONT_DOOR -u PACER_HOST_SOCKET`. Bun tests read `PACER_TEST_FRONT_DOOR` (a plain `cargo build -p pacer` copy in a temp dir) and `PACER_TEST_NATIVE_FRONT_DOOR` (a `--features test-ops` copy). `cargo fmt --all --check`; clippy `-D warnings` and tests for `pacer-plugin-runtime`, `pacer-plugin-ops`, `pacer-server`; `cargo xtask loc --check`; `bun run typecheck`; `test/native-plugin-crash.test.ts`, `test/native-plugin-ops-stdio.test.ts`, `test/native-plugin-ops.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/doctor-host-socket.test.ts`, `test/native-dispatch.test.ts`, `test/live-harness.test.ts`; `git diff --check`. Signal tests blocked by the sandbox may run outside it with a disposable HOME; say so. Mutation logs under `.work/fixtures/wave3-pr5-r1/`.

CT-11: rerun `bun run live native-plugin-owner` and `native-plugin-stdio --stop-service` on the fixed head, adding a service stop with an in-flight plugin call (serve exits within the grace, the child is gone). Name the head in each run. Temporary sandboxes only, never ports 4317, 11434, 1234, 41343; tear down and confirm no processes, sockets or sidecars remain.

Commits: Conventional Commits (`fix(plugin-runtime): ...`, `test: ...`, `docs: ...`), `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Do not push or rebase. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`; never `launchctl`.

## Handoff

Append a "Fix round 1" section to the handoff: commits, per-finding status, B1 design with code references, tests and red evidence, checks, live summary with heads, follow-ups, and the updated draft PR body. Report with `orca orchestration worker_done`. Always end with worker_done.
