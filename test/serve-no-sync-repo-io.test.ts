import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as cp from "node:child_process";
import { join, resolve, sep } from "node:path";
import { liveSnapshot, eventsSince } from "../src/api/events";
import { defaultPumpDeps, pumpOnce, taskData } from "../src/link/pump";
import { appendOutbox } from "../src/link/store";
import { writeJsonAtomic } from "../src/fsutil";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";
import { capacityFixture } from "./read-model-helpers";

// Record before forwarding so a forbidden call is attributable to its API.
test("serve snapshot, replay and default pump never use synchronous repo I/O", async () => {
  const ctx = fakeCtx({ which: () => null }), root = join(tmpDir(), "repos-root");
  const repo = join(root, "repo"), worktree = join(root, "worktree");
  fs.mkdirSync(repo, { recursive: true }); fs.mkdirSync(worktree, { recursive: true });
  const { st } = capacityFixture();
  fs.mkdirSync(ctx.pacerHome, { recursive: true });
  fs.writeFileSync(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  writeJsonAtomic(join(ctx.pacerHome, "state", "repos.json"), { [repo]: { key: "local:repo", path: repo, lastUsed: ctx.now } });
  const task = createTask(ctx, { brief: { goal: "repo I/O enforcement", repo }, kind: null, requestedExecutor: null, timeoutS: 60 });
  const record = updateTask(ctx, task.id, t => { t.state = "partial"; t.worktree = worktree; t.repo = { key: "local:repo", path: repo, label: "repo" }; });
  appendOutbox(ctx, [{ seq: 1, at: ctx.now, envelope: { type: "task", data: taskData(record) } }]);
  const calls: { api: string; args: unknown[] }[] = [], spies: { mockRestore(): void }[] = [];
  const watch = (object: any, name: string) => {
    const original = object[name];
    spies.push(spyOn(object, name).mockImplementation((...args: unknown[]) => {
      calls.push({ api: name, args }); return original.apply(object, args);
    }));
    if (name === "realpathSync") object[name].native = original.native;
  };
  try {
    // Native must be wrapped before the outer realpath function is replaced.
    watch(fs.realpathSync, "native");
    for (const name of ["existsSync", "statSync", "lstatSync", "realpathSync", "readFileSync", "openSync", "readdirSync", "accessSync"]) watch(fs, name);
    for (const name of ["execFileSync", "spawnSync"]) watch(cp, name);
    watch(Bun, "spawnSync");
    await liveSnapshot(ctx, { status: async () => st });
    eventsSince(ctx, 0, 2); eventsSince(ctx, 0, 3);
    await pumpOnce(ctx, { ...defaultPumpDeps, status: async () => st });
    const hasRepo = (value: unknown): boolean => {
      if (typeof value === "string") return resolve(value) === root || resolve(value).startsWith(root + sep);
      if (value instanceof URL) return hasRepo(value.pathname);
      if (Buffer.isBuffer(value)) return hasRepo(value.toString());
      if (Array.isArray(value)) return value.some(hasRepo);
      if (value && typeof value === "object") return Object.values(value).some(hasRepo);
      return false;
    };
    expect(calls.filter(c => c.args.some(hasRepo))).toEqual([]);
    expect(calls.length).toBeGreaterThan(0);
  } finally { for (const spy of spies.reverse()) spy.mockRestore(); }
});

test("FIFO repositories leave real HTTP health and snapshot responsive", async () => {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "serve-fifo.ts")], { stdout: "pipe", stderr: "pipe" });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const code = await Promise.race([child.exited, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { child.kill("SIGKILL"); reject(Error("FIFO service timed out")); }, 15000);
    })]);
    const stderr = await new Response(child.stderr).text();
    expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
  } finally { clearTimeout(timer); child.kill(); }
}, 20000);
