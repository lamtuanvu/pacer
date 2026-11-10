import { expect, test } from "bun:test";
import { runStdio } from "../src/api/stdio";
import { taskSendBridge } from "../src/api/task-send-bridge";
import { issueWorkGrant, registerWork } from "../src/dispatch/work";
import { startServer } from "../src/serve/http";
import { createTask, readTask, updateTask } from "../src/tasks/store";
import type { Ctx } from "../src/types";
import { fakeCtx, tmpDir } from "./helpers";
import { fakeRun, raw } from "./fixtures/orca/fake";
import { closedPort, pinnedEnv } from "./pinned-port";

const KEY = "fixture-private-key";
const TOKEN = "i".repeat(64);
const TERMINAL = "term_a225e7a8-0e55-4cb9-8e30-be7da4952e5d";
const SEND = ["orca", "terminal", "send"];
/** Core's own client calls from these tests reach this closed port, never the real service on 4317. */
const PORT = await closedPort();

/**
 * A running delegating root holding a valid work grant, and a live child in its scope that a send would type into.
 * The grant is real, so a refusal comes from the bridge's policy and not from a malformed token.
 */
function setup() {
  const f = fakeRun([
    [["orca", "orchestration", "worker-show"], raw(JSON.stringify({ ok: true, result: { worker: { state: "running" } } }))],
    [["orca", "terminal", "show"], raw(JSON.stringify({ ok: true, result: { terminal: { handle: TERMINAL, incarnationId: "inc-1", connected: true, writable: true, agentIdentity: "codex" } } }))],
    [SEND, raw(JSON.stringify({ ok: true, result: {} }))],
  ]);
  const ctx = fakeCtx({ run: f.run, env: pinnedEnv({}, PORT) });
  const root = createTask(ctx, { brief: { goal: "root", repo: tmpDir() }, kind: "feature", requestedExecutor: null, timeoutS: 600 });
  registerWork(ctx, root.id, { allowDelegation: true });
  updateTask(ctx, root.id, t => { t.state = "running"; });
  const child = createTask(ctx, { brief: { goal: "child", repo: root.brief.repo }, kind: "debug", requestedExecutor: "codex", timeoutS: 600 });
  registerWork(ctx, child.id, {}, root.id);
  updateTask(ctx, child.id, t => {
    t.state = "running";
    t.interactionMode = "conversation";
    t.live = { backend: "orca", worker: "ctx_live", terminal: TERMINAL, executor: "codex", agent: "codex", incarnation: "inc-1", since: 1 };
  });
  const grant = issueWorkGrant(ctx, root.id, 1);
  const granted: Ctx = { ...ctx, env: pinnedEnv({ ...ctx.env, PACER_ROLE: "executor", PACER_WORK_GRANT: grant }, PORT) };
  const request = { kind: "send", id: child.id, text: "go with plan B", force: false, by: "client:app" };
  return { f, ctx, granted, grant, child: child.id, request, record: readTask(ctx, child.id) };
}

test("the bridge refuses a work-grant caller before any effect", async () => {
  const { f, ctx, granted, child, request, record } = setup();
  await expect(taskSendBridge(granted, request)).rejects.toMatchObject({ code: "not_allowed", message: "Operation is not allowed by this work grant" });
  const forged = { ...ctx, env: pinnedEnv({ ...ctx.env, PACER_WORK_GRANT: "pwg_forged" }, PORT) };
  await expect(taskSendBridge(forged, request)).rejects.toMatchObject({ code: "not_allowed", message: "Invalid work grant" });
  expect(f.calls).toEqual([]);
  expect(readTask(ctx, child)).toEqual(record);
});

test("the stdio bridge refuses a missing or incorrect synchronization key and a work-grant caller", async () => {
  const { f, ctx, granted, child, request, record } = setup();
  const exchange = async (caller: Ctx, params: unknown, key: string | null = KEY) => {
    async function* input() { yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "_internal.task-send", params }); }
    const out: unknown[] = [];
    await runStdio(caller, input(), line => out.push(JSON.parse(line)), { nativeConfigKey: key ?? undefined });
    return out;
  };
  const refused = [
    await exchange(ctx, { key: "incorrect", request }),
    await exchange(ctx, { request }),
    await exchange(ctx, { key: KEY, request }, null),
    await exchange(granted, { key: KEY, request }),
  ];
  for (const out of refused) {
    expect(out).toMatchObject([{ id: 1, error: { code: -32601, data: { code: "unknown_op" } } }]);
    expect(JSON.stringify(out)).not.toContain(KEY);
  }
  expect(f.calls).toEqual([]);
  expect(readTask(ctx, child)).toEqual(record);

  expect(await exchange(ctx, { key: KEY, request })).toMatchObject([{ id: 1, result: { id: child, driving: { by: "client:app" } } }]);
  expect(f.count(SEND)).toBe(1);
});

test("the HTTP bridge accepts only the internal bearer, and refuses a work-grant caller", async () => {
  const { f, ctx, granted, grant, child, request, record } = setup();
  const post = async (caller: Ctx, headers: Record<string, string>) => {
    const s = startServer(() => caller, { port: 0, pumpMs: 0, internal: { token: TOKEN } });
    try {
      const reply = await fetch(`http://127.0.0.1:${s.port}/_internal/task-send`, {
        method: "POST", headers: { host: `127.0.0.1:${s.port}`, "content-type": "application/json", ...headers }, body: JSON.stringify({ request }),
      });
      return { status: reply.status, body: await reply.text() };
    } finally { s.stop(); }
  };
  const internal = { authorization: `Bearer ${TOKEN}` };
  expect((await post(ctx, { authorization: `Bearer ${"x".repeat(64)}` })).status).toBe(401);
  expect((await post(ctx, { ...internal, "x-pacer-auth": "task", "x-pacer-work-grant": `Bearer ${grant}` })).status).toBe(403);
  expect((await post(ctx, { ...internal, "x-pacer-auth": "cookie" })).status).toBe(403);
  const underGrant = await post(granted, internal);
  expect(underGrant.status).toBe(403);
  expect(JSON.parse(underGrant.body)).toMatchObject({ error: { code: "not_allowed", message: "Operation is not allowed by this work grant" } });
  expect(f.calls).toEqual([]);
  expect(readTask(ctx, child)).toEqual(record);

  const delivered = await post(ctx, internal);
  expect(delivered.status).toBe(200);
  expect(JSON.parse(delivered.body)).toMatchObject({ result: { id: child, driving: { by: "client:app" } } });
  expect(f.count(SEND)).toBe(1);
});
