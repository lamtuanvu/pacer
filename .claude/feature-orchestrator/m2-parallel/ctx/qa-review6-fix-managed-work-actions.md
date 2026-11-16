# Independent project review: fix/managed-work-actions

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-managed-work-actions`
- Branch: `fix/managed-work-actions`
- Base (merge-base with origin/main): `33e584bce245764f169ead5b44ac19ae2740a589`
- Reviewed head: `18d2899255ebabb2e13667b99262a92906bae484`
- Commits in scope:
  - 18d289925 test: assert managed action geometry stays stable
  - f842ff429 fix: hide managed action announcements in tray
  - e0324c451 fix: announce managed action progress
  - 08731ad0e fix: preserve action focus and ignore stale completions
  - f721830d5 fix: guard rapid tray actions and test dispatch errors
  - 091178763 fix: preserve managed attention in v2 projection
  - 0541b623c fix: explain unavailable managed actions
  - c0263ddba fix: gate managed attention actions by service support
  - ab3537273 fix: route managed attention actions through dispatch
- Raw changes: `git diff 33e584bce245764f169ead5b44ac19ae2740a589..18d2899255ebabb2e13667b99262a92906bae484` and `git log -p 33e584bce245764f169ead5b44ac19ae2740a589..18d2899255ebabb2e13667b99262a92906bae484`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
# Implementation task: route managed-work actions in the tray and Needs-you to dispatch.retry / dispatch.answer

## Worktree and branch
- Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-managed-work-actions
- Branch: fix/managed-work-actions, based on origin/main (33e584bce). Work only here.

## Problem (pre-existing on main, found by live validation of the m2 dispatch-ops branch)
For managed work (tasks with `task.work`), two surfaces send the legacy ops, and Core refuses both with 403:
- Tray / attention "Retry": `src/attention/rules.ts` (around line 47) emits `{op:"task.retry", params:{id, executor?}}` for failed/limit tasks. Core (`src/api/ops.ts` ~469) refuses managed work: "Use dispatch.retry with a requestId and revision for managed work".
- Needs-you answer: `app/src/screens/needs-you/AnswerPanel.tsx:23` calls `task.answer` (the tray's "Answer" lands here; `src/attention/rules.ts` ~34 emits `task.answer` for questions). Core (`src/api/ops.ts` ~453) refuses: "Use dispatch.answer with a requestId and revision for managed work".

## Required behaviour
Managed work must use `dispatch.retry` / `dispatch.answer` with `expect_rev` and a stable `requestId`, exactly as the existing web screens already do on main:
- `app/src/screens/failure/model.ts:14`, `app/src/screens/review/model.ts:78`: `dispatch.retry {id, expect_rev: task.rev, requestId: `${id}.${rev}.retry`, feedback}`.
- `app/src/screens/workspace/Workspace.tsx:380`: `task.work ? "dispatch.answer" : "task.answer"` with `requestId: `${id}.${rev}.answer``.
- `app/src/screens/work/WorkView.tsx` uses `workActionRequestId(...)`; reuse the shared helper rather than inventing a new id format.
Non-managed tasks must keep using `task.retry` / `task.answer` unchanged. Check every consumer of attention actions (tray model `app/src/tray/model.ts`, the web Needs-you list, desktop, CLI/TUI if they render attention actions) and the attention item schema / protocol types, so the new op and params are allowed wherever the action is executed (feature gating such as `state.features.ops.has("dispatch.retry")` included). Consider what "Retry on <other executor>" means for managed work (dispatch.retry has no executor param); keep the label and behaviour honest. Keep any public protocol/attention schema change backwards compatible and documented per the API rules.

## Tests (required)
- Unit tests for the attention rules: managed failed/limit work yields dispatch.retry with expect_rev and the stable requestId; managed questions yield dispatch.answer; non-managed unchanged.
- App tests for AnswerPanel (managed vs non-managed) and the tray model/action execution.
- An end-to-end or Core-level test that executing the emitted action against real Core handlers in a disposable HOME/PACER_HOME succeeds for managed work (no 403) and is idempotent on repeat (same requestId).

## Live validation (CT-11, required)
Follow docs/testing/live-validation.md with `bun run live` in a sandbox, at your final clean head. Seed disposable managed work (failed and needs-input) with Core store calls in the sandbox home, executors replaced by refusing PATH stubs (never a real executor run; not authorized). Drive in Orca's built-in browser with an ISOLATED profile (load the guide with `orca skills get orca-cli --reference references/browser.md`): the Needs-you answer for managed work, and the tray/attention Retry and Answer path as far as it can be exercised; capture request bodies and Core responses. Record what cannot be exercised as UNVERIFIED with the reason. The desktop app and real executor runs are UNVERIFIED under the maintainer exception, backed by tests.

## Governance
Read first: AGENTS.md, .project/constitution.md, .project/context.md, .agents/skills/project-governance/SKILL.md. Applicable rules: .project/rules/repository.md, code-and-testing.md, architecture.md, api-protocol.md, security.md (and any app/UI rule files listed in .project/context.md). Conventional Commits, `git commit -s` on every commit. Do not push. Do not commit .work/. No machine-specific paths or personal emails in tracked files.

## Hard safety rules
Never touch the maintainer's real pacer install: /Applications/pacer.app, ~/.local/bin/pacer and pacer-core, ~/.pacer, the com.pacer.serve service or launchd label. Every test and every spawned process must use a disposable HOME and PACER_HOME and must not be able to reach 127.0.0.1:4317 (pin PACER_PORT to a sandbox or closed port wherever a process may contact the service). Stop everything you started.

## Report
When done, report with `orca orchestration worker_done` (outcome, commit hashes, test counts, live evidence path, session HEAD, the report's summary line, and what is UNVERIFIED). Always end with worker_done; if blocked, say what you need in worker_done.
---

## Governance context

Read first: `AGENTS.md`, `.project/constitution.md`, `.project/context.md`, `.agents/skills/project-review/SKILL.md`.
Rules that apply to these paths: `.project/rules/repository.md`, `.project/rules/code-and-testing.md`, `.project/rules/rust.md`, `.project/rules/rust-crates.md`, `.project/rules/architecture.md`, `.project/rules/api-protocol.md`, `.project/rules/security.md`.
Reviewer definitions: `.project/reviewers/architecture.md`, `.project/reviewers/protocol-compat.md`, `.project/reviewers/qa.md`, `.project/reviewers/security.md`. Also check `.project/decisions.md` for relevant open decisions.

## What to check

- The change does what the requirements ask, or each deviation is justified and safe.
- Native Rust behavior matches the TypeScript reference byte-for-byte for every case the parity claims cover (error codes, messages, refusals), and anything not native is forwarded unchanged.
- Bridges and forwarding preserve the caller's auth, enforcement identity and timeouts; no new privilege or unauthenticated path.
- Tests actually exercise the claims (parity tests compare against the TypeScript path, not a fixture of themselves). `docs/testing/m2-ledger.md` rows and totals match what the code registers.
- No machine-specific paths or personal emails in tracked files; commits are signed off (DCO).

You may run read-only and test commands (git, rg, cargo test, cargo clippy, cargo fmt --check, bun test for the touched tests). Do not edit tracked files, commit, push, or change branches. Never touch the real pacer install (`/Applications/pacer.app`, `~/.local/bin/pacer*`, `~/.pacer`, `com.pacer.serve`); do not run `bun run live`. If a check cannot run, record it as UNVERIFIED.

## Re-review context

Final QA review at HEAD 18d289925. QA review 5 PASSED at e0324c451. Review only the delta e0324c451..18d289925 (f842ff429: .sr-only moved to shared components.css, regenerated assets, new test/managed-status-browser.test.ts that failed before the fix with a 60px visible status; 18d289925: idle/busy geometry assertions for tray root, items, footers and answer dialog; opt-in mutation PACER_TEST_VISIBLE_STATUS=1). Verify the new test fails on the regression (run the opt-in mutation and, separately, temporarily remove the .sr-only rule and confirm failure; restore; never commit), passes clean, and the affected suites pass apart from the two pre-existing tray failures. Run everything through the sbx wrapper with PACER_PORT=1, TZ=Asia/Ho_Chi_Minh and PACER_TEST_BROWSER set (zero skips). Do not stop the running live session. Write the report to .work/reviews/2026-11-10-fix-managed-work-actions-qa-review6.md.

Known pre-existing failures (NOT findings against this branch, but list them as pre-existing in the report): test/app-tray-layout-browser.test.ts production tray layout ('.tray-mode' stays hidden) and the tray board test (30 s timeout) fail identically at the branch base 33e584bce, 08731ad0e, e0324c451 and 18d289925 (logs .work/fixtures/tray-*.log).


Shared checks for this final review:
- Real-install isolation (AGENTS.md): during development of a sibling branch, an unpinned test sent requests to the maintainer's real pacer service on 127.0.0.1:4317. Check every test added or changed in this branch: each spawned front door, core or CLI process must have a disposable HOME/PACER_HOME and must not be able to reach the default service port 127.0.0.1:4317 or other real-install paths (pin PACER_PORT to a sandbox or closed port wherever a process might contact the service, for example executor or work-grant callers, guard, status or setup checks). Any such path is a blocking SEC finding.
- Live evidence must be from the reviewed head with a clean tree (check the session metadata), per the live-validation policy appended below.
- Known cross-branch issue: large numeric stdio JSON-RPC ids (fixed separately in afd3622fb on m2/dispatch-ops). Record only as a shared dependency.
- Ledger accuracy (ONLY for branches that change docs/testing/m2-ledger.md or the native op registry; for other branches, a pre-existing ledger inconsistency in an untouched file is out of scope, not a finding): docs/testing/m2-ledger.md aggregate totals (native, stdio, not native) and the selective list must match this branch's actual registry in crates/server/src/native.rs, recounted from the registry, not adjusted from the base. Stale totals are blocking.
- Front-door tests: the native front-door cases skip unless PACER_TEST_NATIVE_FRONT_DOOR is set (and some need a release front door). When you run tests, set it (build the test-ops front door once if needed, in this worktree's existing target dir; disk is tight) so those cases actually run, and report their pass/skip/fail counts. Skipped cases are not evidence.
- (Same scope.) Ledger figures are relative to THIS branch's own crates/server/src/stdio_hello.json and registry at its merge base (bases differ: some branches have 225 v3 ops, newer ones 228). Do not flag a figure as stale because origin/main differs; flag only internal inconsistency with this branch's own catalog and registry. A final recount happens at merge.

- SAFETY: run every bun test / test script you execute as `/Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx <cmd>` (sandbox denying localhost:4317, with a non-setuid ps on PATH so process checks work). A test that fails only because the sandbox refused 4317 is a test-isolation finding, not a reason to run unsandboxed.

## Live-validation policy

Maintainer live-validation policy for the m2 batch (decided 2026-11-10):

- Web app and tray: affected web screens must be exercised in the sandbox through Orca's built-in browser (load the guide with `orca skills get orca-cli --reference references/browser.md`). If it cannot be driven, record the surface UNVERIFIED with the reason.
- Op-specific stdio (refused by the harness D3 guard), the desktop app, and the PACER_FORWARD_OPS override: MAINTAINER-SCOPED EXCEPTION. They stay UNVERIFIED in the PR "How tested" section, backed by the unit, parity and end-to-end tests that cover them; the PR records the exception explicitly. Do not treat this exception as blocking, but do check that the covering automated tests exist and really exercise those paths.
- Operations the harness refuses by design because they change the real environment (D3/D8 guards, for example service.install, update.apply, service.handover, service.work, account.signin): MAINTAINER-SCOPED EXCEPTION on the same terms. They stay UNVERIFIED in the PR, backed by isolated end-to-end tests through the real HTTP and stdio front doors with disposable homes and safe injected effects; check those tests exist and really exercise the paths. The guard refusal itself should still be recorded as PASS evidence.
- Real executor runs (spend subscription budget): NOT authorized. The real-executor path stays UNVERIFIED under the same exception.
- Live evidence must be attributable to the reviewed revision: the harness session HEAD must equal the reviewed head with a clean tree.
- Updates "Install" control (m2-service-handover, decided 2026-11-10 after re-review 2): MAINTAINER-SCOPED EXCEPTION. The live harness forces PACER_NO_UPDATE_CHECK=1 so the control never renders, and the only update-offering flow bootstraps launchd jobs. It stays UNVERIFIED in the PR with that reason, backed by the update.apply front-door end-to-end and parity tests with injected update effects.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/fix-managed-work-actions/.work/reviews/2026-11-10-fix-managed-work-actions-qa-review6.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.
