import { withLoginIndicators } from "./helpers";
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cliDeps, main } from "../src/cli";
import { createTask, readTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";
import { KINDS } from "../src/config/strategy";

const OK_STRATEGY = "planner: claude-code\nproviders:\n  claude-code: {}\n  local: { via: opencode, model: lmstudio/q, usage: unmetered }\n";

test("pacer limits check --json lists every account", async () => {
  const ctx = await withStrategy(OK_STRATEGY);
  const r = await main(["limits", "check", "--json"], ctx);
  expect(r.code).toBe(0);
  const rows = JSON.parse(r.out);
  expect(rows.map((x: { account: string }) => x.account).sort()).toEqual(Object.keys((await import("../src/config/strategy")).loadStrategy(ctx).accounts).sort());
});

async function withStrategy(yaml: string) {
  const ctx = withLoginIndicators(fakeCtx());
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
  const ctx = withLoginIndicators(fakeCtx());
  const r = await main(["status"], ctx);
  expect(r.code).toBe(2);
  expect(r.err).toContain("no strategy at");
  expect(r.err).toContain("Run: pacer init");
  const line = await main(["status", "--line"], ctx);
  expect(line.code).toBe(0);
  expect(line.out).toMatch(/▬┃(\x1b\[0m)? pacer not running · pacer serve$/);
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

async function withNoSpawn<T>(fn: (spawned: string[]) => Promise<T>): Promise<T> {
  const original = cliDeps.spawnRunner, spawned: string[] = [];
  cliDeps.spawnRunner = (_c, id) => { spawned.push(id); return 1; };
  try { return await fn(spawned); } finally { cliDeps.spawnRunner = original; }
}

test("delegate accepts kind aliases and preserves canonical kinds", async () => {
  const ctx = await withStrategy(OK_STRATEGY);
  const aliases = { bugfix: "debug", fix: "debug", bug: "debug", test: "tests", doc: "docs", perf: "performance" };
  await withNoSpawn(async (spawned) => {
    for (const [kind, canonical] of [...Object.entries(aliases), ...KINDS.map(kind => [kind, kind])]) {
      const result = await main(["delegate", "--goal", "Fix the task", "--repo", ctx.home, "--kind", kind, "--json"], ctx);
      expect(result.code).toBe(0);
      const task = JSON.parse(result.out);
      expect(task.kind).toBe(canonical);
      expect(readTask(ctx, task.id)?.kind).toBe(canonical);
    }
    expect(spawned).toHaveLength(Object.keys(aliases).length + KINDS.length);
  });
});

test("delegate normalizes brief-file and stdin kinds after flag overrides", async () => {
  const ctx = await withStrategy(OK_STRATEGY);
  const path = join(ctx.home, "brief.json");
  writeFileSync(path, JSON.stringify({ goal: "Fix the task", repo: ctx.home, kind: "bugfix" }));
  await withNoSpawn(async () => {
    const fromFile = await main(["delegate", "--brief-file", path, "--json"], ctx);
    expect(fromFile.code).toBe(0);
    expect(JSON.parse(fromFile.out).kind).toBe("debug");
    const overridden = await main(["delegate", "--brief-file", path, "--kind", "doc", "--json"], ctx);
    expect(overridden.code).toBe(0);
    expect(JSON.parse(overridden.out).kind).toBe("docs");
    const { io } = await import("../src/install/stdin");
    const original = io.readBriefStdin;
    try {
      io.readBriefStdin = async () => JSON.stringify({ goal: "Test the task", repo: ctx.home, kind: "test" });
      const fromStdin = await main(["delegate", "--brief-file", "-", "--json"], ctx);
      expect(fromStdin.code).toBe(0);
      expect(JSON.parse(fromStdin.out).kind).toBe("tests");
    } finally { io.readBriefStdin = original; }
  });
});

test("delegate suggests the closest kind for typos without starting a task", async () => {
  const ctx = await withStrategy(OK_STRATEGY);
  await withNoSpawn(async (spawned) => {
    for (const [kind, closest] of [["debg", "debug"], ["performnce", "performance"], ["tsets", "tests"]]) {
      const result = await main(["delegate", "--goal", "Fix the task", "--repo", ctx.home, "--kind", kind], ctx);
      expect(result.code).toBe(2);
      expect(result.err).toContain(`unknown kind "${kind}"`);
      expect(result.err).toContain(`allowed: ${KINDS.join(", ")}`);
      expect(result.err).toContain(`did you mean "${closest}"?`);
    }
    const inheritedKey = await main(["delegate", "--goal", "Fix the task", "--repo", ctx.home, "--kind", "toString"], ctx);
    expect(inheritedKey.code).toBe(2);
    expect(inheritedKey.err).toContain('unknown kind "toString"');
    expect(spawned).toEqual([]);
  });
});

test("retry queues a retry of a task and links them", async () => {
  const ctx = await withStrategy(OK_STRATEGY);
  const t = createTask(ctx, { brief: { goal: "fix", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  await withNoSpawn(async (spawned) => {
    const r = await main(["retry", t.id, "--executor", "local"], ctx);
    expect(r.code).toBe(0);
    const next = readTask(ctx, t.id)!.retriedBy!;
    expect(r.out).toBe(`${next} queued (retry of ${t.id})`);
    expect(spawned).toEqual([next]);
    expect(readTask(ctx, next)?.requestedExecutor).toBe("opencode#local"); // legacy alias resolved to its runner id
  });
});

test("retry of an unknown task exits 2", async () => {
  const ctx = await withStrategy(OK_STRATEGY);
  const r = await withNoSpawn(() => main(["retry", "missing"], ctx));
  expect(r).toMatchObject({ code: 2, err: expect.stringContaining("unknown task missing") });
});

test("dismiss dismisses known ids and exits 2 naming unknown ones", async () => {
  const ctx = await withStrategy(OK_STRATEGY);
  const t = createTask(ctx, { brief: { goal: "fix", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const r = await main(["dismiss", "missing", t.id], ctx);
  expect(r.code).toBe(2);
  expect(r.out).toBe(`${t.id} dismissed`);
  expect(r.err).toContain("unknown task missing");
  expect(readTask(ctx, t.id)?.dismissed).toBe(true);
});

test("retry is refused inside an executor session, like delegate", async () => {
  const ctx = await withStrategy(OK_STRATEGY);
  const t = createTask(ctx, { brief: { goal: "fix", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  ctx.env.PACER_ROLE = "executor";
  const r = await withNoSpawn(async (spawned) => { const out = await main(["retry", t.id], ctx); expect(spawned).toEqual([]); return out; });
  expect(r.code).toBe(2);
  expect(r.err).toContain("pacer executors cannot delegate onward");
  expect(readTask(ctx, t.id)?.retriedBy).toBeUndefined();
});

test("pacer clean --dry-run --json prints the plan", async () => {
  const ctx = await withStrategy(OK_STRATEGY);
  const r = await main(["clean", "--dry-run", "--json"], ctx);
  expect(r.code).toBe(0);
  expect(JSON.parse(r.out)).toEqual({ removed: [], kept: [] });
});
