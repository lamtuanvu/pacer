# Task: triage and plan the native plugin owner parity fixes that gate default-on (wave 3 PR 7)

Executor: cursor-agent (default model, frontier tier); GLM would normally plan, but it is unavailable (OpenCode Go usage limit). The subject is security-sensitive (capability authority, secrets, the owner bridge, the host socket). Read-only: do not edit tracked files, commit or push. You may build and run tests to confirm root causes. No subagents.

Code: read at `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/wave3-pr6` (branch `test/native-owner-consumer-matrix`, head `2951c0aeb`, on `origin/main`). Its tests reproduce the divergences.

Context:
- PR 6 handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr6-handoff.md, sections "Divergences", "I1 result", "Conformance subset", "Follow-ups".
- PR 5 re-review: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/wave3-pr5-rereview.md, findings R1–R5 (R1–R3 must be fixed before default-on).
- Issue #918 (bridge caller authentication), `gh issue view 918`.
- Plans: /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-11-m2-wave3-plugin-host.md and 2026-11-12-m2-wave3-pr2-stdio-owner.md; ADR 0026 and ADR 0027; `docs/testing/m2-ledger.md` rows 22–24.
- Project rules: `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,architecture,repository}.md`, `.project/reviewers/security.md`.
- Maintainer decision OD-1: default-on (PR 7) lands only when the PR 6 matrix is green.

## Items to triage

From PR 6 (each has an expected-fail test named in the handoff):
1. `net.http` served flag-on to an installed plugin's ping without host-issued hosts; TypeScript refuses.
2. Assistant turn flag-on fails: "secret alias was not issued".
3. Planner reconnect and refresh rewrite `install-manifest.json` with sorted keys (owner bridge frames writes as canonical JSON).
4. Observation bootstrap refused for `plugin.doctor` flag-on.
5. Reentrant plugins serialised by the owner.
6. Broker refusal text differs from TypeScript (codes equal).
7. Serve's Core reports a child the owner started for an attached stdio connection as `idle`.
8. I1: `_run` runners inherit `PACER_HOST_SOCKET` flag-on (a self-owned stdio connection's private socket dangles after the connection ends).
9. The owner discards plugin stderr (`Stdio::null()`), so `logs/plugins/<id>.log` gets no `[stderr]` lines.

From the PR 5 re-review: R1 (unsealed bridge call can use a concurrent native call's call-scoped session), R2 (duplicate `plugin.hello`), R3 (lane calls reach a SIGTERMed child during the 2 s grace), R4 (failing refusal hint and Core-restart variant), R5 (ADR clause).

## What to produce

For each item: root cause with file:line references at `2951c0aeb`; the TypeScript reference behavior it must match; severity (is it exploitable flag-on, by whom; is flag-off affected); the proposed fix and its size; the tests that prove it (including which `test.failing` tests flip to plain tests); and whether it needs a maintainer decision. For item 1 state precisely what a plugin can reach and under which grants, and whether the same gap affects any other capability (fs, process, hosts, secrets) — check by reading the authority and broker code, not only the failing case.

Then group the items into the smallest set of PRs that can be built in parallel with minimal file overlap (at most 4 Rust workers at once), in dependency order, with for each PR: title (Conventional Commits), items, files and crates, CRATE-1 budget effect, differential tests, CT-11 live plan, and whether its executor must be security-sensitive (cursor-agent) or can be a GLM tier. State which PRs gate PR 7 and which may land after it. List open questions for the maintainer with a recommended answer each, only where the code cannot decide.

## Output

Write /Users/vulam/orca/workspaces/pacer/pinfish/.work/plans/2026-11-12-m2-wave3-owner-parity-fixes.md. Report with `orca orchestration worker_done` (summary: PR list, gating set, open questions). Always end with worker_done.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/plan-wave3-owner-parity.md exactly. End with orca orchestration worker_done.
