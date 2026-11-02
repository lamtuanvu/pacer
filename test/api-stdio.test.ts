import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { runStdio } from "../src/api/stdio";
import { publish } from "../src/link/publish";
import { createTask } from "../src/tasks/store";
import { fakeCtx } from "./helpers";

function channel() {
  const queue: string[] = []; let wake: (() => void) | null = null; let closed = false;
  const input = { async *[Symbol.asyncIterator]() { for (;;) { while (queue.length) yield queue.shift()!; if (closed) return; await new Promise<void>((r) => (wake = r)); } } };
  return { input, send: (o: unknown) => { queue.push(typeof o === "string" ? o : JSON.stringify(o)); wake?.(); }, close: () => { closed = true; wake?.(); } };
}
async function setup() {
  const ctx = fakeCtx(); mkdirSync(ctx.pacerHome, { recursive: true });
  await Bun.write(join(ctx.pacerHome, "strategy.yaml"), "planner: claude-code\nproviders:\n  claude-code: {}\n  codex: {}\n");
  const out: Record<string, unknown>[] = [], ch = channel();
  const done = runStdio(ctx, ch.input, (l) => out.push(JSON.parse(l)), { pollMs: 20 });
  return { ctx, out, ch, done };
}
const waitFor = async (f: () => boolean) => { const end = Date.now() + 3000; while (!f()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(10); } };

test("hello, ops and errors as JSON-RPC 2.0", async () => {
  const { out, ch, done } = await setup();
  ch.send({ jsonrpc: "2.0", id: 1, method: "hello" });
  ch.send({ jsonrpc: "2.0", id: 2, method: "task.get", params: { id: "missing" } });
  ch.send({ jsonrpc: "2.0", id: 3, method: "nope" });
  ch.send("{bad");
  await waitFor(() => out.length >= 4);
  ch.close(); await done;
  const byId = (id: unknown) => out.find((o) => o.id === id)!;
  expect(byId(1)).toMatchObject({ jsonrpc: "2.0", result: { protocol: "2.8.0" } });
  expect(byId(2)).toMatchObject({ error: { code: -32000, data: { code: "unknown_task" } } });
  expect(byId(3)).toMatchObject({ error: { code: -32601 } });
  expect(byId(null)).toMatchObject({ error: { code: -32700 } });
});

test("concurrent requests answer by id", async () => {
  const { ctx, out, ch, done } = await setup();
  const t = createTask(ctx, { brief: { goal: "g", repo: ctx.home }, kind: null, requestedExecutor: null, timeoutS: 60 });
  ch.send({ jsonrpc: "2.0", id: "slow", method: "task.wait", params: { id: t.id, timeout_s: 1 } });
  ch.send({ jsonrpc: "2.0", id: "fast", method: "task.get", params: { id: t.id } });
  await waitFor(() => out.some((o) => o.id === "fast"));
  expect(out.some((o) => o.id === "slow")).toBe(false);
  await waitFor(() => out.some((o) => o.id === "slow"));
  ch.close(); await done;
});

test("subscribe streams events as notifications", async () => {
  const { ctx, out, ch, done } = await setup();
  ch.send({ jsonrpc: "2.0", id: 1, method: "subscribe", params: { since: 0 } });
  await waitFor(() => out.some((o) => o.id === 1));
  await publish(ctx, [{ type: "alert", data: { key: "k", level: "info", title: "t", body: "", at: ctx.now } }]);
  await waitFor(() => out.some((o) => o.method === "event"));
  ch.close(); await done;
  expect(out.find((o) => o.method === "event")).toMatchObject({ params: { type: "alert" } });
});

