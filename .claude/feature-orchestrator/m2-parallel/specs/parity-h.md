# Task: owner parity PR H — the serve door relays its plugin.doctor and plugin.ui.* calls to Core as sealed calls (PR 7 gate)

Executor: cursor-agent (default model, frontier tier: the door's plugin call path and Core's sealed authority). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-h, branch `fix/door-plugin-calls-via-core`, based on `main` `30606ef07` (includes PR A #945, B #940, C #941, D #942, E #944).

Read and follow the "Build and environment", "Live validation", "Safety" and "Output" sections of /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md. Also read AGENTS.md, `.project/constitution.md`, `.project/context.md`, `.project/rules/{security,api-protocol,rust,rust-crates,code-and-testing,architecture,repository}.md`, `.project/reviewers/{security,qa,protocol-compat}.md`, ADR 0027, `docs/testing/m2-ledger.md` (PR 7 gate list).

## The problem

PR A's review (/Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-a-review.md, §4 item 4, "DOOR_SECRET_TEXT") and the tests that name it (`test/plugin-conformance-native-owner.test.ts` near line 232, `test/plugins-native-owner-assistant-key.test.ts` near line 145): the HTTP serve door's own owner calls (`Owner::call_native` → `call_door` in `crates/server/src/native/plugins.rs`) carry no Core forward and no `coreMethods`. So flag-on, a door-originated `plugin.doctor` or `plugin.ui.*` call cannot reach `capability.secrets.resolve` or `capability.identity.sign` (Core answers those only on sealed calls), and refuses where flag-off answers. It fails closed (no leak).

A second, related gap (from the R1 worker, being recorded as a new PR 7 gate row): the door's own calls use a flat 30 s `CALL_DEADLINE` (`crates/server/src/native/plugins.rs` ~409) instead of flag-off's per-method deadlines (`diagnostic.ping` 5 s, `ui.render` 2 s, `ui.action` 10 s, `ui.settings.validate` 2 s; see `src/plugins/protocol.ts` ~221 and `registry.ts` ~2093, where the method deadline also bounds `plugin.hello`). R1 (separate worker, branch `fix/owner-hello-deadline`) raises the owner's hello cap to 10 s and leaves the door deadline to this PR.

## Scope — remedy (a) from the review

1. The serve door sends its `plugin.doctor` and `plugin.ui.*` plugin calls to its Core as a sealed relay, as the stdio door already does, so Core's `callNativeOwner` seals `coreMethods` (secrets.resolve, identity.sign and the rest A added) and answers them on its own bridge connection, with flag-off's method deadline. Read how stdio relays them today and reuse that path; do not add a door-side `CoreForward` or a new private kind (remedy (b) is rejected: new private surface, ADR change, interacts with PR G).
2. Keep the door's behavior when Core is unavailable explicit (fail closed with the same error the door returns today, or forward — choose the one that matches flag-off and record why).
3. Remove the `DOOR_SECRET_TEXT` known-differences from the conformance and assistant-key tests so the door rows now compare equal to flag-off, and add rows proving the door's doctor/ui deadlines match flag-off (a 6 s hello: doctor fails at ~5 s with flag-off's text and records a crash in both modes; a ui.render that takes 3 s fails at 2 s in both).
4. Ledger: mark the DOOR_SECRET_TEXT row and the new door-deadline row (added by R1's PR; if R1 has not merged, add it yourself and coordinate via the coordinator) green. ADR 0027: the door's plugin calls now go through Core. CHANGELOG (REPO-7).

Parallel work: R1 edits `crates/plugin-runtime/src/bridge_call.rs` (hello cap/text) and the ledger; PR F (observation generations) touches `registry.ts`, `native-call-authority.ts` and `capability.rs`; PR G (bridge caller auth) will follow F and touches `serve_host.rs`, `native/plugins.rs`, `native_host.rs`, `stdio_plugins.rs`. Keep your edits to shared files small and local.

Required checks (beyond `w4-common.md`): clippy and tests for `pacer-server`, `pacer-plugin-runtime`; `test/plugin-conformance-native-owner.test.ts`, `test/plugins-native-owner-call.test.ts`, `test/plugins-native-owner-assistant-key.test.ts`, `test/serve-plugin-native.test.ts`, `test/native-plugin-ops.test.ts`, `test/native-plugin-ops-stdio.test.ts`, `test/plugins-native-owner-matrix.test.ts`. Red evidence for each new or changed row.

CT-11: `bun run live up --front-door rust --native-plugin-host` and flag-off. Through the HTTP door: `plugin.doctor` on the bundled assistant with a fixture endpoint key (sandbox only, no real key) answers like flag-off; a plugin settings page (`plugin.ui.render`/`ui.action`) of a fixture plugin that uses `identity.sign` or `secrets.resolve`; the delayed-hello fixture's doctor deadline in both modes. Name the head.

Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-h-handoff.md. PR title: `fix(plugins): relay the serve door's plugin doctor and UI calls through Core's sealed owner call`.


Read and follow the brief at /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/parity-h.md exactly. End with orca orchestration worker_done.
