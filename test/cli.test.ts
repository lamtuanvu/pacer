import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { main } from "../src/cli";
import { fakeCtx } from "./helpers";

const OK_STRATEGY = "planner: claude-code\nproviders:\n  claude-code: {}\n  local: { via: opencode, model: lmstudio/q, usage: unmetered }\n";

async function withStrategy(yaml: string) {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), yaml);
  return ctx;
}

test("status --json prints the full status object", async () => {
  const ctx = await withStrategy(OK_STRATEGY);
  const r = await main(["status", "--json"], ctx);
  expect(r.code).toBe(0);
  const st = JSON.parse(r.out);
  expect(st.planner).toBe("claude-code");
  expect(st.providers.map((p: { id: string }) => p.id)).toEqual(["claude-code", "opencode#local"]);
  expect(typeof st.calendarPace).toBe("boolean");
});

test("missing strategy: status exits 2 with guidance; --line and --hook still exit 0", async () => {
  const ctx = fakeCtx();
  const r = await main(["status"], ctx);
  expect(r.code).toBe(2);
  expect(r.err).toContain("no strategy found");
  expect(r.err).toContain("examples/strategy.yaml");
  const line = await main(["status", "--line"], ctx);
  expect(line.code).toBe(0);
  expect(line.out).toContain("◆ Budget ? (no strategy found");
  const hook = await main(["status", "--hook", "claude-code"], ctx);
  expect(hook).toEqual({ code: 0, out: "{}", err: "" });
});

test("invalid strategy exits 2 listing every problem, without a stack trace", async () => {
  const ctx = await withStrategy("planner: gemini\nproviders:\n  x: {}\npacing: { policy: fastest }\n");
  const r = await main(["status"], ctx);
  expect(r.code).toBe(2);
  expect(r.err).toContain("invalid strategy");
  expect(r.err).toContain("planner must be one of");
  expect(r.err).toContain("pacing.policy must be one of");
  expect(r.err).not.toContain("    at ");
});

test("use switches strategies; unknown commands print usage with exit 2", async () => {
  const ctx = await withStrategy(OK_STRATEGY);
  mkdirSync(join(ctx.pacerHome, "strategies"), { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategies", "offline.yaml"), OK_STRATEGY.replace("claude-code", "opencode"));
  expect((await main(["use", "offline"], ctx)).code).toBe(0);
  expect(JSON.parse((await main(["status", "--json"], ctx)).out).planner).toBe("opencode");
  const bad = await main(["frobnicate"], ctx);
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("usage: pacer");
});

test("route prints the priority order and help lists the new commands", async () => {
  const ctx = await withStrategy("planner: claude-code\nproviders:\n  claude-code: {}\n  codex: { usage: reactive }\n  cursor: {}\n");
  const r = await main(["route", "debug"], ctx);
  expect(r.code).toBe(0);
  expect(r.out).toContain("1. codex");
  expect(r.out).toContain("2. cursor");
  expect(r.out).toContain("excluded: claude-code (planner)");
  const help = await main(["help"], ctx);
  for (const c of ["route", "delegate", "tasks", "stop", "mcp", "serve"]) expect(help.out).toContain(c);
  const bad = await main(["delegate", "--goal", "x", "--repo", "relative"], ctx);
  expect(bad.code).toBe(2);
  expect(bad.err).toContain("repo does not exist");
});

test("delegate help and validation include task worktree choices",async()=>{
 const ctx=await withStrategy(OK_STRATEGY);
 expect((await main(["help"],ctx)).out).toContain("--worktree current|new|auto");
 for(const flags of [["--worktree","bad"],["--worktree-reason","x".repeat(201)]]){
 const r=await main(["delegate","--goal","test","--repo",ctx.home,...flags],ctx);
 expect(r.code).toBe(2);expect(r.err).toContain(flags[0]==="--worktree"?"worktree must be one of":"worktree_reason must be a string");
 }
});
test("pacer tasks displays resolved placement in detail and list",async()=>{
 const ctx=await withStrategy(OK_STRATEGY), {createTask,updateTask}=await import("../src/tasks/store");
 const task=createTask(ctx,{brief:{goal:"fix",repo:ctx.home},kind:null,requestedExecutor:null,timeoutS:60});
 updateTask(ctx,task.id,t=>{t.placement={requested:"current",mode:"current",why:"agent: follow-up"};});
 for(const args of [["tasks"],["tasks",task.id]])expect((await main(args,ctx)).out).toContain("current (agent: follow-up)");
 expect(JSON.parse((await main(["tasks",task.id,"--json"],ctx)).out).placement).toMatchObject({mode:"current",why:"agent: follow-up"});
});
