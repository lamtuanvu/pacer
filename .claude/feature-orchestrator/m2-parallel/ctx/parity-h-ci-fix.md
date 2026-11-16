# Task: fix PR #970 (owner parity H) CI failure — a crash mid-call reports "stdout closed" instead of the child's exit

Executor: cursor-agent (default model, frontier tier: a race in the owner's call path). No subagents.

Worktree: /Users/vulam/orca/workspaces/pacer/pinfish/.work/worktrees/parity-h, branch of PR #970, head `810ea2628` (auto-merge on).

Read and follow /Users/vulam/orca/workspaces/pacer/pinfish/.claude/feature-orchestrator/m2-parallel/ctx/w4-common.md first. Never use `git stash`.

## Failure (CI, ubuntu, shard 2)

`test/native-plugin-crash.test.ts:133` — "a crash mid-call fails that call as plugin_unavailable naming the plugin":

```
expected: { code: "plugin_unavailable", message: "ui.action: plugin fx-ui exited on SIGKILL" }
received: { code: "plugin_unavailable", message: "plugin process unavailable: plugin process is unavailable: stdout closed" }
```

The test predates H (wave 3 PR 5, #927) and passed on main. The native message lost its `ui.action:` prefix and reports the stream closing instead of the exit, so it likely comes from H's new path for the door's own `plugin.ui.*` / `plugin.doctor` calls (sealed owner call without the flat 30 s deadline, and the drain that H's review noted as F1, "up to 1 s late error during the drain"). Treat it as a real race until proven otherwise.

## Do

1. Reproduce: build the front door from the head, run the test in a loop under CPU load (for example 20 runs with a parallel `cargo build` or `stress`), in `sbx-deny` with disposable HOME and `PACER_HOME`, `env -u PACER_HOST_SOCKET -u PACER_HOST_SOCKET_KEY -u CARGO_TARGET_DIR`. Also run it on `main` to confirm main is stable.
2. Find the race: which layer turns a child exit into "plugin process unavailable: … stdout closed" without the op prefix, and why the exit isn't waited for. The intended contract (wave 3 PR 5): the owner waits for the exit and reports `<op>: plugin <id> exited on <signal|code>`.
3. Fix it in the product, not the test, and keep H's behaviour otherwise (no flat deadline, the drain). Add a deterministic test that forces the ordering (stdout closes before the exit is observed) and is red without the fix.
4. Run the crash suite 20 times under load, H's door suites, `native-plugin-*`, `plugins-native-owner-*`, fmt, clippy `-D warnings`, the crate tests you touch and typecheck.
5. CT-11: if runtime behaviour changes, a short `bun run live` with the Rust front door and the owner flag on that crashes a fixture plugin mid-call from the web or CLI and shows the reported error. Otherwise say why not.

Commit with `git commit -s` (`fix(plugins): …`), do not push. Handoff: /Users/vulam/orca/workspaces/pacer/pinfish/.work/reviews/parity-h-ci-fix-handoff.md with root cause, fix, evidence (red and green) and a PR-body paragraph. A QA re-review follows.
