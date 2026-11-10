import { expect, test } from "bun:test";
import { fakeCtx } from "./install-plugin-fixtures";
import { eligibility } from "./fixtures/eligibility";
import { preparationWorker } from "./task-preparation-worker-helper";
import { createTask, readTask } from "../src/tasks/store";
import { runTask, type RunnerDeps } from "../src/tasks/runner";
import { validateStrategy } from "../src/config/strategy";
import { startServer } from "../src/serve/http";

for (const boundary of ["attempt", "result"] as const) {
  test(`runner ${boundary} commit waits for foreign preparation while health stays responsive`, async () => {
    const ctx = fakeCtx();
    const task = createTask(ctx, {
      brief: { goal: "g", repo: "/r" }, kind: null, requestedExecutor: "codex", timeoutS: 60,
    });
    const worker = preparationWorker(ctx, task.id);
    const hold = async () => {
      worker.send("prepare");
      expect((await worker.wait("held")).type).toBe("held");
    };
    const strategy = validateStrategy({ planner: "claude-code", providers: { "claude-code": {}, codex: {} } }, "/x");
    const deps: RunnerDeps = {
      loadStrategy: () => strategy,
      computeStatus: async () => ({
        generatedAt: 0, strategy: "default", planner: "claude-code", mode: "normal",
        disabled: false, paused: null, modeHold: null, calendarPace: true,
        providers: ["claude-code", "codex"].map(id => ({
          id, eligibility: eligibility(), usage: "quota", windows: [], binding: null,
          verdict: "ON_PACE", installed: true, stale: false,
        })),
        executors: { ranked: [], excluded: [] },
      }),
      runAttempt: async () => {
        if (boundary === "attempt") await hold();
        return {
          exec: { code: 0, stdout: "success", stderr: "", timedOut: false }, report: "success",
          attempt: { executor: "codex", model: null, startedAt: 1, endedAt: 2,
            exitCode: 0, timedOut: false, limitHit: false, log: "/l/codex.log" },
        };
      },
      verifyRepo: async () => ({ files: "a.ts | 2 +-" }),
      hooks: {
        guard: async () => null,
        taskKind: async () => null,
        filterExecutors: async (_ctx, _task, ids) => ids,
        resultCheck: async () => { if (boundary === "result") await hold(); return undefined; },
      },
    };
    const server = startServer(() => ctx, { port: 0, listener: false, pumpMs: 0 });
    let settled = false;
    const pending = runTask(ctx, task.id, deps).finally(() => { settled = true; });
    // Observe rejections immediately; the assertion below still awaits the outcome.
    void pending.catch(() => {});
    try {
      expect((await worker.wait("held")).type).toBe("held");
      await Bun.sleep(60);
      const start = performance.now();
      const health = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { Authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(1000),
      });
      expect(health.status).toBe(200);
      expect(performance.now() - start).toBeLessThan(500);
      expect(settled).toBe(false);
      expect(readTask(ctx, task.id)?.result).toBeUndefined();
      worker.send("release");
      expect((await worker.wait("done")).type).toBe("done");
      const result = await pending;
      expect(result.state).toBe("done");
      expect(result.result?.report.startsWith("success")).toBe(true);
      expect(readTask(ctx, task.id)?.result).toEqual(result.result);
      expect(readTask(ctx, task.id)?.attempts).toHaveLength(1);
      expect(readTask(ctx, task.id)?.kind).toBe("prepared");
    } finally {
      worker.send("release");
      await pending.catch(() => {});
      worker.worker.terminate();
      await server.stop();
    }
  });
}
