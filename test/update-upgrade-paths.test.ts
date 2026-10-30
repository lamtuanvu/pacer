// test/update-upgrade-paths.test.ts
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { restartAroundWork, type UpgradeDeps } from "../src/service/upgrade";
import { serviceCli } from "../src/service/cli";
import { main } from "../src/cli";
import { createTask, updateTask } from "../src/tasks/store";
import { fakeCtx, tmpDir } from "./helpers";

type Call = { op: string; body: unknown; auth: string | null };
function ctxWith(running: boolean) {
  const ctx = fakeCtx({ now: Date.now() / 1000, env: { PACER_PORT: "49999" } });
  mkdirSync(ctx.pacerHome, { recursive: true }); writeFileSync(join(ctx.pacerHome, "token"), "tok\n");
  if (running) { const t = createTask(ctx, { brief: { goal: "g", repo: tmpDir() }, kind: null, requestedExecutor: null, timeoutS: 60 }); updateTask(ctx, t.id, x => { x.state = "running"; x.runnerPacer = "0.13.0"; }); }
  return ctx;
}
function stub(routes: Record<string, unknown>, calls: Call[]): UpgradeDeps {
  return { sleep: async () => {}, healthTimeoutMs: 50, fetch: (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/health")) {
      calls.push({ op: "health", body: null, auth: new Headers(init?.headers).get("authorization") });
      return Response.json({ ok: true, pid: 12345 }, { headers: { "X-Pacer": "1" } });
    }
    const op = url.split("/v3/ops/")[1]!;
    calls.push({ op, body: JSON.parse(String(init?.body ?? "{}")), auth: new Headers(init?.headers).get("authorization") });
    const result = routes[op];
    return result === undefined || result instanceof Error
      ? Response.json({ error: { code: "unknown_op", message: result instanceof Error ? result.message : `unknown operation "${op}"` } }, { status: 404 })
      : Response.json({ result });
  }) as UpgradeDeps["fetch"] };
}

test("work is read before the restart, then the healthy new service hands it over and reports", async () => {
  const ctx = ctxWith(true), calls: Call[] = [];
  const deps = { ...stub({ "version.get": { pacer: "0.13.1" }, "service.handover": { pacer: "0.13.1", tasks: 1, sessions: 0, handed_over: 1, kept_on_previous_runner: 0, summary: "ignored" } }, calls), expectedPid: 12345 };
  const r = await restartAroundWork(ctx, async () => { expect(calls).toHaveLength(0); return true; }, { expectedVersion: "0.13.1", prefix: v => `Updated to v${v}.`, deps });
  expect(r).toEqual({ restarted: true, summary: "Updated to v0.13.1. 1 task and 0 sessions kept running; 0 stayed on the previous runner." });
  expect(calls.map(c => c.op)).toEqual(["health", "version.get", "service.handover"]);
  expect(calls[0].auth).toBeNull();
  expect(calls[2]).toMatchObject({ body: { wait_s: 60 }, auth: "Bearer tok" });
});

test("with nothing running no service call is made", async () => {
  const calls: Call[] = [];
  const r = await restartAroundWork(ctxWith(false), async () => true, { expectedVersion: "0.13.1", prefix: v => `Updated to v${v}.`, deps: stub({}, calls) });
  expect(r.summary).toBe("Updated to v0.13.1. 0 tasks and 0 sessions kept running; 0 stayed on the previous runner.");
  expect(calls).toEqual([]);
});

