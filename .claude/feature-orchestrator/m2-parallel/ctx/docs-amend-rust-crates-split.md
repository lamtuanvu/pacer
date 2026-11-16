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
