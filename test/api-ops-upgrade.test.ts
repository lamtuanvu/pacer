// test/api-ops-upgrade.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { callOp } from "../src/api/ops";
import { assertCallerCanInvoke, UPGRADE_REFUSAL } from "../src/api/caller-policy";
import { recoverJobs, getJob } from "../src/jobs/registry";
import { startServer } from "../src/serve/http";
import { createTask, updateTask } from "../src/tasks/store";
import { registerWork, issueWorkGrant } from "../src/dispatch/work";
import { currentVersion } from "../src/update/version";
import { fakeCtx, tmpDir } from "./helpers";

const UPGRADE = ["update.apply", "service.install", "service.handover", "desktop.update.restart", "desktop.update.download", "desktop.update.adopt"];

test("executor sessions are refused upgrade operations by the caller policy and by callOp", async () => {
  const ctx = fakeCtx({ env: { PACER_ROLE: "executor" } });
  for (const name of UPGRADE) {
    expect(() => assertCallerCanInvoke(ctx, name, {})).toThrow(UPGRADE_REFUSAL);
    await expect(callOp(ctx, name, {})).rejects.toMatchObject({ code: "not_allowed", message: UPGRADE_REFUSAL });
  }
  expect(() => assertCallerCanInvoke(ctx, "desktop.update.status", {})).not.toThrow();
});

test("executor sessions are refused agent.undo, agent.connect and agent.disconnect (F6)", async () => {
  const ctx = fakeCtx({ env: { PACER_ROLE: "executor" } });
  for (const name of ["agent.undo", "agent.connect", "agent.disconnect"]) {
    expect(() => assertCallerCanInvoke(ctx, name, { agent: "codex" })).toThrow(/executor/);
    await expect(callOp(ctx, name, { agent: "codex" })).rejects.toMatchObject({ code: "not_allowed" });
  }
  expect(() => assertCallerCanInvoke(ctx, "agent.preview", { agent: "codex" })).not.toThrow();
});

test("service.handover and service.work answer an operator with versions and counts only", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.state = "running"; x.runnerPid = 4194302; x.runnerPacer = "0.10.0"; });
  const v = currentVersion();
  expect(await callOp(ctx, "service.handover", { wait_s: 0 })).toEqual({ pacer: v, tasks: 1, sessions: 0, handed_over: 0, kept_on_previous_runner: 1,
    summary: `Updated to v${v}. 1 task and 0 sessions kept running; 1 stayed on the previous runner.` });
  const work = await callOp(ctx, "service.work", {}) as { tasks: unknown[]; counts: unknown };
  expect(work.tasks).toEqual([{ task_id: t.id, runner_pacer: "0.10.0", older: true }]);
  expect(work.counts).toEqual({ tasks: 1, sessions: 0, older_runners: 1, older_sessions: 0, reopen_to_update: 0 });
  expect(JSON.stringify(work)).not.toContain(ctx.pacerHome);
  await expect(callOp(ctx, "service.handover", { wait_s: 61 })).rejects.toMatchObject({ code: "invalid_input" });
});

test("over HTTP a work-grant caller is refused and the bearer operator is allowed", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 }), repo = tmpDir();
  const own = createTask(ctx, { brief: { goal: "own", repo }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  registerWork(ctx, own.id, { allowDelegation: true }); updateTask(ctx, own.id, t => { t.state = "running"; });
  const grant = issueWorkGrant(ctx, own.id, 1), internal = "i".repeat(64);
  const server = startServer(() => ({ ...ctx, now: Date.now() / 1000 }), { port: 0, listener: false, pumpMs: 0, internal: { token: internal } });
  const base = `http://127.0.0.1:${server.port}`, host = `127.0.0.1:${server.port}`;
  try {
    for (const op of ["update.apply", "service.install", "service.handover"]) {
      const refused = await fetch(`${base}/v3/ops/${op}`, { method: "POST", headers: { authorization: `Bearer ${internal}`, "x-pacer-auth": "task", "x-pacer-work-grant": `Bearer ${grant}`, host }, body: "{}" });
      expect(refused.status).toBe(403);
    }
    const allowed = await fetch(`${base}/v3/ops/service.handover`, { method: "POST", headers: { authorization: `Bearer ${internal}`, host }, body: JSON.stringify({ wait_s: 0 }) });
    expect(allowed.status).toBe(200);
  } finally { await server.stop(); }
});

