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
| Other `src/` core/service paths | Bun, Rust integration/conformance, install/sign-in/delegation e2e, CodeQL |
| Rust workspace/crates/xtask/config | Rust workspace validation plus Bun conformance/build and e2e coverage |
| TS plugins/SDK | Bun and Rust conformance, e2e, CodeQL |
| Tests | Bun and CodeQL; fixtures, shared test helpers/setup and install e2e tests also select e2e |
| Conformance | Bun, Rust and e2e |
| Desktop presentation/native files | Bun parity tests and UI evidence, CodeQL; native builds remain in manual/release workflows |
| Shared inputs, scripts, workflows or unmapped files | Full validation |

The `Linux service restart keeps running work` job runs whenever Bun checks are selected. It records UNVERIFIED instead of failing when the runner has no user service manager.

Mixed changes use the union. This is area selection, not a claim that individual
tests have complete dependency maps: selected language suites still run in full.
Bun builds still compile the Rust front door and build fixture plugins where
required. Native desktop validation is not replaced by the Bun checks.

Existing `Test (ubuntu-latest)` and `Test (macos-latest)` names remain always-running
gates. Both use Ubuntu for documentation-only runs, avoiding macOS allocation.
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
retain their complete validation. Rust clean/incremental build timings run on main
pushes affecting Rust, rather than paying for another clean build on every PR.
No branch protection settings are changed. A classifier failure fails the existing
Test gates; a diff that cannot be resolved falls back to full work.

When adding an area, update the classifier and `test/ci-selection.test.ts` together.
Use `python3 scripts/ci/changes.py --paths-json '["app/src/app.tsx"]'` to inspect a
selection without GitHub environment variables. Validate workflow changes with
`actionlint` and run the CI selection, UI evidence and release automation tests.
