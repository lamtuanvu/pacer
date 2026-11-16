# Independent project review: docs/crate1-server-exception

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/docs-crate1-server-exception`
- Branch: `docs/crate1-server-exception`
- Base (merge-base with origin/main): `33e584bce245764f169ead5b44ac19ae2740a589`
- Reviewed head: `4c8f11b4b9d91fd13c3da0946597bfb5905f9320`
- Commits in scope:
  - 4c8f11b4b docs: record a time-boxed CRATE-1 exception for pacer-server
- Raw changes: `git diff 33e584bce245764f169ead5b44ac19ae2740a589..4c8f11b4b9d91fd13c3da0946597bfb5905f9320` and `git log -p 33e584bce245764f169ead5b44ac19ae2740a589..4c8f11b4b9d91fd13c3da0946597bfb5905f9320`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
# Task: record a time-boxed CRATE-1 exception for pacer-server

## Worktree and branch
- Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/docs-crate1-server-exception
- Branch: docs/crate1-server-exception, based on origin/main. Work only here. Documentation only; no code changes.

## Background
CRATE-1 (.project/rules/rust-crates.md): above 12,000 LOC a crate is split before the PR merges, unless an exception is recorded in .project/decisions.md with an expiry. `cargo xtask loc` on origin/main reports `pacer-server` at 12,054 handwritten LOC (planned 2,000–2,500). Several in-flight M2 branches each add 100–250 LOC of op registration and bridges to it. The `cargo xtask loc --check` tool only warns above 12,000, although the rule's enforcement column says CI fails above 12,000.

## Maintainer decision (2026-11-10, @lamtuanvu, given in the coordinating session)
Record a time-boxed scoped exception so in-flight M2 native-op branches may merge while pacer-server exceeds 12,000 LOC, and split the crate in parallel (a separate branch, `refactor/split-pacer-server`, is being prepared).

## Required
1. Add a `## Scoped exception: pacer-server CRATE-1 size (2026-11-10)` section to .project/decisions.md, matching the style of the existing "Scoped exception" section at the top (Authority, Scope, Basis, Expiry). Content:
   - Authority: the maintainer's explicit decision in the coordinating session; not an AI reviewer approval or a governance amendment.
   - Scope: CRATE-1's 12,000 LOC split-before-merge requirement for `pacer-server` only. Applies to M2 native-op migration PRs that add op registration, bridges or front-door wiring to pacer-server. Each such PR states its pacer-server LOC delta in the description. No other crate and no other rule is waived; the 8,000 LOC justification requirement still applies (the split plan is the justification).
   - Basis: measured size on main (12,054), planned size, and the split branch in progress.
   - Expiry: when the pacer-server split merges, or 2026-12-01 23:59 UTC, whichever comes first. After expiry, PRs that leave pacer-server above 12,000 need the split or a new exception.
2. Note the enforcement mismatch (xtask warns rather than fails above 12,000) as an open item in the same section or in the open decisions table, without changing the tool in this PR.
3. Keep the wording consistent with .project/constitution.md's process: reviewers cannot grant exceptions; the maintainer's merge of this PR records it.

## Validation
Run whatever docs checks the repo has for .project/ and markdown (see package.json scripts and .project/rules/repository.md; e.g. link or format checks). No live validation is needed (no runtime change). Conventional Commit `docs: record a time-boxed CRATE-1 exception for pacer-server`, `git commit -s`. Do not push. No machine-specific paths or personal emails.

## Report
`orca orchestration worker_done` with the commit hash, the checks you ran, and the exact text added. Always end with worker_done.
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

This is a repository-rule review of a documentation-only governance change (AGENTS.md: documentation changes require a proportionate repository-rule review). Ignore the code-specific checks above that do not apply (parity, bridges, tests). Check instead: the new decisions.md section matches the established "Scoped exception" format and the constitution's exception process (only the maintainer grants exceptions; recorded by maintainer merge; reviewers cannot approve); the scope is narrow (CRATE-1's 12,000 split-before-merge requirement for pacer-server only, M2 native-op PRs stating their LOC delta; the 8,000 justification still applies); the basis is factual (run `cargo xtask loc` yourself if feasible and compare with the stated 12,054 on main); the expiry is concrete (split merges or 2026-12-01 23:59 UTC); the enforcement mismatch (xtask warns rather than fails above 12,000) is recorded accurately without changing tooling; no machine-specific paths or personal emails; DCO sign-off; Conventional Commit. The implementer's delivery note is at .work/reviews/crate1-server-exception-delivery.md. Live validation does not apply (no runtime change).

## Live-validation policy

Maintainer live-validation policy for the m2 batch (decided 2026-11-10):

- Web app and tray: affected web screens must be exercised in the sandbox through Orca's built-in browser (load the guide with `orca skills get orca-cli --reference references/browser.md`). If it cannot be driven, record the surface UNVERIFIED with the reason.
- Op-specific stdio (refused by the harness D3 guard), the desktop app, and the PACER_FORWARD_OPS override: MAINTAINER-SCOPED EXCEPTION. They stay UNVERIFIED in the PR "How tested" section, backed by the unit, parity and end-to-end tests that cover them; the PR records the exception explicitly. Do not treat this exception as blocking, but do check that the covering automated tests exist and really exercise those paths.
- Operations the harness refuses by design because they change the real environment (D3/D8 guards, for example service.install, update.apply, service.handover, service.work, account.signin): MAINTAINER-SCOPED EXCEPTION on the same terms. They stay UNVERIFIED in the PR, backed by isolated end-to-end tests through the real HTTP and stdio front doors with disposable homes and safe injected effects; check those tests exist and really exercise the paths. The guard refusal itself should still be recorded as PASS evidence.
- Real executor runs (spend subscription budget): NOT authorized. The real-executor path stays UNVERIFIED under the same exception.
- Live evidence must be attributable to the reviewed revision: the harness session HEAD must equal the reviewed head with a clean tree.
- Updates "Install" control (m2-service-handover, decided 2026-11-10 after re-review 2): MAINTAINER-SCOPED EXCEPTION. The live harness forces PACER_NO_UPDATE_CHECK=1 so the control never renders, and the only update-offering flow bootstraps launchd jobs. It stays UNVERIFIED in the PR with that reason, backed by the update.apply front-door end-to-end and parity tests with injected update effects.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/docs-crate1-server-exception/.work/reviews/2026-11-10-crate1-server-exception-review.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.
