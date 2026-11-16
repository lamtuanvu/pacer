# Task: independent QA, protocol-compat and security review of M2 wave 4 W4-2 — held modes, repo and least-loaded routes, policy retry options (REPO-10)

Executor: cursor-agent (default model, frontier tier: native ops gain repo registration, policy and ranking paths). Read-only review: do not edit tracked files, commit, push or rebase. No subagents. Never use `git stash` (it is shared by all worktrees); for temporary reverts save a patch under `.work/fixtures/` and `git apply -R` / `git apply`.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/w4-2, branch `feat/w4-routing-residue`, head `f552db759`, one commit on `main` `a05f95414` (20 files, +1124/−205).

Inputs:
- Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-2-handoff.md (changes, five deviations, tests with red evidence, CT-11 with 7 UNVERIFIED surfaces, draft PR body).
- Brief: /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-2.md and the common brief `w4-common.md` next to it.
- Plan: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-13-m2-wave4-usage-pacing.md (§6 W4-2, finding F1, decisions Q3, Q8, Q12).
- Rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,architecture,rust,rust-crates,code-and-testing,repository}.md`, `.project/reviewers/{qa,protocol-compat,security}.md`. Use `.agents/skills/project-review/SKILL.md`.

## What to verify

1. **F1 and forwarding.** Any runner with a `host` keeps `routing.route` and `task.retry_options` forwarded; the forward predicates (`native::status_residue_stays_forwarded`) cover exactly the handoff's list, and nothing that TypeScript treats differently (remote eligibility, agent-session liveness, classifier `goal`, Core-only policy or registry reads) can be answered natively. Look for inputs that slip through: symlinked or non-regular policy files, a registry Rust cannot read, strategies `native_load` reads differently, `null`/empty values.
2. **Repo handling and writes.** `routing.route` with an absolute `repo` calls `pacer_repos::register_repo` under the `repos` lock. Confirm TypeScript's `resolvePolicyRepoInput` writes the registry the same way for the same input (same bytes in `state/repos.json`, same lock, same strict-policy behavior), that a route request cannot register or read paths TypeScript would not, and that refusals happen before any write or status read.
3. **`mode.hold` without `until`.** Same reset choice (planner `resetsAt`, else now + 7 days), same refusal for a past reset, same file bytes (integral timestamps without `.0`, including explicit integral `until`, which changed behavior on `main` too). An explicit `until` must not read status.
4. **Wire shape and errors.** Native replies byte-identical to TypeScript: ranked-entry key order, `uncertain` always present, Zod v4 issue texts, unknown keys stripped, `null` params as `{}`, strategy errors `internal` with Core's text. Judge each fixed `main` defect in deviation 3 as a parity improvement, not a contract change (API-1).
5. **Least-loaded.** `balance_by_load` matches `balance.ts` (bands, near-limit split, uncertain band, inside a policy); `slot_use` counts the same task states; open agent sessions forward.
6. **Retry options.** Selection order (`task.repo`, then `registered_repo(brief.repo)`, then unverified identity refused by a strict policy) and `down` reasons match TypeScript.
7. **Tests and evidence.** Rerun the new parity file and the affected suites on this head with both front doors built from it; reproduce the red evidence (`main` front door and driver) for at least F1 and the repo routes; check the integral-`until` red case. Commit signed off and Conventional; no machine paths or personal emails; CRATE-1 numbers (pacer-server 8,742 under #848; task-ops gains pacer-repos and pacer-config-ops — confirm the layering).
8. **CT-11 gaps.** The executor marked six web screens UNVERIFIED for lack of a browser tool. Another worker drove the web UI headlessly with `playwright-core` and Chrome from a throwaway script outside the repo. Try that in a `bun run live up --front-door rust --native-test-ops --seed ui` sandbox for at least Delegate "Will go to", Settings › General mode hold and Failure retry options. Report what you exercised and what stays UNVERIFIED, then `bun run live down --keep`.

Environment: as in `w4-common.md` ("Build and environment"). Other Rust workers run at the same time; one cargo command at a time, keep memory modest.

Never touch the maintainer's real pacer install, `~/.pacer`, `~/.local/bin/pacer*`, `/Applications/pacer.app`, `com.pacer.serve`. Never use ports 4317, 11434, 1234, 41343. Never use a real API key or Keychain item. Stop every process you start.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/w4-2-review.md: verdict (PASS / FAIL / UNVERIFIED) against head `f552db759`, findings with severity (blocking / nonblocking / nit) and code references, the commands you ran with results, and the CT-11 web results. Report with `orca orchestration worker_done`. Always end with worker_done.
