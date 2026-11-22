# CI change selection

CI selects work from the complete git diff using `scripts/ci/changes.py` before
installing dependencies. PRs compare base/head through their merge base; pushes
compare the event's before/after SHAs. Deletions count and renames select both old
and new paths. Missing/invalid history and unknown paths select full validation.
The selection and reason appear in the job summary.

| Changed area | Work selected |
| --- | --- |
| Ordinary Markdown, project governance and agent skills | Required Test gate checks and full-history secret scan; no compilation/browser jobs |
| Generated protocol documentation | Bun freshness/tests/typecheck/build |
| `app/`, embedded app assets | Bun checks, browser e2e, UI policy and PR review evidence, CodeQL |
| TUI rendering and shared view-model | Bun checks, UI policy and PR review evidence, CodeQL |
| Audited source modifications on PRs | Mapped tests, build, Rust integration/conformance, install/sign-in/delegation e2e, CodeQL |
| Other `src/` core/service paths | Full Bun suite, Rust integration/conformance, install/sign-in/delegation e2e, CodeQL |
| Rust workspace/crates/xtask/config | Rust workspace validation plus Bun conformance/build and e2e coverage |
| TS plugins/SDK | Bun and Rust conformance, e2e, CodeQL |
| Tests | Bun and CodeQL; fixtures, shared test helpers/setup and install e2e tests also select e2e |
| Conformance | Bun, Rust and e2e |
| Desktop presentation/native files | Bun parity tests and UI evidence, CodeQL; native builds remain in manual/release workflows |
| Mapped CI and workflow files only | Focused CI/release tests, UI source checks, build and host artifact smoke |
| Shared inputs, other scripts or unmapped files | Full validation |

General tests run on Linux and macOS-specific tests run on macOS, on pull requests,
main pushes, scheduled and manual runs alike:

- `Typecheck, UI policy and build` runs the UI source check, `bun run build` and the
  artifact smoke test once per workflow, and the typecheck only when the full suite is
  selected.
- `Test (ubuntu-latest, shard N)` splits the full suite across eight Linux shards. A
  focused or documentation-only run uses a single shard.
- `Test (macos-latest, macOS-specific)` runs only the files that
  `scripts/ci/macos-tests.txt` marks `only` or `mixed`, whenever the full suite is selected.

`scripts/ci/shard-tests.py` packs files into shards by the durations in
`scripts/ci/test-timings.json`; a file without a recorded duration counts as the
median. To refresh the durations, save each Linux shard's log from a full CI run with
`gh run view --job <job-id> --log > <dir>/shard<N>.log`, then run
`python3 scripts/ci/extract-test-timings.py <dir> scripts/ci/test-timings.json`.
Entries for test files split after the last refresh are estimates: the original file's
CI time, shared out in proportion to local timings. The next refresh replaces them.

Each shard builds its own Rust test binaries. With a warm cache those builds take about
33 seconds per shard, and the shards still need the toolchain because many parity tests
run `cargo build` themselves, so a prerequisite build job would lengthen the run.

The manifest marks each file that checks for darwin. `only` files need macOS for every
test and leave the Linux shards, `mixed` files run on both, and `linux` files only pick
per-OS expectations and stay on Linux. `test/ci-sharding.test.ts` fails when a file that
checks for darwin is not listed.

`Rust` runs only on `ubuntu-latest` for pull requests, and the OS-specific `Install,
sign-in and delegation (macOS)` and `Linux service restart keeps running work` jobs skip
on pull requests. Main pushes, scheduled and manual runs add `Rust` on macOS and those
OS-specific jobs, using the selection above.

The `Linux service restart keeps running work` job runs in full mode when Bun checks are selected outside PRs. It records UNVERIFIED instead of failing when the runner has no user service manager.

Mixed changes use the union; any unmapped path, including documentation mixed with a mapped path, forces full suites. Standalone prose under `docs/`, `.project/` and `.agents/skills/`, plus the app and desktop READMEs, retains documentation-only selection; other shared or unknown Markdown selects full validation. Scheduled and manual CI runs always select full validation. The source map covers `src/classify/metrics.ts` (direct metrics and transitive bench tests) and `src/usage/cache.ts` (cache and plugins-usage-readers tests). The latter has no non-test importers in the current tree; the map includes all its direct test importers. Re-audit dependencies before adding mappings or consumers. Only modifications to mapped source files on PRs qualify; additions, deletions and both sides of renames force full suites. Main pushes remain full for source changes. Shared modules such as `src/classify/types.ts`, tests, and other source files remain full. Changes to the service-survival implementation and the CodeQL, PR-title, Scorecard and desktop workflows select full validation.
Bun builds still compile the Rust front door and build fixture plugins where
required. Native desktop validation is not replaced by the Bun checks.

Existing `Test (ubuntu-latest)` and `Test (macos-latest)` names remain always-running
gates on Ubuntu. Each passes only when change detection, every selected shard, the
build job and the macOS job passed. Release publication requires both gates and also
checks that the Linux shards and the macOS job executed their test steps.
Documentation changes only run their inexpensive readiness step; they do
not set up toolchains, install dependencies or compile. That gate rejects failed
change detection and any required failed/missing UI or release evidence. Rust/e2e
and irrelevant UI/CodeQL jobs skip at job level, so GitHub reports their skipped
status without workflow-level path filters leaving required checks pending.
Actual failures inside Test remain failures; the final readiness step does not
clear them. PR body/readiness edits retain applicable code validation to avoid
replacing a failed check for the same SHA with an untested success.

Full-history Gitleaks remains unconditional. CodeQL retains full scheduled/manual
scans; PR/push scans are selected by area. Tags and manual release/desktop jobs
retain their complete validation. For mapped CI-only changes focused mode skips the full Bun suite, Rust checks and e2e. For mapped source changes only the full Bun suite and Linux service survival job are deferred; Rust and e2e still run. Both focused modes retain UI source checks, builds and host artifact smoke tests; they skip the typecheck, which runs only with the full suite. Rust clean/incremental build timings run on main
pushes affecting Rust, rather than paying for another clean build on every PR.
No branch protection settings are changed. A classifier failure fails the existing
Test gates; a diff that cannot be resolved falls back to full work.

When adding an area, update the classifier and `test/ci-selection.test.ts` together.
Use `python3 scripts/ci/changes.py --paths-json '["app/src/app.tsx"]'` to inspect a
selection without GitHub environment variables. Validate workflow changes with
`actionlint` and run the CI selection, UI evidence and release automation tests.
