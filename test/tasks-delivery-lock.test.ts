import { expect, spyOn, test } from "bun:test";
import { fakeCtx } from "./helpers";
import { preparationWorker } from "./task-preparation-worker-helper";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import { answerLiveTask } from "../src/core/tasks";
import * as input from "../src/session/send";
import { directBackend, type Backend } from "../src/exec/backend";
import { startServer } from "../src/serve/http";

for (const operation of ["answer", "send"] as const) {
  test(`${operation} rolls back refused delivery after foreign preparation without blocking health`, async () => {
    const ctx = fakeCtx();
    const task = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
    const previous = { by: "previous", at: ctx.now - 120 };
    updateTask(ctx, task.id, t => {
      t.state = "running";
      if (operation === "answer") {
        t.question = { text: "question", at: ctx.now };
        t.run = { dir: ctx.home } as NonNullable<typeof t.run>;
      } else {
        t.live = { backend: "fixture", worker: "worker", terminal: "terminal", executor: "codex", agent: "codex", since: ctx.now };
        t.driving = previous;
      }
    });
    const worker = preparationWorker(ctx, task.id);
    const available = spyOn(input, "directInputAvailable").mockReturnValue(true);
    const refuse = async () => {
      worker.send("prepare");
      expect((await worker.wait("held")).type).toBe("held");
      return { ok: false as const, code: "unavailable" as const, definite: true, message: "nothing typed" };
    };
    const delivery = spyOn(input, "sendDirectInput").mockImplementation(refuse);
    const backend: Backend = { ...directBackend, id: "fixture", live: { send: refuse, release: async () => {} } };
    const controller = new AbortController();
    const request = { ...ctx, operation: { signal: controller.signal } };
    const invoke = () => operation === "answer" ? answerLiveTask(request, task.id, "answer")
      : input.send(request, task.id, "text", { backends: [backend], by: "sender" });
    const server = startServer(() => ctx, { port: 0, listener: false, pumpMs: 0 });
    let settled = false;
    const pending = invoke().finally(() => { settled = true; });
    void pending.catch(() => {});
    try {
      expect((await worker.wait("held")).type).toBe("held");
      controller.abort(); // Required rollback outlives the requesting client's cancellation.
      await Bun.sleep(60);
      const started = performance.now();
      const health = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { Authorization: `Bearer ${server.token}` }, signal: AbortSignal.timeout(1000),
      });
      expect(health.status).toBe(200);
      expect(performance.now() - started).toBeLessThan(500);
      expect(settled).toBe(false);
      worker.send("release");
      expect((await worker.wait("done")).type).toBe("done");
      await expect(pending).rejects.toMatchObject({ code: "unavailable", message: "nothing typed" });
      const restored = readTask(ctx, task.id)!;
      expect(restored.kind).toBe("prepared");
      if (operation === "answer") {
        expect(restored.question).toEqual({ text: "question", at: ctx.now });
        delivery.mockResolvedValue({ ok: true });
      } else {
        expect(restored.driving).toEqual(previous);
        backend.live!.send = async () => ({ ok: true });
      }
      const retried = await invoke();
      if (operation === "answer") expect(retried.question?.answer).toBe("answer");
      else expect(retried.driving?.by).toBe("sender");
    } finally {
      worker.send("release");
      await pending.catch(() => {});
      worker.worker.terminate();
      delivery.mockRestore();
      available.mockRestore();
      await server.stop();
    }
  });
}
