# Independent project review: refactor/split-pacer-server

You are the independent reviewer required by REPO-10 for this branch. You did not write this code. Review it and report; do not fix it.

## Scope

- Worktree: `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/refactor-split-pacer-server`
- Branch: `refactor/split-pacer-server`
- Base (merge-base with origin/main): `33e584bce245764f169ead5b44ac19ae2740a589`
- Reviewed head: `4340608e939c0e1b1dd92b6d7678ff0779446a25`
- Commits in scope:
  - 4340608e9 refactor(server): split bridge and protocol support crates
  - 6e5863363 refactor(server): move native domain operations into crates
- Raw changes: `git diff 33e584bce245764f169ead5b44ac19ae2740a589..4340608e939c0e1b1dd92b6d7678ff0779446a25` and `git log -p 33e584bce245764f169ead5b44ac19ae2740a589..4340608e939c0e1b1dd92b6d7678ff0779446a25`. Review every file in that diff. Changes outside it are out of scope unless the diff depends on them.

## Requirements

The implementation brief follows. For any earlier commit in scope that the brief does not cover, its commit message is the stated requirement; also check that what it claims (ops registered, ledger rows) is actually true in the code.

---
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

Independent PROJECT review (architecture, protocol compatibility, security, repository rules; .project/reviewers/architecture.md, protocol-compat.md, security.md) of branch refactor/split-pacer-server, base origin/main 33e584bce, head 4340608e9 (commits 6e5863363, 4340608e9). Goal: behaviour-preserving split of pacer-server (12054 LOC, over CRATE-1's 12000; planned 2000-2500) per .project/rules/rust-crates.md and xtask/crates.toml; a time-boxed CRATE-1 exception is in PR #848. Moves: engine/onboarding handlers -> pacer-config-ops; broker-backed status handlers -> pacer-task-ops; Core bridge clients -> new pacer-core-bridge; MCP transport -> new pacer-mcp; v2 compatibility transforms -> pacer-read-model; desktop reconciliation -> pacer-update; server keeps module re-exports and registry ordering. LOC base->head: server 12054->7598; config-ops 4263->4642; task-ops 2813->3131; read-model 4020->4809; update 785->1061; core-bridge 1757 new; mcp 1011 new. Handoff: .work/reviews/split-server-worker-handoff.md. Focus: (a) behaviour preservation: diff moved code against the original for any semantic change (auth checks, bridge key/token handling, timeouts and deadlines, error mapping, registry order and op names, stdio_hello.json unchanged, MCP and v2 output); (b) crate layering and dependency direction per xtask/crates.toml and cargo xtask deps; security-sensitive seams (internal key, work grants, enforcement tokens, trust checks) must keep the same visibility and must not become reachable from new places; pub surface widened only where needed; (c) the rust-crates.md planned-crates table edit is minimal, factual and allowed under the amendment process (flag if it needs maintainer approval); (d) CRATE-1 status: server is under 12000 but over the planned budget, so state whether the exception in PR #848 is still needed at merge. The implementer is concurrently producing validation evidence (plugin-host /bin/ps sandbox failures, per-file native parity base vs head, broader live surfaces) without code changes; review the code at 4340608e9 and run what you need yourself (cargo xtask loc --check, cargo xtask deps, cargo build, clippy, targeted cargo test, sandboxed Bun native tests under the sbx wrapper with PACER_TEST_NATIVE_FRONT_DOOR set to a binary path). Use the worktree's existing target dir; disk is tight, so build nothing else. The m2 ledger checks do not apply unless op classification changed.

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

Write the report to `/Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/refactor-split-pacer-server/.work/reviews/2026-11-10-split-pacer-server-review.md` (create the directory; `.work/` is untracked). Include: scope with base and head, reviewer identity (agent and model) and independence, governance version from the constitution, checks you actually ran with their results, checks you could not run, and findings. Each finding names its rule ID or "advisory", severity (blocking / nonblocking), file and line, evidence, impact and remedy, and says whether it was introduced by this branch or is pre-existing. End with a verdict: PASS, FAIL or UNVERIFIED. Missing evidence is never PASS.

The task succeeds when the report is written, whatever the verdict. Report the verdict, the blocking findings in one line each, and the report path.
