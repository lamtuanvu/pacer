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