test("invalid params use -32602 and notifications receive no reply", async () => {
  const { out, ch, done } = await setup();
  ch.send({ jsonrpc: "2.0", method: "hello" });
  ch.send({ jsonrpc: "2.0", method: "task.get", params: { id: "missing" } });
  ch.send({ jsonrpc: "2.0", id: 1, method: "task.get", params: { id: 5 } });
  ch.send({ jsonrpc: "2.0", id: 2, method: "subscribe", params: { since: -1 } });
  ch.close(); await done;
  expect(out).toHaveLength(2);
  for (const response of out) expect(response).toMatchObject({ error: { code: -32602, data: { code: "invalid_input" } } });
});

test("EOF drains pending requests and stops subscription polling", async () => {
  const { ctx, out, ch, done } = await setup();
  ch.send({ jsonrpc: "2.0", id: 1, method: "snapshot" });
  ch.send({ jsonrpc: "2.0", id: 2, method: "subscribe" });
  ch.close(); await done;
  expect(out.find((o) => o.id === 1)).toMatchObject({ result: { protocol: "2.8.0", seq: 0 } });
  expect(out.find((o) => o.id === 2)).toMatchObject({ result: { subscribed: true, last: 0 } });
  const count = out.length;
  await publish(ctx, [{ type: "alert", data: { key: "k", level: "info", title: "t", body: "", at: ctx.now } }]);
  await Bun.sleep(60);
  expect(out).toHaveLength(count);
});

test("private native edit hook refuses missing, incorrect and work-scoped credentials", async () => {
  for (const env of [{}, {PACER_NATIVE_CONFIG_SYNC_KEY:"fixture-private-key"}, {PACER_NATIVE_CONFIG_SYNC_KEY:"fixture-private-key",PACER_WORK_GRANT:"fixture-grant"}]) {
    const ctx=fakeCtx({env});
    const params={key:env.PACER_WORK_GRANT?"fixture-private-key":"incorrect"};
    async function* input(){yield JSON.stringify({jsonrpc:"2.0",id:1,method:"_internal.native-config.finish",params:{...params,op:"runner.set"}});}
    const out: unknown[]=[];
    await runStdio(ctx,input(),line=>out.push(JSON.parse(line)),{nativeConfigKey:env.PACER_NATIVE_CONFIG_SYNC_KEY});
    expect(out).toMatchObject([{id:1,error:{code:-32601,data:{code:"unknown_op"}}}]);
    expect(JSON.stringify(out)).not.toContain("fixture-private-key");
  }
});

test("private native edit hook rejects generic synchronization and unsupported operations", async () => {
  const ctx = fakeCtx({env: {PACER_NATIVE_CONFIG_SYNC_KEY: "fixture-private-key"}});
  const requests = [
    {method: "_internal.config.sync", params: {key: "fixture-private-key"}},
    ...[undefined, "notifications.set", "strategy.use", "plugin.doctor", "nope"].map(op => ({
      method: "_internal.native-config.finish", params: {key: "fixture-private-key", op},
    })),
  ];
  async function* input() {
    for (const [id, request] of requests.entries()) yield JSON.stringify({jsonrpc: "2.0", id, ...request});
  }
  const out: unknown[] = [];
  await runStdio(ctx, input(), line => out.push(JSON.parse(line)), {nativeConfigKey: "fixture-private-key"});
  expect(out).toHaveLength(requests.length);
  for (const reply of out) expect(reply).toMatchObject({error: {code: -32601, data: {code: "unknown_op"}}});
});

test("ordinary stdio has no native hook even if context contains a bridge key", async () => {
  const ctx = fakeCtx({env: {PACER_NATIVE_CONFIG_SYNC_KEY: "fixture-private-key"}});
  async function* input() {
    yield JSON.stringify({jsonrpc: "2.0", id: 1, method: "_internal.native-config.finish", params: {key: "fixture-private-key", op: "runner.set"}});
  }
  const out: unknown[] = [];
  await runStdio(ctx, input(), line => out.push(JSON.parse(line)));
  expect(out).toMatchObject([{error: {code: -32601, data: {code: "unknown_op"}}}]);
});
