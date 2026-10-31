import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCallAuthority, type CallAuthority } from "../src/plugins/authority";
import { CoreError } from "../src/core/errors";
import { HostLeaseBroker, type HostLeaseProvider } from "../src/plugins/host-lease";
import { issuePersistedFetch } from "../src/plugins/fetch-issuer";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

const owners: CallAuthority[] = [];
afterEach(async () => { await Promise.allSettled(owners.splice(0).map(owner => owner.revoke())); });

async function fixture(timeoutMs = 1000, onValidate?: () => void | Promise<void>) {
  const ctx = fakeCtx();
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "strategy.yaml"),
    "planner: claude-code\nproviders: {claude-code: {}}\nhosts:\n  box:\n    ssh: ssh-fixture\n");
  const task = createTask(ctx, { brief: { goal: "fetch", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, task.id, record => { record.run = { dir: join(ctx.pacerHome, "runs", task.id),
    attempt: 1, executor: "codex", startedAt: ctx.now, mode: "new", workdir: "/remote/worktree",
    logFile: join(ctx.pacerHome, "tasks", "run.log"), host: "box", remoteWorktree: "/remote/worktree",
    baseSha: "a".repeat(40), remoteBranch: `pacer/${task.id}` }; });
  const grant = issuePersistedFetch(ctx, task.id, 1, 16, timeoutMs);
  const caller = createCallAuthority(ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  const foreign = createCallAuthority(ctx, { reads: [], commands: [], stores: [] },
    { deadlineMs: Date.now() + 5000, grants: ["hosts"] });
  owners.push(caller, foreign);
  const callerProcess = {}, providerProcess = {};
  const calls: string[] = [];
  const provider: HostLeaseProvider = { id: "fx-ssh", generation: "one", process: providerProcess,
    invoke: async method => { calls.push(method); return method === "hostRunner.open"
      ? { session: "provider-private-handle" } : { ok: true }; } };
  let valid = true;
  const broker = new HostLeaseBroker({ validate: async () => {
    if (!valid) throw Error("generation retired");
    await onValidate?.();
  } });
  const { session } = await broker.open(caller, { alias: "box", sshTarget: "ssh-fixture",
    hostFingerprint: grant.resource.hostFingerprint, callerProcess, callerGeneration: "one", provider });
  return { ctx, task, grant, caller, foreign, broker, session, providerProcess, calls,
    retireProvider: () => { valid = false; } };
}

const result = { handle: "123e4567-e89b-42d3-a456-426614174000", bytes: 3, sha256: "a".repeat(64) };

test("broker fetch binds the owner, provider session and one-use persisted grant", async () => {
  const f = await fixture();
  expect(typeof (f.broker as any).fetch).toBe("function");
  let effects = 0;
  const effect = async (binding: any) => {
    effects++;
    expect(binding.providerSession).toBe("provider-private-handle");
    expect(binding.provider.process).toBe(f.providerProcess);
    expect(binding.resource.argv).toEqual(f.grant.resource.argv);
    return result;
  };
  await expect((f.broker as any).fetch(f.foreign, f.session, f.grant, effect, () => {}))
    .rejects.toMatchObject({ code: "capability_denied" });
  expect(effects).toBe(0);
  await expect((f.broker as any).fetch(f.caller, f.session, structuredClone(f.grant), effect, () => {}))
    .rejects.toMatchObject({ code: "capability_denied" });
  expect(await (f.broker as any).fetch(f.caller, f.session, f.grant, effect, () => {})).toEqual(result);
  await expect((f.broker as any).fetch(f.caller, f.session, f.grant, effect, () => {}))
    .rejects.toMatchObject({ code: "capability_denied" });
  expect(effects).toBe(1);
  expect(f.calls).toEqual(["hostRunner.open"]);
});

test("broker fetch refuses retired provider before invoking host effect", async () => {
  const f = await fixture();
  f.retireProvider();
  let effects = 0;
  await expect((f.broker as any).fetch(f.caller, f.session, f.grant, async () => { effects++; return result; }, () => {}))
    .rejects.toBeDefined();
  expect(effects).toBe(0);
});

test("broker permits one in-flight fetch and refuses concurrent or replayed effects", async () => {
  const f = await fixture();
  const second = issuePersistedFetch(f.ctx, f.task.id, 1, 16, 1000);
  let entered!: () => void, finish!: (value: typeof result) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = f.broker.fetch(f.caller, f.session, f.grant,
    async () => { entered(); return new Promise(resolve => { finish = resolve; }); }, () => {});
  await started;
  await expect(f.broker.fetch(f.caller, f.session, second, async () => result, () => {}))
    .rejects.toMatchObject({ code: "conflict" });
  finish(result);
  await expect(pending).resolves.toEqual(result);
  await expect(f.broker.fetch(f.caller, f.session, second, async () => result, () => {}))
    .rejects.toMatchObject({ code: "capability_denied" });
});

test("caller cancellation rejects fetch and discards a late opaque result", async () => {
  const f = await fixture();
  let entered!: () => void, finish!: (value: typeof result) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let effectSignal: AbortSignal | undefined;
  const discarded: typeof result[] = [];
  const pending = f.broker.fetch(f.caller, f.session, f.grant,
    async (_binding, signal) => { effectSignal = signal; entered(); return new Promise(resolve => { finish = resolve; }); },
    value => { discarded.push(value); });
  void pending.catch(() => {});
  await started;
  const revoked = f.caller.revoke();
  expect(effectSignal!.aborted).toBe(true);
  finish(result);
  await expect(pending).rejects.toMatchObject({ code: "capability_denied" });
  await revoked;
  expect(discarded).toEqual([result]);
  expect(f.calls).toEqual(["hostRunner.open", "hostRunner.close"]);
});

test("provider generation retirement during fetch aborts the effect and discards late output", async () => {
  const f = await fixture();
  let entered!: () => void, finish!: (value: typeof result) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let effectSignal: AbortSignal | undefined;
  const discarded: typeof result[] = [];
  const pending = f.broker.fetch(f.caller, f.session, f.grant,
    async (_binding, signal) => { effectSignal = signal; entered(); return new Promise(resolve => { finish = resolve; }); },
    value => { discarded.push(value); });
  void pending.catch(() => {});
  await started;
  f.retireProvider();
  const until = Date.now() + 500;
  while (!effectSignal!.aborted && Date.now() < until) await Bun.sleep(10);
  expect(effectSignal!.aborted).toBe(true);
  finish(result);
  await expect(pending).rejects.toBeDefined();
  expect(discarded).toEqual([result]);
});

test("close waits for an in-flight fetch before retiring the provider session", async () => {
  const f = await fixture();
  let entered!: () => void, finish!: (value: typeof result) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = f.broker.fetch(f.caller, f.session, f.grant,
    async () => { entered(); return new Promise(resolve => { finish = resolve; }); }, () => {});
  await started;
  const closing = f.broker.close(f.caller, { session: f.session });
  await Bun.sleep(0);
  expect(f.calls).toEqual(["hostRunner.open"]);
  finish(result);
  await expect(pending).resolves.toEqual(result);
  await expect(closing).resolves.toEqual({ ok: true });
  expect(f.calls).toEqual(["hostRunner.open", "hostRunner.close"]);
});

test("fetch deadline aborts the effect and discards its late result", async () => {
  const f = await fixture(50);
  let entered!: () => void, finish!: (value: typeof result) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let effectSignal: AbortSignal | undefined, deadlineAt = 0;
  const discarded: typeof result[] = [];
  const pending = f.broker.fetch(f.caller, f.session, f.grant,
    async (_binding, signal, deadline) => { effectSignal = signal; deadlineAt = deadline;
      entered(); return new Promise(resolve => { finish = resolve; }); },
    value => { discarded.push(value); });
  void pending.catch(() => {});
  await started;
  expect(deadlineAt).toBeLessThanOrEqual(Date.now() + 50);
  const until = Date.now() + 500;
  while (!effectSignal!.aborted && Date.now() < until) await Bun.sleep(5);
  expect(effectSignal!.aborted).toBe(true);
  finish(result);
  await expect(pending).rejects.toMatchObject({ code: "plugin_timeout" });
  expect(discarded).toEqual([result]);
});

test("fetch reports its own expiry when a nested cancellation wins a delayed timer", async () => {
  const f = await fixture(20);
  const pending = f.broker.fetch(f.caller, f.session, f.grant,
    async () => {
      // Simulate a busy event loop: nested transport rejection reaches the
      // broker after its absolute deadline but before its timer callback.
      const until = Date.now() + 30;
      while (Date.now() < until) { /* intentional bounded delay */ }
      throw new CoreError("plugin_unavailable", "owning plugin call ended");
    }, () => {});
  await expect(pending).rejects.toMatchObject({ code: "plugin_timeout", message: "host fetch expired" });
});

test("fetch preserves a nested cancellation before its own deadline", async () => {
  const f = await fixture(1000);
  await expect(f.broker.fetch(f.caller, f.session, f.grant,
    async () => { throw new CoreError("plugin_unavailable", "owning plugin call ended"); }, () => {}))
    .rejects.toMatchObject({ code: "plugin_unavailable", message: "owning plugin call ended" });
});

test("fetch discards a result when validation finishes after its deadline", async () => {
  let delayValidation = false;
  const f = await fixture(25, async () => {
    if (delayValidation) await Bun.sleep(80);
  });
  const discarded: typeof result[] = [];
  const started = Date.now();
  await expect(f.broker.fetch(f.caller, f.session, f.grant,
    async () => { delayValidation = true; return result; },
    value => { discarded.push(value); }))
    .rejects.toMatchObject({ code: "plugin_timeout" });
  expect(Date.now() - started).toBeGreaterThanOrEqual(25);
  expect(discarded).toEqual([result]);
  expect(f.calls).toEqual(["hostRunner.open", "hostRunner.close"]);
});

test("late-result discard failure remains visible to the owner", async () => {
  const f = await fixture();
  let entered!: () => void, finish!: (value: typeof result) => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = f.broker.fetch(f.caller, f.session, f.grant,
    async () => { entered(); return new Promise(resolve => { finish = resolve; }); },
    () => { throw Error("discard failed"); });
  void pending.catch(() => {});
  await started;
  const revoked = f.caller.revoke();
  void revoked.catch(() => {});
  finish(result);
  await expect(pending).rejects.toMatchObject({ code: "plugin_unavailable" });
  await expect(revoked).rejects.toMatchObject({ code: "plugin_unavailable" });
});
