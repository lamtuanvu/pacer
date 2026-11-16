# Task: #629 salvage fix round 2 — release the broker host lease after a native host failure (R1)

Executor: cursor-agent (default model). Small, but security-sensitive capability-broker code. No time limit.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/m2-integration, branch `fix/port-629-salvage`, head `62d7fe3ce`, base origin/main `acab1eca4`. Not pushed. Memory and disk are very tight on this machine: build only `pacer-plugin-host` (`cargo test -p pacer-plugin-host`, one cargo command at a time, `CARGO_INCREMENTAL=0`), no release or `--workspace` builds.

Read: the re-review `.work/reviews/port-629-rereview.md` (finding R1 and advisory A2), the handoff `.work/reviews/port-629-salvage-handoff.md`, `src/plugins/host-lease.ts` (retire at ~165, capacity at ~189–190), `crates/plugin-host/src/broker.rs` (`capability.hosts.run` ~809–826, `fetch` ~863–872, `close` ~874–888), `crates/plugin-host/src/host_lease.rs:53`. The reviewer's scratch test is `.work/fixtures/p629-rr/rr_scratch.rs.txt`.

## Fix (R1 only)

- `capability.hosts.close`: release the `HostLeaseBroker` lease whatever the native result (`self.hosts.close(session).ok()` before propagating the native error), matching TypeScript's retire-then-rethrow.
- `capability.hosts.run` and `capability.hosts.fetch`: when the native effect returns an error (which retires the native session), release the broker lease too.
- Do not change any other behavior. Advisory A1 and A3 stay out of scope.
- Broker-level test (in `crates/plugin-host/src/broker/tests.rs` or `tests/host_lease_adversarial.rs`): a `NativeHosts` effect whose provider fails `run`; four open → failed run → close cycles, then a fifth open succeeds; the same for fetch failure. Show red evidence: the test fails at `62d7fe3ce` (save the log under `.work/fixtures/p629-r2/`).

## Checks

Serial in `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`: `cargo fmt --check`, `cargo clippy -p pacer-plugin-host --all-targets --locked -- -D warnings`, `cargo test -p pacer-plugin-host --locked --no-fail-fast` (the 4 `native_run` failures inside sbx-deny are known; rerun only `--test native_run` outside sbx with the same disposable HOME/PACER_HOME), `cargo xtask loc --check` (report the new plugin-host count), `git diff --check origin/main..HEAD`.

CT-11: the change is on the `PACER_NATIVE_PLUGIN_HOST=1` path, which the live harness cannot set (UNVERIFIED as in round 1); no new live session is needed. Say so in the handoff.

Commit: one commit, `fix(plugin-host): release the broker host lease when a native host operation fails`, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`. Update the CHANGELOG host-session bullet only if its wording becomes inaccurate. Do not push. No subagents.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`, or ports 4317, 11434, 1234, 41343.

## Handoff

Append a "Fix round 2" section to `.work/reviews/port-629-salvage-handoff.md`: commit, change, test with red evidence, checks, LOC. Report with `orca orchestration worker_done`. Always end with worker_done.
