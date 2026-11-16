# Independent project review: docs/amend-rust-crates-split

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/docs-amend-rust-crates-split`
- Branch: `docs/amend-rust-crates-split`
- Base (merge-base with origin/main): `33e584bce245764f169ead5b44ac19ae2740a589`
- Reviewed head: `b9e0492c8d54d5416429dbc2c2c8dbe0f5662864`
- Commits in scope:
  - b9e0492c8 docs: propose amendment 0.22.0 adding pacer-mcp and pacer-core-bridge crates
- Raw changes: `git diff 33e584bce245764f169ead5b44ac19ae2740a589..b9e0492c8d54d5416429dbc2c2c8dbe0f5662864` and `git log -p 33e584bce245764f169ead5b44ac19ae2740a589..b9e0492c8d54d5416429dbc2c2c8dbe0f5662864`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
# Task: propose a constitution amendment adding pacer-core-bridge and pacer-mcp to the planned Rust crates

## Worktree and branch
- Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/docs-amend-rust-crates-split
- Branch: docs/amend-rust-crates-split, based on origin/main (33e584bce). Work only here. Documentation only; no code changes.

## Background
The maintainer decided (2026-11-10, in the coordinating session) to split pacer-server (12,054 LOC on main, over CRATE-1's 12,000; planned 2,000–2,500). The split branch refactor/split-pacer-server introduces two new crates: `pacer-mcp` (crates/mcp: MCP catalog, validation and stdio wire transport; ~1,011 LOC; no heavy dependencies) and `pacer-core-bridge` (crates/core-bridge: Core HTTP and stdio bridge clients for native operations; ~1,757 LOC; heavy deps axum, hyper), both at layer 8, below pacer-server (layer 9). An independent review found that editing the planned-crates table in .project/rules/rust-crates.md is a rule-file change that must go through the constitution's amendment process (docs: PR title, constitution version bump, decisions.md entry), so it was removed from the split branch and is proposed here.

## Required
1. Read .project/constitution.md (amendment and exception policy, how earlier amendments 0.7.0 to 0.20.0 are recorded: status line, version, Updated date, amendment section), .project/rules/rust-crates.md, .project/decisions.md, and .agents/skills/project-governance/SKILL.md.
2. Propose amendment 0.21.0 (or the next free version) following exactly the established pattern for a proposed amendment: update the constitution's status line/version/Updated date (2026-11-10), add a short amendment section stating it is proposed and adopted only by the maintainer merging the PR, and record it in .project/decisions.md as the existing amendments are recorded.
3. In .project/rules/rust-crates.md "Planned crates and budgets", add rows (in the established format) for:
   - | 8 | `pacer-mcp` (`crates/mcp`) | MCP catalog, validation and stdio wire transport | ≤ 1,500 | none |
   - | 8 | `pacer-core-bridge` (`crates/core-bridge`) | Core HTTP and stdio bridge clients for native operations (M2 coexistence; removed when M2 forwarding ends, if that is how the architecture describes bridges) | ≤ 2,500 | `axum`, `hyper` |
   and update the pacer-server row description to "Op registry assembly, HTTP, SSE, WebSocket, stdio, MCP and bridge assembly, embedded app assets" (budget unchanged). Mark the rule change as proposed under the amendment the way earlier proposed amendments mark rule text, if the file has such a convention. Check docs/architecture or ADRs that enumerate crates and update them only if they claim a closed list.
4. Keep it factual and minimal. Reviewers cannot adopt amendments; the maintainer's merge does.

## Validation
Run the repo's docs checks for .project/ and markdown (see package.json scripts and .project/rules/repository.md). No live validation (no runtime change). Commit title: `docs: propose amendment 0.21.0 adding pacer-mcp and pacer-core-bridge crates` (adjust version), `git commit -s`. Do not push. No machine-specific paths or personal emails.

## Report
`orca orchestration worker_done` with the commit hash, checks run, and a summary of the exact changes. Always end with worker_done.
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

Independent REPOSITORY-RULE review (governance and amendment process) of branch docs/amend-rust-crates-split, base origin/main 33e584bce, head b9e0492c8 (docs only). Purpose: propose a constitution amendment (numbered 0.22.0 because the implementer found 0.21.0 already assigned; verify where 0.21.0 is assigned and that 0.22.0 is the correct next number and is not taken by any open amendment you can see) adding two planned layer-8 crates to .project/rules/rust-crates.md (pacer-mcp, crates/mcp, <= 1,500 LOC, no heavy deps; pacer-core-bridge, crates/core-bridge, <= 2,500 LOC, axum and hyper) and revising the pacer-server description to 'op registry assembly, HTTP, SSE, WebSocket, stdio, MCP and bridge assembly, embedded app assets' (budget unchanged). Background: the maintainer decided on 2026-11-10 to split pacer-server (12,054 LOC on main) in branch refactor/split-pacer-server, which introduces these crates; that branch's independent review found the table edit had to go through the amendment process, so it was moved here. Check: (a) the amendment follows the constitution's amendment and exception policy exactly as earlier proposed amendments (0.7.0 to 0.20.0) are recorded: status line, version, Updated date, amendment section stating it is proposed and adopted only by the maintainer's merge, decisions.md entry, docs: commit title, DCO sign-off; (b) the table rows match the established format and layering (layer 8 below server 9; dependency direction consistent with xtask/crates.toml conventions; budgets plausible against the split branch's measured 1,011 and 1,757 LOC); (c) no other rule text changed, no reviewer is granted approval authority, wording is factual; (d) no machine-specific paths or personal emails; (e) docs checks pass (git diff --check and the repo's docs/CI-selection checks). No live validation applies (no runtime change). This review does not adopt the amendment.

Shared safety: run any bun test under /Users/vulam/orca/workspaces/pacer/pinfish/.work/sandbox-bin/sbx. Do not touch the maintainer's real pacer install.

## Live-validation policy

Maintainer live-validation policy for the m2 batch (decided 2026-11-10):

- Web app and tray: affected web screens must be exercised in the sandbox through Orca's built-in browser (load the guide with `orca skills get orca-cli --reference references/browser.md`). If it cannot be driven, record the surface UNVERIFIED with the reason.
- Op-specific stdio (refused by the harness D3 guard), the desktop app, and the PACER_FORWARD_OPS override: MAINTAINER-SCOPED EXCEPTION. They stay UNVERIFIED in the PR "How tested" section, backed by the unit, parity and end-to-end tests that cover them; the PR records the exception explicitly. Do not treat this exception as blocking, but do check that the covering automated tests exist and really exercise those paths.
- Operations the harness refuses by design because they change the real environment (D3/D8 guards, for example service.install, update.apply, service.handover, service.work, account.signin): MAINTAINER-SCOPED EXCEPTION on the same terms. They stay UNVERIFIED in the PR, backed by isolated end-to-end tests through the real HTTP and stdio front doors with disposable homes and safe injected effects; check those tests exist and really exercise the paths. The guard refusal itself should still be recorded as PASS evidence.
- Real executor runs (spend subscription budget): NOT authorized. The real-executor path stays UNVERIFIED under the same exception.
- Live evidence must be attributable to the reviewed revision: the harness session HEAD must equal the reviewed head with a clean tree.
- Updates "Install" control (m2-service-handover, decided 2026-11-10 after re-review 2): MAINTAINER-SCOPED EXCEPTION. The live harness forces PACER_NO_UPDATE_CHECK=1 so the control never renders, and the only update-offering flow bootstraps launchd jobs. It stays UNVERIFIED in the PR with that reason, backed by the update.apply front-door end-to-end and parity tests with injected update effects.

## Deliverable

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/docs-amend-rust-crates-split/.work/reviews/2026-11-10-amend-rust-crates-split-review.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.


Carry out the independent review described above and write the report.
