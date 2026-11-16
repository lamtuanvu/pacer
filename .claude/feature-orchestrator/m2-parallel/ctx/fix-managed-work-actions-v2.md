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
