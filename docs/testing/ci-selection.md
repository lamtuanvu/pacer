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
| `src/classify/metrics.ts` modifications on PRs | Direct metrics and transitive bench tests, typecheck/build, Rust integration/conformance, install/sign-in/delegation e2e, CodeQL |
| Other `src/` core/service paths | Full Bun suite, Rust integration/conformance, install/sign-in/delegation e2e, CodeQL |
| Rust workspace/crates/xtask/config | Rust workspace validation plus Bun conformance/build and e2e coverage |
| TS plugins/SDK | Bun and Rust conformance, e2e, CodeQL |
| Tests | Bun and CodeQL; fixtures, shared test helpers/setup and install e2e tests also select e2e |
| Conformance | Bun, Rust and e2e |
| Desktop presentation/native files | Bun parity tests and UI evidence, CodeQL; native builds remain in manual/release workflows |
| Mapped CI and workflow files only | Focused CI/release tests, typecheck, UI source checks and host artifact smoke |
| Shared inputs, other scripts or unmapped files | Full validation |

The `Linux service restart keeps running work` job runs in full mode when Bun checks are selected. It records UNVERIFIED instead of failing when the runner has no user service manager.

Mixed changes use the union; any unmapped path, including documentation mixed with a mapped path, forces full suites. Standalone prose under `docs/`, `.project/` and `.agents/skills/`, plus the app and desktop READMEs, retains documentation-only selection; other shared or unknown Markdown selects full validation. Scheduled and manual CI runs always select full validation. The source map is intentionally limited to `src/classify/metrics.ts`: its direct test and the bench test cover the transitive metrics → bench → command path. Only modifications to mapped source files on PRs qualify; additions, deletions and both sides of renames force full suites. Main pushes remain full for source changes. Shared modules such as `src/classify/types.ts`, tests, and other source files remain full. Changes to the service-survival implementation and the CodeQL, PR-title, Scorecard and desktop workflows select full validation.
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
retain their complete validation. For mapped CI-only changes focused mode skips the full Bun suite, Rust checks and e2e. For the mapped source change only the full Bun suite and Linux service survival job are deferred; Rust and e2e still run. Both focused modes retain typecheck, UI source checks, builds and host artifact smoke tests. Rust clean/incremental build timings run on main
pushes affecting Rust, rather than paying for another clean build on every PR.
No branch protection settings are changed. A classifier failure fails the existing
Test gates; a diff that cannot be resolved falls back to full work.

When adding an area, update the classifier and `test/ci-selection.test.ts` together.
Use `python3 scripts/ci/changes.py --paths-json '["app/src/app.tsx"]'` to inspect a
selection without GitHub environment variables. Validate workflow changes with
`actionlint` and run the CI selection, UI evidence and release automation tests.
