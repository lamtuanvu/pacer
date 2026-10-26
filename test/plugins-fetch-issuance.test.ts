import {enableReviewed} from "./fixtures/plugin-consent";
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { installFixture } from "../conformance/install";
import { PluginRegistry } from "../src/plugins/registry";
import { issuePersistedFetch } from "../src/plugins/fetch-issuer";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

function fixture() {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n");
  const task = createTask(ctx, { brief: { goal: "fetch", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, record => {
    record.run = { dir: join(ctx.pacerHome, "runs", task.id), attempt: 1, executor: "codex", startedAt: ctx.now,
      mode: "new", workdir: "/remote/worktree", logFile: join(ctx.pacerHome, "tasks", "run.log"),
      host: "box", remoteWorktree: "/remote/worktree", baseSha: "a".repeat(40), remoteBranch: `pacer/${task.id}` };
  });
  return { ctx, taskId: task.id };
}

test("persisted run issuer pins exact BUNDLE_OUT tuple and refuses replay", async () => {
  const issuer = await import("../src/plugins/fetch-issuer").catch(() => null);
  expect(issuer).not.toBeNull();
  const f = fixture();
  const grant = issuer!.issuePersistedFetch(f.ctx, f.taskId, 1);
  expect(grant.resource.args).toEqual(["/remote/worktree", "a".repeat(40), `pacer/${f.taskId}`]);
  expect(grant.resource.argv.join(" ")).toContain("ssh-fixture");
  issuer!.consumePersistedFetch(f.ctx, grant);
  expect(() => issuer!.consumePersistedFetch(f.ctx, grant)).toThrow();
});

test("persisted run grant retires when task revision or host generation changes", async () => {
  const issuer = await import("../src/plugins/fetch-issuer").catch(() => null);
  expect(issuer).not.toBeNull();
  const f = fixture();
  const old = issuer!.issuePersistedFetch(f.ctx, f.taskId, 1);
  updateTask(f.ctx, f.taskId, task => { task.run!.remoteWorktree = "/remote/changed"; });
  expect(() => issuer!.validatePersistedFetch(f.ctx, old)).toThrow();
  const current = issuer!.issuePersistedFetch(f.ctx, f.taskId, 1);
  writeFileSync(join(f.ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: changed-host\n");
  expect(() => issuer!.validatePersistedFetch(f.ctx, current)).toThrow();
});

test("persisted fetch issuer rejects incomplete and forged run authority", async () => {
  const issuer = await import("../src/plugins/fetch-issuer").catch(() => null);
  expect(issuer).not.toBeNull();
  const f = fixture();
  expect(() => issuer!.issuePersistedFetch(f.ctx, f.taskId, 2)).toThrow();
  const grant = issuer!.issuePersistedFetch(f.ctx, f.taskId, 1);
  expect(() => issuer!.validatePersistedFetch(f.ctx, structuredClone(grant))).toThrow();
  updateTask(f.ctx, f.taskId, task => { delete task.run!.baseSha; });
  expect(() => issuer!.issuePersistedFetch(f.ctx, f.taskId, 1)).toThrow();
});

test("registry host claim runs before provider authority is revoked", async () => {
  const f = fixture();
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(f.ctx.home, "node_modules"), "dir");
  const handle = randomUUID();
  installFixture("host-runner", join(f.ctx.pacerHome, "plugins"), {
    manifest: { capabilities: [{ name: "process.spawn", scopes: ["ssh"] }] },
    fixture: { fetchStageHandle: handle },
  });
  f.ctx.which = name => name === "ssh" ? "/bin/sh" : null;
  f.ctx.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundled provider"); }, eventPumpMs: 0 });
  try {
    await enableReviewed(registry, f.ctx, "fx-host-runner");
    const badGrant = issuePersistedFetch(f.ctx, f.taskId, 1);
    await expect(registry.callIssuedHostFetch(f.ctx, "fx-host-runner", badGrant,
      { session: "s".repeat(32), script: "BUNDLE_OUT", args: ["/remote/other", "a".repeat(40), `pacer/${f.taskId}`],
        timeoutMs: 5000, maxBytes: 16 }, () => {})).rejects.toMatchObject({ code: "capability_denied" });
    expect(registry.list(f.ctx).find(plugin => plugin.id === "fx-host-runner")?.pid).toBeNull();
    const grant = issuePersistedFetch(f.ctx, f.taskId, 1);
    const input = { session: "s".repeat(32), script: "BUNDLE_OUT", args: grant.resource.args,
      timeoutMs: 5000, maxBytes: 16 };
    let captured: { assertActive(): void } | undefined;
    expect(typeof (registry as any).callIssuedHostFetch).toBe("function");
    await (registry as any).callIssuedHostFetch(f.ctx, "fx-host-runner", grant, input,
      (authority: { assertActive(): void }, staged: { handle: string; bytes: number; sha256: string }) => {
        authority.assertActive();
        expect(staged.handle).toBe(handle);
        captured = authority;
      });
    expect(() => captured!.assertActive()).toThrow();
    await expect((registry as any).callIssuedHostFetch(f.ctx, "fx-host-runner", grant, input, () => {}))
      .rejects.toMatchObject({ code: "capability_denied" });
  } finally { await registry.shutdown(); }
});

test("registry refuses a provider's public filename as an unclaimed staged result", async () => {
  const f = fixture();
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(f.ctx.home, "node_modules"), "dir");
  installFixture("host-runner", join(f.ctx.pacerHome, "plugins"), {
    manifest: { capabilities: [{ name: "process.spawn", scopes: ["ssh"] }] },
  });
  f.ctx.which = name => name === "ssh" ? "/bin/sh" : null;
  f.ctx.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundled provider"); }, eventPumpMs: 0 });
  try {
    await enableReviewed(registry, f.ctx, "fx-host-runner");
    const grant = issuePersistedFetch(f.ctx, f.taskId, 1);
    let claimed = false;
    await expect(registry.callIssuedHostFetch(f.ctx, "fx-host-runner", grant,
      { session: "s".repeat(32), script: "BUNDLE_OUT", args: grant.resource.args, timeoutMs: 5000, maxBytes: 16 },
      () => { claimed = true; })).rejects.toMatchObject({ code: "plugin_refused" });
    expect(claimed).toBe(false);
  } finally { await registry.shutdown(); }
});

test("task revision retirement during provider fetch prevents the host claim", async () => {
  const f = fixture();
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(f.ctx.home, "node_modules"), "dir");
  const folder = installFixture("host-runner", join(f.ctx.pacerHome, "plugins"), {
    manifest: { capabilities: [{ name: "process.spawn", scopes: ["ssh"] }] },
    fixture: { fetchStageHandle: randomUUID(), delayMs: 500, delayMethod: "hostRunner.fetch" },
  });
  f.ctx.which = name => name === "ssh" ? "/bin/sh" : null;
  f.ctx.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundled provider"); }, eventPumpMs: 0 });
  try {
    await enableReviewed(registry, f.ctx, "fx-host-runner");
    const grant = issuePersistedFetch(f.ctx, f.taskId, 1);
    let claimed = false;
    const pending = registry.callIssuedHostFetch(f.ctx, "fx-host-runner", grant,
      { session: "s".repeat(32), script: "BUNDLE_OUT", args: grant.resource.args, timeoutMs: 5000, maxBytes: 16 },
      () => { claimed = true; });
    void pending.catch(() => {});
    const log = join(folder, "calls.jsonl"), until = Date.now() + 3000;
    while (Date.now() < until) {
      try { if (readFileSync(log, "utf8").includes('"phase":"enter"')) break; } catch {}
      await Bun.sleep(10);
    }
    expect(readFileSync(log, "utf8")).toContain('"phase":"enter"');
    updateTask(f.ctx, f.taskId, task => { task.run!.remoteWorktree = "/remote/replaced"; });
    await expect(pending).rejects.toMatchObject({ code: "capability_denied" });
    expect(claimed).toBe(false);
  } finally { await registry.shutdown(); }
});

test("provider configuration retirement during an async claim prevents success", async () => {
  const f = fixture();
  symlinkSync(join(import.meta.dir, "..", "node_modules"), join(f.ctx.home, "node_modules"), "dir");
  installFixture("host-runner", join(f.ctx.pacerHome, "plugins"), {
    manifest: { capabilities: [{ name: "process.spawn", scopes: ["ssh"] }] },
    fixture: { fetchStageHandle: randomUUID() },
  });
  f.ctx.which = name => name === "ssh" ? "/bin/sh" : null;
  f.ctx.env.PATH = `${dirname(process.execPath)}:/usr/bin:/bin`;
  const registry = new PluginRegistry({ bundled: [], spawnBundled: () => { throw Error("no bundled provider"); }, eventPumpMs: 0 });
  try {
    await enableReviewed(registry, f.ctx, "fx-host-runner");
    const grant = issuePersistedFetch(f.ctx, f.taskId, 1);
    await expect(registry.callIssuedHostFetch(f.ctx, "fx-host-runner", grant,
      { session: "s".repeat(32), script: "BUNDLE_OUT", args: grant.resource.args, timeoutMs: 5000, maxBytes: 16 },
      async authority => {
        authority.assertActive();
        await Bun.sleep(10);
        writeFileSync(join(f.ctx.pacerHome, "strategy.yaml"),
          "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\nplugins:\n  config:\n    fx-host-runner: {revision: 2}\n");
      })).rejects.toMatchObject({ code: "capability_denied" });
  } finally { await registry.shutdown(); }
});
