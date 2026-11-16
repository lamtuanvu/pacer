# Task: independent security and QA review of M2 wave 4 W4-4 — draft and cache-only status parts (REPO-10)

Executor: cursor-agent (default model, frontier tier: an internal sealed route gains inputs). Read-only review: do not edit tracked files, commit, push or rebase. No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-4, branch `feat/w4-status-parts-drafts`, head `64d355a05`, one commit on `main` `a05f95414` (14 files, +534/−92).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-4-handoff.md (changes, deviations, tests with red evidence, CT-11 summary with one UNVERIFIED surface, draft PR body).
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-4.md and the common brief `w4-common.md` next to it.
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-13-m2-wave4-usage-pacing.md (§3 bridges and sealing, §6 W4-4, decision Q13: extend the existing route additively).
- Rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,architecture,rust,rust-crates,code-and-testing,repository}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`. Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **Sealing unchanged.** HTTP `/_internal/status-broker-parts` still requires the internal bearer token with `x-pacer-auth: bearer`; stdio `_internal.status-broker.parts` still requires the sealed key; a work grant, wrong key or missing auth still gets the same refusal (`unknown_op` / 401 / 403) as on `main`. New params cannot widen who may call or what is read.
2. **Input handling.** `draft` and `cacheOnly` are strictly validated (unknown keys, wrong types, oversized drafts); a draft cannot make Core read or write files, run processes or reach accounts that `strategy.preview` with the same draft would not; `cacheOnly` provably writes nothing (no cache, state or activity writes) and runs no provider read.
3. **Byte compatibility.** With no params the reply is byte-identical to `main` on both transports (API-1 spirit for internal routes; W4-6 will depend on the shapes).
4. **Parity.** `strategy.preview` native vs forwarded is byte-identical for provider-input drafts on both transports; the remaining forward cases are exactly "unreadable draft" and "YAML/I/O error text" (or the handoff's recorded deviations — judge each).
5. **Tests and evidence.** Rerun the new tests and the affected existing ones on this head (both front doors built from it); confirm red evidence by reverting the relevant hunk temporarily (revert afterwards; `git status` clean). Judge the CT-11 UNVERIFIED surface (Dispatcher web editor cannot produce an account-changing draft): acceptable with HTTP/stdio coverage, or does it hide a real gap? Commit signed off and Conventional; no machine paths or personal emails; CRATE-1 numbers.

Environment: as in `w4-common.md` ("Build and environment"). Other Rust workers run at the same time; one cargo command at a time, keep memory modest.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real API key or Keychain item. Stop every process you start.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-4-review.md: verdict (PASS / FAIL / UNVERIFIED) against head `64d355a05`, findings with severity (blocking / nonblocking / nit) and code references, and the commands you ran with results. Report with `orca orchestration worker_done`. Always end with worker_done.
