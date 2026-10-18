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
  expect(byId(1)).toMatchObject({ jsonrpc: "2.0", result: { protocol: "2.9.0" } });
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
  await publish(ctx, [{ v: 1, type: "alert", data: { key: "k", level: "info", title: "t", body: "", at: ctx.now } }], { bridge: false, channel: false });
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
  expect(out.find((o) => o.id === 1)).toMatchObject({ result: { protocol: "2.9.0", seq: 0 } });
  expect(out.find((o) => o.id === 2)).toMatchObject({ result: { subscribed: true, last: 0 } });
  const count = out.length;
  await publish(ctx, [{ v: 1, type: "alert", data: { key: "k", level: "info", title: "t", body: "", at: ctx.now } }], { bridge: false, channel: false });
  await Bun.sleep(60);
  expect(out).toHaveLength(count);
});
