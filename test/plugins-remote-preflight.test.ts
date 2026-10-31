import { expect, test } from "bun:test";
import { createCallAuthority } from "../src/plugins/authority";
import { HostLeaseBroker } from "../src/plugins/host-lease";
import { issuePersistedFetch } from "../src/plugins/fetch-issuer";
import { validateRemotePreflight } from "../src/plugins/remote-preflight";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

function fixture(output = `ancestor=1\ndirty=0\ncommits=1\nhead=${"b".repeat(40)}\n`) {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n");
  const task = createTask(ctx, { brief: { goal: "preflight", repo: ctx.home }, kind: null,
    requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, record => { record.run = { dir: join(ctx.pacerHome, "runs", task.id),
    attempt: 1, executor: "codex", startedAt: ctx.now, mode: "new", workdir: "/remote/worktree",
    logFile: join(ctx.pacerHome, "tasks", "run.log"), host: "box", remoteWorktree: "/remote/worktree",
    baseSha: "a".repeat(40), remoteBranch: `pacer/${task.id}` }; });
  const grant = issuePersistedFetch(ctx, task.id, 1);
  const owner = createCallAuthority(ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  const calls: { method: string; params: any }[] = [];
  const broker = new HostLeaseBroker({ validate: () => {} });
  const provider = { id: "pacer-ssh", generation: "generation-1", process: {},
    invoke: async (method: string, params: any) => {
      calls.push({ method, params });
      if (method === "hostRunner.open") return { session: "s".repeat(32) };
      if (method === "hostRunner.close") return { ok: true };
      return { code: 0, stdout: output, stderr: "", timedOut: false };
    } };
  const snapshot = { alias: "box", sshTarget: "ssh-fixture", hostFingerprint: grant.resource.hostFingerprint,
    callerProcess: {}, callerGeneration: "caller-1", provider };
  return { ctx, grant, owner, broker, snapshot, calls, taskId: task.id };
}

test("host-owned preflight issues exact persisted tuple on the bound provider session", async () => {
  const f = fixture();
  try {
    const { session } = await f.broker.open(f.owner, f.snapshot);
    const receipt = await f.broker.preflight(f.owner, session, f.grant);
    expect(receipt.head).toBe("b".repeat(40));
    expect(receipt.commits).toBe(1);
    expect(f.calls.filter(call => call.method === "hostRunner.run")).toEqual([{
      method: "hostRunner.run", params: { session: "s".repeat(32), script: "PREFLIGHT",
        args: f.grant.resource.args, timeoutMs: expect.any(Number), maxBytes: 65_536 },
    }]);
    const binding = { ...f.snapshot, providerSession: "s".repeat(32), resource: f.grant.resource };
    expect(() => validateRemotePreflight(f.ctx, receipt, f.grant, binding)).not.toThrow();
    expect(() => validateRemotePreflight(f.ctx, structuredClone(receipt), f.grant, binding))
      .toThrow();
    expect(() => validateRemotePreflight(f.ctx, receipt, f.grant,
      { ...binding, providerSession: "x".repeat(32) })).toThrow();
    expect(() => validateRemotePreflight(f.ctx, receipt, f.grant,
      { ...binding, provider: { ...binding.provider, generation: "generation-2" } })).toThrow();
    await expect(f.broker.preflight(f.owner, session, f.grant)).rejects.toMatchObject({ code: "capability_denied" });
  } finally { await f.owner.revoke(); }
});

test("ordinary plugin hosts.run cannot request PREFLIGHT", async () => {
  const f = fixture();
  try {
    const { session } = await f.broker.open(f.owner, f.snapshot);
    await expect(f.broker.run(f.owner, { session, script: "PREFLIGHT", args: f.grant.resource.args,
      timeoutMs: 1000, maxBytes: 65_536 })).rejects.toMatchObject({ code: "capability_denied" });
    expect(f.calls.filter(call => call.method === "hostRunner.run")).toHaveLength(0);
  } finally { await f.owner.revoke(); }
});

test.each([
  `ancestor=1\ndirty=1\ncommits=1\nhead=${"b".repeat(40)}\n`,
  `ancestor=0\ndirty=0\ncommits=1\nhead=${"b".repeat(40)}\n`,
  `ancestor=1\ndirty=0\ncommits=501\nhead=${"b".repeat(40)}\n`,
  `ancestor=1\ndirty=0\ncommits=1\nhead=${"b".repeat(39)}\n`,
  `ancestor=1\ndirty=0\ndirty=1\ncommits=1\nhead=${"b".repeat(40)}\n`,
])("remote preflight rejects untrusted facts %#", async output => {
  const f = fixture(output);
  try {
    const { session } = await f.broker.open(f.owner, f.snapshot);
    await expect(f.broker.preflight(f.owner, session, f.grant)).rejects.toMatchObject({ code: "capability_denied" });
  } finally { await f.owner.revoke(); }
});

test("preflight refuses a different persisted run and task retirement before effect", async () => {
  const f = fixture();
  try {
    const { session } = await f.broker.open(f.owner, { ...f.snapshot, alias: "other" });
    await expect(f.broker.preflight(f.owner, session, f.grant)).rejects.toMatchObject({ code: "capability_denied" });
    expect(f.calls.filter(call => call.method === "hostRunner.run")).toHaveLength(0);
  } finally { await f.owner.revoke(); }
  const retired = fixture();
  try {
    const { session } = await retired.broker.open(retired.owner, retired.snapshot);
    updateTask(retired.ctx, retired.taskId, record => { record.run!.remoteWorktree = "/remote/replaced"; });
    await expect(retired.broker.preflight(retired.owner, session, retired.grant))
      .rejects.toMatchObject({ code: "capability_denied" });
    expect(retired.calls.filter(call => call.method === "hostRunner.run")).toHaveLength(0);
  } finally { await retired.owner.revoke(); }
});