test("recovery completes a running update.apply only after the handover reports", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 }), dir = join(ctx.pacerHome, "state", "jobs");
  mkdirSync(dir, { recursive: true });
  const job = { id: "job-1", kind: "update.apply", target: "pacer", state: "running", startedAt: ctx.now, pid: 4194302, cancellable: false,
    steps: [{ name: "Download", state: "passed" }, { name: "Verify", state: "passed" }, { name: "Replace", state: "passed" }, { name: "Refresh integrations", state: "passed" }, { name: "Restart", state: "running", detail: currentVersion() }] };
  writeFileSync(join(dir, "job-1.json"), JSON.stringify(job));
  let finish!: (summary: string) => void;
  recoverJobs(ctx, undefined, () => new Promise(resolve => { finish = resolve; }));
  expect(getJob(ctx, "job-1").state).toBe("running");
  finish(`Updated to v${currentVersion()}. 1 task and 0 sessions kept running; 0 stayed on the previous runner.`);
  await Bun.sleep(10);
  const done = getJob(ctx, "job-1");
  expect(done.state).toBe("passed");
  expect(done.steps.at(-1)).toEqual({ name: "Restart", state: "passed", detail: `Updated to v${currentVersion()}. 1 task and 0 sessions kept running; 0 stayed on the previous runner.` });
});

test("recovery marks update.apply failed when handover rejects", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 }), dir = join(ctx.pacerHome, "state", "jobs");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "job-failed.json"), JSON.stringify({ id: "job-failed", kind: "update.apply", target: "pacer", state: "running", startedAt: ctx.now, pid: 4194302, cancellable: false,
    steps: [{ name: "Restart", state: "running", detail: currentVersion() }] }));
  recoverJobs(ctx, undefined, async () => { throw new Error("handover failed"); });
  await Bun.sleep(10);
  expect(getJob(ctx, "job-failed")).toMatchObject({ state: "failed", error: { message: expect.stringContaining("handover failed") }, steps: [{ name: "Restart", state: "failed" }] });
});

test("service.handover signals nothing while a desktop update can still roll back", async () => {
  const { readUpdate, writeUpdate } = await import("../src/update/desktop/store");
  const { desktopTransactionOpen } = await import("../src/update/desktop/store");
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.state = "running"; x.runnerPid = 4194302; x.runnerPacer = "0.10.0";
    x.handover = { protocol: 1, pacer: "0.10.0", identity: { pid: 4194302, bootId: "b", birth: "1:2" } }; });
  expect(desktopTransactionOpen(ctx)).toBe(false);
  mkdirSync(join(ctx.pacerHome, "desktop-updates"), { recursive: true, mode: 0o700 });
  const { requestRestart } = await import("../src/update/desktop/policy");
  const candidate = { version: "9.9.9", arch: "aarch64" as const, sha256: "a".repeat(64), signature: "s", url: "https://example.invalid/a", protocolMajors: [3], rollbackCompatible: true, notes: "" };
  const value = readUpdate(ctx, "desktop");
  const ready = writeUpdate(ctx, { ...value, phase: "ready", candidate, downloadedBytes: 10, totalBytes: 10, checkedAt: 100 }, value.revision);
  const waiting = requestRestart(ready, { installationId: "desktop", requestId: "r", expectRevision: ready.revision, version: candidate.version, clientId: "native-desktop" }, "boot-1");
  writeUpdate(ctx, { ...waiting, phase: "verifying" }, ready.revision);
  expect(desktopTransactionOpen(ctx)).toBe(true);
  const reply = await callOp(ctx, "service.handover", { wait_s: 0 }) as { deferred?: boolean; handed_over: number };
  expect(reply).toMatchObject({ deferred: true, handed_over: 0, tasks: 1 });
  // Nothing was signalled: the advertisement carries no signal time.
  const { readTask } = await import("../src/tasks/store");
  expect(readTask(ctx, t.id)?.handover?.signalledAt).toBeUndefined();
  // An uncertain handoff can still be restored by an independent recovery helper and keeps the
  // reservation: it defers too.
  const verifying = readUpdate(ctx, "desktop");
  const uncertain = writeUpdate(ctx, { ...verifying, phase: "recovery-failed", error: { code: "handoff_uncertain", message: "Desktop update requires transaction recovery" } }, verifying.revision);
  expect(desktopTransactionOpen(ctx)).toBe(true);
  expect(await callOp(ctx, "service.handover", { wait_s: 0 })).toMatchObject({ deferred: true, handed_over: 0 });
  expect(readTask(ctx, t.id)?.handover?.signalledAt).toBeUndefined();
  // A finished transaction no longer defers.
  writeUpdate(ctx, { ...uncertain, phase: "complete", error: null, requestId: null, requestedBy: null, requesterBootId: null }, uncertain.revision);
  expect(desktopTransactionOpen(ctx)).toBe(false);
});

