import { afterEach, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { runDir } from "../src/exec/direct";
import { startRun, stopRun } from "../src/supervisor/run";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import * as drain from "../src/tasks/drain";
import { advertiseHandover, commitHandoverIfRequested, installHandoverHandler, registerRunnerLease, resetHandoverState, withAttemptWork } from "../src/tasks/handover";
import { beginWorkSync, claimWorkSync, reserveIdle } from "../src/update/desktop/admission";
import { registerWork, issueWorkGrant, authorizeWorkGrant } from "../src/dispatch/work";
import { issueEnforcementToken, authorizeEnforcementToken } from "../src/dispatch/enforcement-token";
import type { RunRef } from "../src/tasks/types";
import { fakeCtx, tmpDir } from "./helpers";

class Exited extends Error { constructor(readonly code: number) { super(`exit ${code}`); } }
const exit = (code: number): never => { throw new Exited(code); };
afterEach(() => resetHandoverState());

async function eligibleRunner() {
  const ctx = fakeCtx({ now: Date.now() / 1000 }), repo = tmpDir();
  const t = createTask(ctx, { brief: { goal: "g", repo }, kind: null, requestedExecutor: "cursor", timeoutS: 600 });
  registerWork(ctx, t.id, { allowDelegation: true });
  const dir = runDir(ctx, t.id, 1), startedAt = Date.now() / 1000;
  startRun({ dir, argv: ["sh", "-c", "sleep 30"], cwd: repo, env: { PATH: process.env.PATH } });
  const run: RunRef = { dir, attempt: 1, executor: "cursor", startedAt, mode: "current", workdir: repo, logFile: join(ctx.pacerHome, "tasks", `${t.id}.cursor.log`) };
  updateTask(ctx, t.id, x => { x.state = "running"; x.runnerPid = process.pid; x.executor = "cursor"; x.attemptStartedAt = startedAt; x.run = run; });
  const lease = beginWorkSync(ctx, { kind: "task", id: t.id, label: `Task ${t.id}` });
  claimWorkSync(ctx, lease); registerRunnerLease(lease);
  const token = issueEnforcementToken(ctx, t.id, 1), grant = issueWorkGrant(ctx, t.id, 1);
  installHandoverHandler();
  return { ctx, id: t.id, run, token, grant };
}
async function request(ctx: Parameters<typeof advertiseHandover>[0], id: string, run: RunRef) {
  expect(advertiseHandover(ctx, id, run)).toBe(true);
  process.kill(process.pid, "SIGUSR2");
  await Bun.sleep(50);
}
const ownLeases = async (ctx: Parameters<typeof reserveIdle>[0], id: string) =>
  (await reserveIdle(ctx, "tx-handover-check")).blockers.filter(b => b.label === "Executor attempt" || b.label === `Task ${id}`);

test("commit finishes the runner's leases, keeps t.run, revokes nothing, drains nothing and exits 0 without an outcome", async () => {
  const { ctx, id, run, token, grant } = await eligibleRunner();
  const drained = spyOn(drain, "drainQueue");
  let code: number | undefined;
  try {
    await withAttemptWork(ctx, id, async () => {
      await request(ctx, id, run);
      try { commitHandoverIfRequested(ctx, id, run, exit); } catch (e) { if (e instanceof Exited) code = e.code; else throw e; }
    });
    expect(code).toBe(0);
    const t = readTask(ctx, id)!;
    expect(t.state).toBe("running");
    expect(t.handover).toMatchObject({ state: "handed-over" });
    expect(typeof t.handover?.committedAt).toBe("number");
    expect(t.runnerPid).toBeUndefined();
    expect(t.run?.dir).toBe(run.dir);
    expect(t.attempts).toHaveLength(0);
    expect(t.result).toBeUndefined();
    expect(await ownLeases(ctx, id)).toEqual([]);
    const blockers = (await reserveIdle(ctx, "tx-handover-check")).blockers;
    expect(blockers.some(b => b.kind === "session")).toBe(true);
    expect(() => authorizeEnforcementToken(ctx, token)).not.toThrow();
    expect(() => authorizeWorkGrant(ctx, grant)).not.toThrow();
    expect(drained).not.toHaveBeenCalled();
  } finally { drained.mockRestore(); await stopRun(run.dir, { graceMs: 100 }); }
});

test("a stop that races the signal makes the runner decline and keep its leases", async () => {
  const { ctx, id, run } = await eligibleRunner();
  try {
    await withAttemptWork(ctx, id, async () => {
      await request(ctx, id, run);
      updateTask(ctx, id, x => { x.state = "stopped"; });
      expect(commitHandoverIfRequested(ctx, id, run, exit)).toBe("declined");
      expect(readTask(ctx, id)?.handover?.state).toBeUndefined();
      expect(typeof readTask(ctx, id)?.handover?.declinedAt).toBe("number");
      expect((await ownLeases(ctx, id)).map(b => b.label).sort()).toEqual(["Executor attempt", `Task ${id}`]);
    });
  } finally { await stopRun(run.dir, { graceMs: 100 }); }
});

test("a changed t.run makes the runner decline", async () => {
  const { ctx, id, run } = await eligibleRunner();
  try {
    await withAttemptWork(ctx, id, async () => {
      await request(ctx, id, run);
      updateTask(ctx, id, x => { x.run = { ...x.run!, dir: `${run.dir}-other` }; });
      expect(commitHandoverIfRequested(ctx, id, run, exit)).toBe("declined");
      expect(readTask(ctx, id)?.runnerPid).toBe(process.pid);
    });
  } finally { await stopRun(run.dir, { graceMs: 100 }); }
});

test("without a request the poll boundary does nothing", async () => {
  const { ctx, id, run } = await eligibleRunner();
  try {
    expect(advertiseHandover(ctx, id, run)).toBe(true);
    expect(commitHandoverIfRequested(ctx, id, run, exit)).toBe("none");
  } finally { await stopRun(run.dir, { graceMs: 100 }); }
});
