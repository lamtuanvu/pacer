import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { main } from "../src/cli";
import { isExecutorSession } from "../src/install/role";
import { io } from "../src/install/stdin";
import { claudeCachePaths } from "../src/usage/claude";
import { fakeCtx, withLoginIndicators } from "./helpers";

const commands = [
  ["guard", "--planner", "claude-code"],
  ["session-start", "--planner", "claude-code"],
  ["status", "--hook", "claude-code"],
];
for (const command of commands) {
  for (const condition of ["role", "input cwd", "process cwd", "different planner", "planner", "ordinary directory", "hand-made worktree", "unknown provider"]) {
    test(`${command[0]} isolates executor sessions: ${condition}`, async () => {
      const ctx = fakeCtx({ env: condition === "role" ? { PACER_ROLE: "executor" } : {} });
      mkdirSync(ctx.pacerHome, { recursive: true });
      writeFileSync(join(ctx.pacerHome, "strategy.yaml"), `planner: ${condition === "different planner" ? "codex" : "claude-code"}\nproviders:\n  claude-code: {}\n  codex: { usage: reactive }\n`);
      withLoginIndicators(ctx);
      // Exercise a measured planner: cold-start guards intentionally allow subagents.
      const cache = claudeCachePaths(ctx)[0];
      mkdirSync(dirname(cache), { recursive: true });
      writeFileSync(cache, JSON.stringify({ seven_day: { used_percentage: 50, resets_at: ctx.now + 3 * 86400 }, captured_at: ctx.now }));
      const worktree = join(ctx.home, "orca/workspaces/repo/pacer-t-20261011-140500-abcd-codex/src");
      const oldCwd = process.cwd();
      const original = io.readStdin;
      try {
        io.readStdin = async () => JSON.stringify({
          tool_name: "Agent", tool_input: { subagent_type: "general-purpose", prompt: "Implement this" },
          cwd: condition === "hand-made worktree" ? join(ctx.home, "orca/workspaces/repo/pacer-exec-final-fix") : condition === "unknown provider" ? worktree.replace("-codex/", "-unknown/") : condition === "input cwd" ? worktree : join(ctx.home, "repo/pacer-t-20261011-140500-abcd-codex"),
        });
        if (condition === "process cwd") {
          mkdirSync(worktree, { recursive: true });
          process.chdir(worktree);
        }
        const r = await main(command, ctx);
        expect(r.code).toBe(0);
        if (condition === "planner" || condition === "ordinary directory" || condition === "hand-made worktree" || condition === "unknown provider") expect(r.out).not.toBe("");
        else expect(r.out).toBe("");
      } finally { process.chdir(oldCwd); io.readStdin = original; }
    });
  }
}

test("a cwd inside a pacer task worktree is an executor session", () => {
  const ctx = fakeCtx();
  const cwd = join(ctx.pacerHome, "worktrees", "repo-1a2b3c4d", "t-20261014-120000-abcd", "src");
  expect(isExecutorSession(ctx, { cwd })).toBe(true);
  expect(isExecutorSession(ctx, { cwd: join(ctx.pacerHome, "worktrees", "repo-1a2b3c4d", "not-a-task") })).toBe(false);
});

test("an Orca lane worktree for a runner with an account (codex#work, stored as codex-work) is an executor session", () => {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), JSON.stringify({ planner: "claude-code",
    accounts: { main: { kind: "claude" }, codex: { kind: "codex" }, work: { kind: "codex", home: join(ctx.home, ".codex-work") } }, routing: [{ default: ["codex#work"] }] }));
  mkdirSync(join(ctx.home, ".codex-work"), { recursive: true });
  expect(isExecutorSession(ctx, { cwd: join(ctx.home, "orca/workspaces/repo/pacer-t-20261011-140500-abcd-codex-work/src") })).toBe(true);
  expect(isExecutorSession(ctx, { cwd: join(ctx.home, "orca/workspaces/repo/pacer-t-20261011-140500-abcd-codex-other/src") })).toBe(false);
});
