import { expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startJob, getJob, listJobs, cancelJob, recoverJobs, registerJobDaemon, type Job } from "../src/jobs/registry";
import { callOp } from "../src/api/ops";
import { fakeCtx } from "./helpers";

test("in-process jobs finish all steps and report changes", async () => {
  const ctx = fakeCtx(), changes: Job[] = [];
  const job = await startJob(ctx, "runner.check", "codex", ["a", "b"], async step => {
    step.start("a"); step.pass("a"); step.start("b"); step.pass("b", "ok");
  }, { onChange: job => { changes.push(job); } });
  expect(job.state).toBe("passed");
  expect(job.steps.map(s => s.state)).toEqual(["passed", "passed"]);
  expect(changes[0]?.state).toBe("running");
  expect(changes.at(-1)?.state).toBe("passed");
  expect(await callOp(ctx, "job.get", { id: job.id })).toEqual(job);
  expect(await callOp(ctx, "job.list", { target: "other" })).toEqual([]);
});

test("exceptions fail the active step and skip later steps", async () => {
  const job = await startJob(fakeCtx(), "runner.check", "codex", ["a", "b"], async step => {
    step.start("a"); throw Error("broken");
  });
  expect(job.state).toBe("failed");
  expect(job.error?.message).toBe("broken");
  expect(job.steps.map(s => s.state)).toEqual(["failed", "skipped"]);
});

test("concurrent callers share a running job even with separate contexts", async () => {
  const ctx = fakeCtx(); let release!: () => void, runs = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const first = startJob(ctx, "host.check", "dev", ["check"], async step => { runs++; step.start("check"); await gate; step.pass("check"); });
  // Wait until the callback is running, without waiting for it to finish.
  while (!runs) await Bun.sleep(1);
  const second = await startJob({ ...ctx }, "host.check", "dev", [], async () => { runs++; });
  expect(second.state).toBe("running");
  release();
  expect((await first).id).toBe(second.id);
  expect(runs).toBe(1);
});

test("daemon jobs return immediately and cancellation aborts supported work", async () => {
  const ctx = fakeCtx(), unregister = registerJobDaemon(ctx);
  try {
    let aborted!: Promise<void>;
    const job = await startJob(ctx, "host.check", "dev", ["check"], async step => {
      step.start("check");
      aborted = new Promise(resolve => step.signal.addEventListener("abort", () => resolve(), { once: true }));
      await aborted;
    }, { cancellable: true });
    expect(job.state).toBe("running");
    expect(await callOp(ctx, "job.cancel", { id: job.id })).toMatchObject({ state: "cancelled" });
    await aborted;
    expect(getJob(ctx, job.id).state).toBe("cancelled");
    const fixed = await startJob(ctx, "update.apply", "pacer", [], async () => {});
    expect(() => cancelJob(ctx, fixed.id)).toThrow("not cancellable");
  } finally { unregister(); }
});

test("recovery fails orphan jobs and list removes completed jobs after 24 hours", async () => {
  const ctx = fakeCtx();
  const job = await startJob(ctx, "host.check", "dev", ["a", "b"], async step => { step.pass("a"); step.pass("b"); });
  const file = join(ctx.pacerHome, "state/jobs", `${job.id}.json`);
  writeFileSync(file, JSON.stringify({ ...job, state: "running", pid: 2147483647 }));
  recoverJobs(ctx);
  expect(getJob(ctx, job.id)).toMatchObject({ state: "failed", error: { message: "pacer restarted while this was running" } });
  expect(listJobs({ ...ctx, now: ctx.now + 86401 })).toEqual([]);
  expect(existsSync(file)).toBe(false);
});

test("job ids cannot escape the store", () => {
  expect(() => getJob(fakeCtx(), "../../token")).toThrow();
});

test("concurrent creation is locked and cancellation notifies the starting observer", async () => {
  const ctx = fakeCtx(), unregister = registerJobDaemon(ctx), states: string[] = [];
  let runs = 0;
  const run = async (step: import("../src/jobs/registry").StepApi) => {
    runs++;
    await new Promise<void>(resolve => step.signal.addEventListener("abort", () => resolve(), { once: true }));
  };
  try {
    const [a, b] = await Promise.all([
      startJob(ctx, "host.check", "dev", [], run, { cancellable: true, onChange: job => { states.push(job.state); } }),
      startJob({ ...ctx }, "host.check", "dev", [], run, { cancellable: true }),
    ]);
    expect(a.id).toBe(b.id); expect(runs).toBe(1);
    cancelJob(ctx, a.id);
    expect(states).toContain("cancelled");
  } finally { unregister(); }
});
