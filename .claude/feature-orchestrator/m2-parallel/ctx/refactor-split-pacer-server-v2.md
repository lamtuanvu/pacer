# Task: split pacer-server below the CRATE-1 limit, behaviour-preserving

## Worktree and branch
- Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/refactor-split-pacer-server
- Branch: refactor/split-pacer-server, based on origin/main. Work only here.

## Background
`cargo xtask loc` reports `pacer-server` (crates/server) at 12,054 handwritten LOC on origin/main; CRATE-1 requires a split above 12,000 and the planned size in .project/rules/rust-crates.md ("Planned crates and budgets") is 2,000–2,500: op registry assembly, HTTP, SSE, WebSocket, stdio, MCP, bridge, embedded app assets. The architecture says each domain crate exports its native operations (`pub fn ops() -> &'static [NativeOp]`) and pacer-server only assembles the registry. Today much domain logic and many Core bridges live in `crates/server/src/native/*.rs` (`*_sync.rs`, `*_ops.rs`, handover_bridge.rs, etc.). A time-boxed exception is being recorded so in-flight M2 branches can merge meanwhile; this branch removes the need for it.

## Goal
Bring pacer-server under 12,000 LOC with real headroom (aim for under 8,000 in this PR if achievable without a risky rewrite; state the plan to reach the planned budget for the rest), by moving cohesive code out along the planned crate layers:
- Domain op implementations into their domain crates' `ops()` exports where those crates exist and the layering allows (CRATE-4: domain crates never depend on transport, CLI or TUI crates).
- The Core bridge client plumbing (`core_bridge_sync.rs` and the `*_sync.rs` bridge callers) into a dedicated lower crate if they cannot live in domain crates, named and layered per xtask/crates.toml conventions; update xtask/crates.toml and the planned-crates table accordingly (that table change is a rule-adjacent doc change; keep it factual and minimal, and say so in the commit).
- Keep `crates/server/src/native.rs` registry structure recognisable: several in-flight branches add registry entries there and will rebase onto this, so prefer moving modules wholesale and re-exporting over reshuffling the registry file. Minimise churn in native.rs.

## Constraints
- Pure refactor: no behaviour change, no protocol change, no op added or removed, same native/forwarded decisions, same errors byte-for-byte.
- CRATE-4 (no cycles, layering), CRATE-5 (heavy deps only where allowed), CRATE-6, CRATE-9 (adding a crate requires `cargo build --timings` before/after numbers for a clean dev build and the incremental rebuild in the PR description: capture them and save the summary under .work/), CRATE-11 (inline test blocks ≤150 lines), RUST rules in .project/rules/rust.md.
- No new heavy dependencies.

## Validation
- `cargo xtask loc --check`, `cargo xtask deps` (and `cargo xtask gen --check` if relevant), `cargo build`, `cargo test` (workspace), `cargo clippy --workspace --all-targets -- -D warnings`, `cargo fmt --all --check`, `bun run typecheck`, and the native parity/front-door bun tests (`bun test test/native-*.test.ts`) with counts compared against origin/main.
- Live validation (CT-11) per docs/testing/live-validation.md with `bun run live` at the final clean head: smoke the native front doors (HTTP ops, web app load and a few native-op screens in Orca's built-in browser with an ISOLATED profile; guide: `orca skills get orca-cli --reference references/browser.md`). Op-specific stdio, desktop, PACER_FORWARD_OPS override and real executor runs stay UNVERIFIED under the maintainer exception, backed by the parity tests.

## Governance
Read first: AGENTS.md, .project/constitution.md, .project/context.md, .agents/skills/project-governance/SKILL.md; rules repository.md, code-and-testing.md, rust.md, rust-crates.md, architecture.md, api-protocol.md, security.md; reviewer definitions in .project/reviewers/ (architecture especially). Conventional Commits (`refactor(server): ...`), `git commit -s`, small reviewable commits (one move per commit where practical). Do not push. Do not commit .work/. No machine-specific paths or personal emails.

## Hard safety rules
Never touch /Applications/pacer.app, ~/.local/bin/pacer and pacer-core, ~/.pacer, the com.pacer.serve service or launchd label. Every spawned test process uses a disposable HOME/PACER_HOME and a pinned PACER_PORT (never 4317). Stop everything you start.

## Report
`orca orchestration worker_done`: commits, new crates and what moved, LOC before/after per crate, test counts vs base, timings summary, live evidence path, session HEAD, summary line, and UNVERIFIED items. If the split cannot get under 12,000 safely, report what you achieved and what blocks the rest. Always end with worker_done.
