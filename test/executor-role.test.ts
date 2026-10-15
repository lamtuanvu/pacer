import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { isExecutorSession } from "../src/install/role";
import { io } from "../src/install/stdin";
import { fakeCtx } from "./helpers";

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
