# Task: wave 3 PR 2 fix round 1, stdio plugin ops review findings and the deep-home decision

Executor: cursor-agent (default model, frontier tier). Security-sensitive: socket placement and permissions, attach trust checks, environment passed to the core child. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr2, branch `feat/plugin-ops-stdio-owner`, head `66272b539` (your three commits rebased onto `origin/main` after #917 merged; no conflicts). Reviews: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr2-security-review.md (no blockers: S1–S4, P1–P2, Q1–Q4, A1–A2, R1, and a deep-home recommendation) and /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr2-arch-review.md (PASS, six nonblocking). Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr2-handoff.md. Not pushed.

## Maintainer decision: deep homes

When `<PACER_HOME>/run/s<12-hex>.sock` would exceed the Unix socket path limit, put the per-connection socket in a short private per-user directory outside the home, so deep homes keep stdio with the flag on. Not a refusal, not a TypeScript fallback. Implement it with the security reviewer's mitigations (see its "Deep-home recommendation"):
- Base directory: the OS per-user private directory, `confstr(_CS_DARWIN_USER_TEMP_DIR)` on macOS and `$XDG_RUNTIME_DIR` on Linux. Never a shared `/tmp` name, and never `$TMPDIR` alone. Validate the base with `lstat`: a directory, not a symlink, owned by the current uid, `mode & 0o077 == 0`.
- Inside it, `pacer-<short hash of the canonical PACER_HOME>` created with `mkdir` 0700, then `lstat` again with the same checks; refuse if any check fails.
- Only when the in-home path is too long; normal homes keep `run/`. If the private directory is unavailable or fails a check, refuse with an actionable message naming `PACER_NATIVE_PLUGIN_HOST=0` and a shorter `PACER_HOME` (Q4).
- Sweep stale per-connection sockets there and in `run/` (S3).
- Serve's `host.sock` stays in the home with its length guard (deviation 9); record that a deep home cannot run a flag-on serve, as a follow-up for PR 5/PR 7.
- Tests: a deep home gets a working flag-on stdio connection with its socket under the private directory; a symlinked, foreign-owned or group/world-accessible private directory is refused; removing each check turns a test red.
- Update ADR 0027 (Q5 placement), the ledger flag-on paragraph and the CHANGELOG.

## Other fixes (coordinator decisions)

- **S1:** in Core mode, remove an inherited `PACER_HOST_SOCKET` from the core child's environment (`env_remove`), with a test reproducing the reviewer's case (flag-off stdio under a flag-on serve's environment renders like TypeScript).
- **S2:** make the attach tests cover the `host.sock` owner check and the peer-uid check individually; each mutation removing one check alone must go red.
- **S3:** stale per-connection sockets: sweep stale `s<12-hex>.sock` files (connect refused, owned by the current uid, socket type, not symlinks) before binding, and remove the connection's socket on SIGTERM if the door can do so cheaply. Test the sweep.
- **S4:** stop narrowing the process-wide umask in `bind_private` for the per-connection socket. Rely on the verified 0700 parent directory and set 0600 on the socket after bind (`fchmod`/`chmod` on the path inside the 0700 directory). If serve's `host.sock` uses the same helper, apply the same approach there and keep its tests green; say so in the handoff.
- **P2:** document deviation 12 (`pid: null` for natively owned children in flag-on `plugin.doctor`, both doors, pre-existing on HTTP) in the ledger rows 22–23.
- **Q1:** assert the full relay refusal message, with an installed plugin, so removing the stdio-only relay gate goes red.
- **Q2:** race (iii): call the first, owning connection again after serve starts; race (i): assert the lock files are intact; add a flag-on byte comparison of stdio replies against flag-on HTTP for at least `plugin.list`, `plugin.doctor` and one settings op.
- **Q3:** rerun CT-11 on the fixed head (see below) so the reports name the final head.
- **Architecture notes:** fix the PR text's next-split attribution (cite the right seam), expand the CHANGELOG attach condition, document the serve `host.sock` length guard, split the `ipc.rs` inline test block under 150 lines (CRATE-11), and fill the Linked issue section.
- A1, A2 advisory; R1 cosmetic: no change.

## Checks

Serial inside `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx-deny` with a disposable short `mktemp -d` HOME, `PACER_HOME=$HOME/.pacer` (keep real CARGO_HOME, RUSTUP_HOME and `SCCACHE_DIR=/Users/vulam/Library/Caches/Mozilla.sccache`), `TZ=Asia/Ho_Chi_Minh`, `CARGO_BUILD_JOBS=4 CARGO_INCREMENTAL=0`, `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin` first on `PATH`. The OS per-user temp directory must be reachable inside the sandbox for the deep-home tests; if `sbx-deny` blocks it, run those tests outside the deny profile with a disposable HOME and say so. One cargo command at a time; debug only. Another Rust worker runs at the same time; keep memory use modest. `cargo fmt --all --check`; clippy `-D warnings` and tests for `pacer-server`, `pacer-plugin-ops`, `pacer-plugin-runtime`; `cargo xtask loc --check`; `bun run typecheck`; `test/native-plugin-ops-stdio.test.ts` and the neighbouring plugin tests; `git diff --check`. Save mutation logs under `.work/fixtures/wave3-pr2-r1/` in this worktree.

CT-11: rerun the `native-plugin-stdio` fixture runs (flag-off and flag-on own, flag-on attach) on the fixed head, plus one flag-on stdio session on a deliberately deep sandbox home showing the socket in the private directory. Temporary sandboxes only, never ports 4317, 11434, 1234, 41343. Tear down and confirm no sandbox, browser or tmux processes remain and no sockets are left in the private directory.

Commits: Conventional Commits (`fix(plugin-ops): ...`, `test: ...`, `docs: ...`), `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>`; one `Co-authored-by` trailer at most. Do not push. Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`.

## Handoff

Append a "Fix round 1" section to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr2-handoff.md`: commits, per-finding status, the deep-home design as built (paths, checks, code references), tests and red evidence, checks, live summary per surface, follow-ups, and the updated draft PR text. Report with `orca orchestration worker_done`. Always end with worker_done.
