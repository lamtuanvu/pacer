// test/service-upgrade-restart.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { restartAroundWork, isCoreRestartingError, type UpgradeDeps } from "../src/service/upgrade";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

function ctxWithRunningWork() {
  const ctx = fakeCtx({ now: Date.now() / 1000, env: { PACER_PORT: "49999" } });
  mkdirSync(ctx.pacerHome, { recursive: true });
  writeFileSync(join(ctx.pacerHome, "token"), "tok\n");
  const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 });
  updateTask(ctx, t.id, x => { x.state = "running"; x.runnerPacer = "0.13.0"; });
  return ctx;
}

type HandoverReply = () => Response;
function depsFor(handover: HandoverReply, calls: string[], o: { timeoutMs?: number; plainText?: boolean } = {}): UpgradeDeps {
  let attempts = 0;
  return {
    sleep: async () => {},
    healthTimeoutMs: 50,
    handoverTimeoutMs: o.timeoutMs ?? 5000,
    expectedPid: 12345,
    fetch: (async (url: string, _init?: RequestInit) => {
      if (url.endsWith("/health")) return Response.json({ ok: true, pid: 12345 }, { headers: { "X-Pacer": "1" } });
      const op = url.split("/v3/ops/")[1]!;
      calls.push(op);
      if (op === "version.get") return Response.json({ result: { pacer: "0.13.1" } });
      if (op === "service.handover") { attempts++; return handover(); }
      return Response.json({ error: { message: `unknown operation "${op}"` } }, { status: 404 });
    }) as UpgradeDeps["fetch"],
  };
}
const restartRefusal = () => Response.json({ error: { code: "unavailable", message: "pacer core is restarting" } }, { status: 503 });
const handoverOk = () => Response.json({ result: { pacer: "0.13.1", tasks: 1, sessions: 0, handed_over: 1, kept_on_previous_runner: 0, summary: "ok" } });

test("a core that refuses handover a few times while restarting still gets the handover", async () => {
  const ctx = ctxWithRunningWork(), calls: string[] = [];
  let attempts = 0;
  const deps = depsFor(() => ++attempts <= 3 ? restartRefusal() : handoverOk(), calls);
  const r = await restartAroundWork(ctx, async () => true, { expectedVersion: "0.13.1", prefix: v => `Updated to v${v}.`, deps });
  expect(r.warning).toBeUndefined();
  expect(r.summary).toBe("Updated to v0.13.1. 1 task and 0 sessions kept running; 0 stayed on the previous runner.");
  expect(attempts).toBe(4);
  expect(calls).toEqual(["version.get", "service.handover", "service.handover", "service.handover", "service.handover"]);
});

test("a plain-text front-door restarting refusal is retried too", async () => {
  const ctx = ctxWithRunningWork(), calls: string[] = [];
  let attempts = 0;
  const deps = depsFor(() => ++attempts <= 2 ? new Response("pacer core is restarting\n", { status: 502 }) : handoverOk(), calls);
  const r = await restartAroundWork(ctx, async () => true, { expectedVersion: "0.13.1", prefix: v => `Updated to v${v}.`, deps });
  expect(r.summary).not.toBeNull();
  expect(attempts).toBe(3);
});

test("other handover errors are never retried and keep their warning", async () => {
  const ctx = ctxWithRunningWork(), calls: string[] = [];
  let attempts = 0;
  const deps = depsFor(() => { attempts++; return Response.json({ error: { code: "invalid_input", message: "bad handover params" } }, { status: 400 }); }, calls);
  const r = await restartAroundWork(ctx, async () => true, { expectedVersion: "0.13.1", prefix: v => `Updated to v${v}.`, deps });
  expect(attempts).toBe(1);
  expect(r.summary).toBeNull();
  expect(r.warning).toBe("running work was not handed over: bad handover params");
});

test("a restarting refusal that outlives the deadline keeps the existing warning", async () => {
  const ctx = ctxWithRunningWork(), calls: string[] = [];
  const deps = depsFor(restartRefusal, calls, { timeoutMs: 40 });
  const r = await restartAroundWork(ctx, async () => true, { expectedVersion: "0.13.1", prefix: v => `Updated to v${v}.`, deps });
  expect(calls.filter(op => op === "service.handover").length).toBeGreaterThan(1);
  expect(r.summary).toBeNull();
  expect(r.warning).toBe("running work was not handed over: pacer core is restarting");
});

test("the restarting refusal is matched only for the core-starting message", () => {
  expect(isCoreRestartingError(new Error("pacer core is restarting"))).toBe(true);
  expect(isCoreRestartingError(new Error("Unexpected token 'p', \"pacer core is restarting\\n\" is not valid JSON"))).toBe(true);
  expect(isCoreRestartingError(new Error("handover failed"))).toBe(false);
  expect(isCoreRestartingError("pacer core is restarting")).toBe(false);
});