test("concurrent handovers in one service share a single run", async () => {
  const { sharedHandover } = await import("../src/tasks/handover-service");
  let starts = 0, finish!: () => void;
  const start = () => { starts++; return new Promise<any>(resolve => { finish = () => resolve({ summary: "ok" }); }); };
  const first = sharedHandover(start), second = sharedHandover(start);
  finish();
  expect(await first).toEqual(await second);
  expect(starts).toBe(1);
  await sharedHandover(async () => { starts++; return { summary: "again" } as any; });
  expect(starts).toBe(2);
  // One log line per run, naming its origin; a joined caller logs nothing.
  const lines: string[] = [];
  let finishLogged!: () => void;
  const logged = sharedHandover(() => new Promise<any>(resolve => { finishLogged = () => resolve({ summary: "Updated.", signalled: 2 }); }), "commit", line => lines.push(line));
  const joined = sharedHandover(async () => ({ summary: "never" } as any), "request", line => lines.push(line));
  finishLogged(); await logged; await joined;
  expect(lines).toEqual(["pacer: handover (commit): signalled=2; Updated."]);
  await expect(sharedHandover(async () => { throw Error("boom"); }, "request", line => lines.push(line))).rejects.toThrow("boom");
  expect(lines.at(-1)).toBe("pacer: handover (request) failed: boom");
});

test("service.handover also defers while an admission reservation is held", async () => {
  const { reserveIdle, releaseReservation, admissionReserved } = await import("../src/update/desktop/admission");
  const { readTask } = await import("../src/tasks/store");
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  expect(admissionReserved(ctx)).toBe(false);
  // Reserve while idle (the record phase is already complete in this window), then record running work.
  expect((await reserveIdle(ctx, "tx-r7")).reserved).toBe(true);
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.state = "running"; x.runnerPid = 4194302; x.runnerPacer = "0.10.0";
    x.handover = { protocol: 1, pacer: "0.10.0", identity: { pid: 4194302, bootId: "b", birth: "1:2" } }; });
  expect(admissionReserved(ctx)).toBe(true);
  expect(await callOp(ctx, "service.handover", { wait_s: 0 })).toMatchObject({ deferred: true, handed_over: 0 });
  expect(readTask(ctx, t.id)?.handover?.signalledAt).toBeUndefined();
  await releaseReservation(ctx, "tx-r7");
  expect(admissionReserved(ctx)).toBe(false);
  expect((await callOp(ctx, "service.handover", { wait_s: 0 }) as { deferred?: boolean }).deferred).toBeUndefined();
});

test("service.handover also defers while a reconciliation fence holds a transaction", async () => {
  const { admissionReserved } = await import("../src/update/desktop/admission");
  const { readFence, reserveFence, releaseFence } = await import("../src/update/desktop/reconciliation-fence");
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const fence = reserveFence(ctx, readFence(ctx).epoch, "reconcile-1");
  expect(admissionReserved(ctx)).toBe(true);
  expect(await callOp(ctx, "service.handover", { wait_s: 0 })).toMatchObject({ deferred: true, handed_over: 0 });
  releaseFence(ctx, fence);
  expect(admissionReserved(ctx)).toBe(false);
});
