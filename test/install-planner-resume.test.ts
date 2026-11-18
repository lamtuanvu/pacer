import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fakeCtx, tmpDir } from "./helpers";
import { resumeArgv, resumeCaller, type PlannerReach, type ResumeSpawn } from "../src/install/planner-resume";
import type { PlannerKind } from "../src/messaging/identity";
import { readActivity } from "../src/activity/log";

const UNKNOWN = "opencode" as unknown as PlannerKind;
const calls: ResumeSpawn[] = [];
const recorder = (o: ResumeSpawn) => { calls.push(o); return 4242; };

test("builds the Claude Code argv", () => {
  expect(resumeArgv("claude-code", "a1b2", "review task t-1")).toEqual(["claude", "--resume", "a1b2", "-p", "review task t-1"]);
});

test("builds the Codex argv", () => {
  expect(resumeArgv("codex", "th-9", "review task t-1")).toEqual(["codex", "exec", "resume", "th-9", "review task t-1"]);
});

test("refuses while the caller is alive", async () => {
  calls.length = 0;
  const ctx = fakeCtx();
  const out = await resumeCaller(ctx, { kind: "claude-code", session: "a1b2", cwd: tmpDir() }, "review", { task: "t-1", isAlive: async () => true, spawn: recorder });
  expect(out).toBe("unavailable");
  expect(calls).toEqual([]);
  expect(existsSync(join(ctx.pacerHome, "runs"))).toBe(false);
});

test("spawns in the caller's cwd with an argument vector", async () => {
  calls.length = 0;
  const ctx = fakeCtx(), cwd = tmpDir();
  const reach: PlannerReach = { kind: "claude-code", session: "a1b2", cwd };
  expect(await resumeCaller(ctx, reach, "review task t-1", { task: "t-1", isAlive: async () => false, spawn: recorder })).toBe("resumed");
  expect(await resumeCaller(ctx, reach, "again", { task: "t-1", isAlive: async () => false, spawn: recorder })).toBe("resumed");
  expect(calls.map(c => c.argv)).toEqual([
    ["claude", "--resume", "a1b2", "-p", "review task t-1"],
    ["claude", "--resume", "a1b2", "-p", "again"],
  ]);
  for (const c of calls) expect(c.cwd).toBe(cwd);
  expect(calls[0]!.env.PACER_PLANNER_SESSION).toBe("claude-code:a1b2");
  expect(calls[0]!.env.PACER_HOST_SOCKET).toBeUndefined();
  expect(calls[0]!.env.HOME).toBe(ctx.home);
  expect(calls[0]!.env.PACER_HOME).toBe(ctx.pacerHome);
  expect(calls.map(c => c.log)).toEqual([
    join(ctx.pacerHome, "runs", "caller-a1b2", "1.log"),
    join(ctx.pacerHome, "runs", "caller-a1b2", "2.log"),
  ]);
  for (const log of calls.map(c => c.log)) expect(existsSync(log)).toBe(true);
  expect(readActivity(ctx, {}).entries[0]).toMatchObject({ kind: "message", level: "info", text: "caller resumed for t-1", taskId: "t-1" });
});

test("unknown planner kinds are unavailable", async () => {
  calls.length = 0;
  expect(resumeArgv(UNKNOWN, "a1b2", "review")).toBeNull();
  expect(resumeArgv("claude-code", "", "review")).toBeNull();
  const ctx = fakeCtx();
  const out = await resumeCaller(ctx, { kind: UNKNOWN, session: "a1b2", cwd: tmpDir() }, "review", { task: "t-1", isAlive: async () => false, spawn: recorder });
  expect(out).toBe("unavailable");
  expect(calls).toEqual([]);
});
