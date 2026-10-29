// test/tasks-handover-service.test.ts
import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { handoverCandidates, triggerHandover, upgradeSummary } from "../src/tasks/handover-service";
import { runningWork, runningWorkLines, workCounts } from "../src/service/running-work";
import { processIdentity } from "../src/update/desktop/process-identity";
import { currentVersion } from "../src/update/version";
import type { RunnerHandover } from "../src/tasks/types";
import { fakeCtx, tmpDir } from "./helpers";

const V = currentVersion();
function running(ctx: ReturnType<typeof fakeCtx>, runnerPid: number, handover?: RunnerHandover, runnerPacer?: string) {
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: "cursor", timeoutS: 600 });
  return updateTask(ctx, t.id, x => {
    x.state = "running"; x.runnerPid = runnerPid; if (handover) x.handover = handover; if (runnerPacer) x.runnerPacer = runnerPacer;
    x.run = { dir: join(ctx.pacerHome, "runs", t.id, "1"), attempt: 1, executor: "cursor", startedAt: ctx.now, mode: "current", workdir: x.brief.repo, logFile: "/dev/null" };
  });
}
const advert = (pid: number, pacer = "0.10.0", extra: Partial<RunnerHandover> = {}): RunnerHandover => ({ protocol: 1, pacer, identity: { pid, bootId: "b", birth: "1" }, ...extra });

test("only advertised, older, same-protocol runners that still own their task are candidates", () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const eligible = running(ctx, 501, advert(501));
  running(ctx, 502);                                    // pre-feature runner: no advertisement
  running(ctx, 503, advert(503, V));                    // already current
  running(ctx, 504, { ...advert(504), protocol: 2 });   // unknown protocol
  running(ctx, 505, advert(999));                       // stale advertisement after a rollback
  running(ctx, 506, advert(506, "0.10.0", { state: "handed-over" }));
  expect(handoverCandidates(ctx).map(t => t.id)).toEqual([eligible.id]);
});

test("the trigger signals candidates, counts commits and reports older runners as kept", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const a = running(ctx, 601, advert(601), "0.10.0");
  running(ctx, 602, undefined, undefined);
  const signalled: number[] = [];
  const report = await triggerHandover(ctx, { pollMs: 5, signal: (identity, signal) => {
    expect(signal).toBe("SIGUSR2"); signalled.push(identity.pid);
    updateTask(ctx, a.id, x => { x.handover = { ...x.handover!, state: "handed-over", committedAt: Date.now() / 1000 }; delete x.runnerPid; });
    return true;
  } });
  expect(signalled).toEqual([601]);
  expect(report).toMatchObject({ pacer: V, tasks: 2, sessions: 0, handedOver: 1, keptOnPreviousRunner: 1 });
  expect(report.summary).toBe(`Updated to v${V}. 2 tasks and 0 sessions kept running; 1 stayed on the previous runner.`);
  expect(typeof readTask(ctx, a.id)?.handover?.signalledAt).toBe("number");
});

test("a declining runner ends the wait early and stays on its runner", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const a = running(ctx, 701, advert(701), "0.10.0");
  const started = Date.now();
  const report = await triggerHandover(ctx, { waitMs: 5000, pollMs: 5, signal: () => {
    updateTask(ctx, a.id, x => { x.handover!.declinedAt = Date.now() / 1000 + 1; });
    return true;
  } });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(report).toMatchObject({ handedOver: 0, keptOnPreviousRunner: 1 });
});

test("a silent runner is counted as kept after the wait bound", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  running(ctx, 801, advert(801), "0.10.0");
  const report = await triggerHandover(ctx, { waitMs: 100, pollMs: 10, signal: () => true });
  expect(report).toMatchObject({ handedOver: 0, keptOnPreviousRunner: 1 });
});

test("a reused PID is never signalled by the real signaller", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const child = Bun.spawn(["sleep", "30"]);
  for (let i = 0; i < 100 && !processIdentity(child.pid); i++) await Bun.sleep(20);
  try {
    const real = processIdentity(child.pid)!;
    running(ctx, child.pid, { protocol: 1, pacer: "0.10.0", identity: { ...real, birth: `${real.birth}7` } });
    await triggerHandover(ctx, { waitMs: 0 });
    await Bun.sleep(100);
    expect(child.exitCode).toBeNull();
  } finally { child.kill("SIGKILL"); await child.exited; }
});

test("running work carries versions and counts only, never paths", async () => {
  const ctx = fakeCtx({ now: Date.now() / 1000 });
  const old = running(ctx, 901, undefined, "0.10.0"), cur = running(ctx, 902, undefined, V);
  const work = await runningWork(ctx);
  expect(work.tasks).toEqual(expect.arrayContaining([{ taskId: old.id, runnerPacer: "0.10.0", older: true }, { taskId: cur.id, runnerPacer: V, older: false }]));
  expect(JSON.stringify(work)).not.toContain(ctx.pacerHome);
  expect(workCounts(work)).toEqual({ tasks: 2, sessions: 0, olderRunners: 1, olderSessions: 0, reopenToUpdate: 0 });
  expect(runningWorkLines(work)).toEqual(["running work: 2 tasks, 0 sessions", `  task ${old.id} on runner 0.10.0 (older)`]);
  expect(upgradeSummary("Restarted on v1.2.3.", { tasks: 1, sessions: 1, keptOnPreviousRunner: 0 })).toBe("Restarted on v1.2.3. 1 task and 1 session kept running; 0 stayed on the previous runner.");
});
