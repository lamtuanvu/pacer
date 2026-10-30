import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { callOp } from "../src/api/ops";
import { loadStrategy } from "../src/config/strategy";
import { writeJsonAtomic } from "../src/fsutil";
import { registerJobDaemon, startJob } from "../src/jobs/registry";
import { remoteExclusion } from "../src/remote/eligibility";
import * as hosts from "../src/remote/hosts";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";
import { shutdownPlugins } from "../src/plugins";
import { registerFixtureCleanup } from "./fixture-cleanup";

function fixture() {
  const ctx = fakeCtx();
  const pacerHome = ctx.pacerHome;
  registerFixtureCleanup(() => shutdownPlugins({ pacerHome }));
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"), stringify({
    accounts: { claude: { kind: "claude" }, codex: { kind: "codex" } }, planner: "claude-code",
    hosts: { devbox: { ssh: "dev-ssh", repos: { "github.com/o/r": "~/src/r" }, accounts: { codex: { home: "~/.codex" } } } },
    routing: [{ default: ["codex@devbox", "codex"] }],
  }));
  return ctx;
}
test("host.set persists capacity and pause, excluding routing without probing", async () => {
  const ctx = fixture();
  expect(await callOp(ctx, "host.set", { alias: "devbox", paused: true, max_tasks: 4 })).toMatchObject({ alias: "devbox", paused: true, maxTasks: 4, state: "paused" });
  const s = loadStrategy(ctx);
  expect(await remoteExclusion(ctx, s, "codex@devbox", undefined, { reachable: async () => { throw Error("must not probe"); } })).toBe("devbox paused");
  expect(await callOp(ctx, "host.set", { alias: "devbox", paused: false })).toMatchObject({ paused: false, maxTasks: 4 });
  const before = readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8");
  for (const p of [{ max_tasks: 0 }, { max_tasks: 17 }, { max_tasks: 1.5 }, { paused: "yes" }]) {
    await expect(callOp(ctx, "host.set", { alias: "devbox", ...p })).rejects.toMatchObject({ code: "invalid_input" });
  }
  expect(readFileSync(join(ctx.pacerHome, "strategy.yaml"), "utf8")).toBe(before);
  await expect(callOp(ctx, "host.set", { alias: "missing", paused: true })).rejects.toMatchObject({ code: "invalid_input" });
});
test("host.suggest filters configured SSH targets", async () => {
  const ctx = fixture();
  mkdirSync(join(ctx.home, ".ssh"));
  writeFileSync(join(ctx.home, ".ssh/config"), "Host dev-ssh fresh-box\nHost *\n");
  expect(await callOp(ctx, "host.suggest", {})).toEqual(["fresh-box"]);
  expect(await callOp(ctx, "host.suggest", {details:true})).toEqual([{name:"fresh-box",host:"fresh-box"}]);
});
test("host.get assembles checks, repo status, executors and weekly host task counts", async () => {
  const ctx = fixture();
  writeJsonAtomic(join(ctx.pacerHome, "state/host-checks.json"), { devbox: { at: ctx.now - 60, ok: false,
    facts: { os: "Linux", arch: "x86_64", git: "2.43.0", setsid: "/bin/setsid", tools: {} },
    checks: [{ name: "checkout github.com/o/r", ok: false, detail: "origin mismatch" }, { name: "identity github.com/o/r", ok: true, detail: "" }] } });
  for (const [host, state, age, accepted] of [
    ["devbox", "done", 1, true], ["devbox", "done", 2, false], ["devbox", "failed", 3, true],
    ["devbox", "done", 8, true], ["other", "done", 1, true], ["devbox", "running", 0, false],
  ] as const) {
    const t = createTask(ctx, { brief: { goal: "work", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    updateTask(ctx, t.id, t => { t.state = state; Object.assign(t, { updatedAt: ctx.now - age * 86400 });
      t.review = { accepted, kind: null, note: null, at: ctx.now - age * 86400 };
      t.run = { host, mode: "new", dir: "run", workdir: "work", attempt: 1, executor: "codex@devbox", startedAt: ctx.now - age * 86400, logFile: "log" };
    });
  }
  expect(await callOp(ctx, "host.get", { alias: "devbox" })).toMatchObject({
    alias: "devbox", state: "needs_setup", checkedAt: ctx.now - 60, reachableAt: null, running: 1, slots: { used: 1, max: 2 },
    facts: { git: "2.43.0" }, executors: [{id:"codex@devbox",host:"devbox",enabled:true}], doneThisWeek: { done: 2, accepted: 1 },
    repos: [{ key: "github.com/o/r", path: "~/src/r", origin: "differs", identity: "matches" }],
    accounts: [{ name: "codex", home: "~/.codex", signedIn: null }], worktrees: [],
  });
  await expect(callOp(ctx, "host.get", { alias: "missing" })).rejects.toMatchObject({ code: "invalid_input" });
});
test("host state follows paused, down, checking, needs_setup, ready priority", async () => {
  const ctx = fixture(), unregister = registerJobDaemon(ctx);
  let release!: () => void;
  try {
    expect((await hosts.detail(ctx, "devbox")).state).toBe("ready");
    const job = await startJob(ctx, "host.check", "devbox", [], async () => { await new Promise<void>(r => { release = r; }); });
    expect((await hosts.detail(ctx, "devbox")).state).toBe("checking");
    writeJsonAtomic(join(ctx.pacerHome, "cache/hosts.json"), { devbox: { target: createHash("sha256").update(JSON.stringify(loadStrategy(ctx).hosts.devbox)).digest("hex"), at: ctx.now - 1, reachable: false, failures: 2 } });
    expect(await hosts.detail(ctx, "devbox")).toMatchObject({ state: "down", reachableAt: ctx.now - 1 });
    await callOp(ctx, "host.set", { alias: "devbox", paused: true });
    expect((await hosts.detail(ctx, "devbox")).state).toBe("paused");
    expect(job.state).toBe("running");
  } finally { release?.(); unregister(); }
});
