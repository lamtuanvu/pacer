# Task: pin Linux CI runners to Ubuntu 24.04 (ubuntu-latest moved to 26.04 and breaks CI)

Executor: OpenCode Go GLM 5.3 Flash (small task). Workflow YAML only; no Rust or TypeScript changes, no builds.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/ci-pin-ubuntu, branch `ci/pin-ubuntu-24-04`, base origin/main `acab1eca4`.

## Why

GitHub's `ubuntu-latest` now resolves to image `ubuntu-26.04` (seen on PR #893, run 43036520532). On it:
- the pinned Playwright refuses to install Chromium ("Playwright does not support chromium on ubuntu26.04-x64"), so every Ubuntu test shard fails at "Install locked Chromium test browser";
- `crates/pacer/tests/self_repair.rs` test `copied_front::linux_actual_write_handle_blocks_exec_then_version_succeeds_after_close` fails (likely newer kernel exec/ETXTBSY behavior);
- release Linux binaries built on 26.04 would require a newer glibc than users have.

## Constraints

Required status checks (ruleset) are named `Test (ubuntu-latest)` and `Test (macos-latest)` (aggregate jobs), plus `Scan for secrets`, `Validate Conventional Commit title`, `DCO`, `Analyze JavaScript and TypeScript`. Check names must not change. So keep the matrix label value `ubuntu-latest` wherever it appears in a job name, an artifact name or an expression comparison, and change only the runner image that `runs-on` resolves to.

## Changes

1. `.github/workflows/ci.yml`:
   - Jobs whose names do not contain the OS (`changes`, `release-readiness`, `ui-evidence`, `linux-service-survival`, `secrets`, and any other plain `runs-on: ubuntu-latest`): `runs-on: ubuntu-24.04`.
   - `test` job (line ~115): keep `matrix.os: [ubuntu-latest, macos-latest]` and the job name; make `runs-on` map `ubuntu-latest` to `ubuntu-24.04` (for example `${{ ... && (matrix.os == 'ubuntu-latest' && 'ubuntu-24.04' || matrix.os) || 'ubuntu-24.04' }}`), preserving the existing PR/main/macOS logic exactly.
   - `rust` job (line ~340): keep the matrix values and name `Rust (${{ matrix.os }})`; map `runs-on` the same way.
   - Find the aggregate jobs that produce `Test (ubuntu-latest)` / `Test (macos-latest)` ("Require every test shard to pass") and pin any `ubuntu-latest` runner there the same way without changing their names.
2. `.github/workflows/release.yml` `build` job matrix (line ~80): keep any artifact names derived from the label stable (search for `binaries-ubuntu-latest` and `matrix.runner` uses, including in later jobs that download artifacts). Prefer adding an explicit `image: ubuntu-24.04` (and `image: macos-latest` for the mac entry) to the include entries and `runs-on: ${{ matrix.image }}`, if `matrix.runner` is used in artifact names. Pin the other plain `runs-on: ubuntu-latest` jobs in release.yml to `ubuntu-24.04`.
3. `codeql.yml`, `pr-title.yml`, `scorecard.yml`, `release-tag.yml`, `release-prepare.yml`: pin plain `ubuntu-latest` to `ubuntu-24.04` for consistency (check names do not include the OS; verify).
4. Leave a one-line YAML comment once near the top of `ci.yml`'s test job explaining the constraint: labels stay `ubuntu-latest` because required check names use them; runners are pinned to 24.04 until Playwright and the self-repair test support 26.04. Keep it short.

## Checks

- `actionlint .github/workflows/*.yml` (installed at /opt/homebrew/bin/actionlint): no new findings compared with origin/main (run it on both and diff).
- `rg -n "ubuntu-latest" .github/workflows` afterwards: every remaining occurrence is a label (job name, artifact name, matrix value or comparison), never the value a `runs-on` resolves to.
- `git diff --check origin/main..HEAD`.

Commit: `ci: pin Linux runners to Ubuntu 24.04 until Playwright and the self-repair test support 26.04`, `git commit -s`, identity `Vu Lam <lamtuanvuqs@gmail.com>` (check `git config user.email`). Do not push.

Also write `/Users/vulam/orca/workspaces/pacer/pinfish/.work/issues/ubuntu-26-04.md`: a GitHub issue draft (title + body, plain prose, no machine paths or emails) "Support Ubuntu 26.04 CI runners" listing the two failures above with the error text, the glibc concern for release binaries, and what to do to unpin (Playwright version with 26.04 support; fix or gate the self-repair ETXTBSY test by kernel behavior).

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`.

Handoff: `.work/reviews/ci-pin-ubuntu-handoff.md` in the worktree: commit, every changed `runs-on` with before/after, the actionlint comparison, and the remaining `ubuntu-latest` occurrences with why each is a label. Report with `orca orchestration worker_done`. Always end with worker_done.