test("a failed health check or an older service leaves work on its runners with a warning", async () => {
  const unhealthy = await restartAroundWork(ctxWith(true), async () => true, { expectedVersion: "0.13.1", prefix: v => `Updated to v${v}.`, deps: { ...stub({ "version.get": { pacer: "0.13.0" } }, []), expectedPid: 12345 } });
  expect(unhealthy).toEqual({ restarted: true, summary: null, warning: "the restarted service did not pass its health check; running work stays on its current runners" });
  const older = await restartAroundWork(ctxWith(true), async () => true, { prefix: v => `Updated to v${v}.`, deps: { ...stub({ "version.get": { pacer: "0.13.0" } }, []), expectedPid: 12345 } });
  expect(older.summary).toBeNull();
  expect(older.warning).toStartWith("running work was not handed over: ");
  expect(await restartAroundWork(ctxWith(true), async () => false, { prefix: v => v, deps: stub({}, []) })).toEqual({ restarted: false, summary: null });
});

test("an unverified health responder never receives the operator token", async () => {
  const calls: Call[] = [];
  const deps = stub({ "version.get": { pacer: "0.13.1" } }, calls);
  deps.fetch = async (url, init) => {
    calls.push({ op: url, body: null, auth: new Headers(init?.headers).get("authorization") });
    return Response.json({ ok: true, pid: 12345 });
  };
  const result = await restartAroundWork(ctxWith(true), async () => true, { expectedVersion: "0.13.1", prefix: v => v, deps });
  expect(result.warning).toContain("health check");
  expect(calls.every(call => call.auth === null)).toBe(true);
});

test("a health pid that differs from the service manager never receives the token", async () => {
  const calls: Call[] = [];
  const deps = { ...stub({ "version.get": { pacer: "0.13.1" } }, calls), expectedPid: 99999 };
  const result = await restartAroundWork(ctxWith(true), async () => true, { expectedVersion: "0.13.1", prefix: v => v, deps });
  expect(result.warning).toContain("health check");
  expect(calls.every(call => call.auth === null)).toBe(true);
});

test("a healthy responder receives no token while the manager reports no process", async () => {
  const calls: Call[] = [];
  const deps = { ...stub({ "version.get": { pacer: "0.13.1" } }, calls), expectedPid: null };
  const result = await restartAroundWork(ctxWith(true), async () => true, { expectedVersion: "0.13.1", prefix: v => v, deps });
  expect(result.warning).toContain("health check");
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every(call => call.op === "health" && call.auth === null)).toBe(true);
});

test("the token guard polls until the manager reports the health process", async () => {
  const calls: Call[] = [];
  let managerPid: number | null = null;
  const deps = {
    ...stub({ "version.get": { pacer: "0.13.1" }, "service.handover": { pacer: "0.13.1", tasks: 1, sessions: 0, handed_over: 1, kept_on_previous_runner: 0, summary: "ok" } }, calls),
    get expectedPid() { return managerPid; },
    sleep: async () => { managerPid = 12345; },
  };
  const result = await restartAroundWork(ctxWith(true), async () => true, { expectedVersion: "0.13.1", prefix: v => v, deps });
  expect(result.warning).toBeUndefined();
  expect(calls.map(call => call.op)).toEqual(["health", "health", "version.get", "service.handover"]);
  expect(calls.slice(0, 2).every(call => call.auth === null)).toBe(true);
});

test("delegated tasks cannot update, install, restart or uninstall the service", async () => {
  const ctx = fakeCtx({ env: { PACER_ROLE: "executor", PACER_RELEASE_BASE: pathToFileURL(tmpDir()).href } });
  expect(await main(["update"], ctx)).toMatchObject({ code: 2, err: "pacer update: upgrades are not allowed from a delegated task" });
  expect((await main(["update", "--check"], ctx)).err).not.toContain("delegated task");
  for (const cmd of ["install", "restart", "uninstall"]) {
    expect(await serviceCli([cmd], ctx, { platform: "darwin", uid: 501, argv: ["/opt/pacer"] })).toEqual({ code: 2, out: "", err: "pacer service: upgrades are not allowed from a delegated task" });
  }
  expect((await serviceCli(["status", "--json"], ctx, { platform: "darwin", uid: 501, argv: ["/opt/pacer"], fetch: async () => new Response("", { status: 503 }) })).code).toBe(0);
});
