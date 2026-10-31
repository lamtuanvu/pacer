// test/plugin-sdk.test.ts
import { expect, test } from "bun:test";
import { PluginError, serve } from "@pacer/plugin";

function channel() {
  const queue: string[] = []; let wake: (() => void) | null = null; let closed = false;
  const input = { async *[Symbol.asyncIterator]() { for (;;) { while (queue.length) yield queue.shift()!; if (closed) return; await new Promise<void>(r => (wake = r)); } } };
  return { input, send: (o: unknown) => { queue.push(JSON.stringify(o)); wake?.(); }, close: () => { closed = true; wake?.(); } };
}
const manifest = { id: "fx", version: "1.0.0", publisher: "t", host: "^1", contributes: { diagnostic: {} } };
const hello = { jsonrpc: "2.0", id: 1, method: "plugin.hello", params: { protocol: "1.0.0", pacer: "0.0.0", manifest, config: {}, grants: [] } };
const waitFor = async (f: () => boolean, timeoutMs = 3000) => { const end = Date.now() + timeoutMs; while (!f()) { if (Date.now() > end) throw new Error("timeout"); await Bun.sleep(5); } };

test("handshake, built-in ping, handler errors and unknown methods", async () => {
  const ch = channel(), out: Record<string, unknown>[] = [];
  const done = serve({ manifest, input: ch.input, write: l => out.push(JSON.parse(l)), handlers: { "usage.read": () => { throw new PluginError("invalid_input", "no account"); } } });
  ch.send({ jsonrpc: "2.0", id: 2, method: "diagnostic.ping", params: {} });
  await waitFor(() => out.length >= 1);
  expect(out[0]).toMatchObject({ id: 2, error: { data: { code: "plugin_refused" } } });
  ch.send(hello);
  ch.send({ jsonrpc: "2.0", id: 3, method: "diagnostic.ping", params: {} });
  ch.send({ jsonrpc: "2.0", id: 4, method: "usage.read", params: {} });
  ch.send({ jsonrpc: "2.0", id: 5, method: "nope", params: {} });
  await waitFor(() => out.length >= 5);
  ch.close(); await done;
  const byId = (id: number) => out.find(o => o.id === id)!;
  expect(byId(1)).toMatchObject({ result: { protocol: "1.8.0", id: "fx", version: "1.0.0", contributes: ["diagnostic"] } });
  expect(byId(3)).toMatchObject({ result: { ok: true } });
  expect(byId(4)).toMatchObject({ error: { code: -32000, message: "no account", data: { code: "invalid_input" } } });
  expect(byId(5)).toMatchObject({ error: { code: -32601 } });
});

test("capability calls go to the host and cancel aborts a handler", async () => {
  const ch = channel(), out: Record<string, unknown>[] = [];
  let aborted = false;
  const done = serve({ manifest, input: ch.input, write: l => out.push(JSON.parse(l)), handlers: {
    "diagnostic.ping": async (_p, host, signal) => {
      const cfg = await host.config();
      await new Promise<void>(r => { const t = setTimeout(r, 2000); signal.addEventListener("abort", () => { clearTimeout(t); aborted = true; r(); }); });
      return { ok: true, uptimeS: 0, cfg };
    },
  } });
  ch.send(hello);
  ch.send({ jsonrpc: "2.0", id: 2, method: "diagnostic.ping", params: {} });
  await waitFor(() => out.some(o => o.method === "capability.config.get"));
  const req = out.find(o => o.method === "capability.config.get")!;
  expect(typeof req.id).toBe("string");
  ch.send({ jsonrpc: "2.0", id: req.id, result: { config: { region: "eu" } } });
  await Bun.sleep(20);
  ch.send({ jsonrpc: "2.0", method: "$/cancel", params: { id: 2 } });
  await waitFor(() => out.some(o => o.id === 2));
  ch.close(); await done;
  expect(aborted).toBe(true);
  expect(out.find(o => o.id === 2)).toMatchObject({ result: { ok: true, cfg: { region: "eu" } } });
});

test("owned stream duplex read times out when the host reply is lost", async () => {
  const ch = channel(), out: Record<string, unknown>[] = [];
  const done = serve({ manifest, input: ch.input, write: line => out.push(JSON.parse(line)), handlers: {
    "hostRunner.stream": async (_params, host) => {
      await host.call("capability.process.duplex.read", { handle: "owned", length: 1, timeoutMs: 1 });
      return { ok: true };
    },
  } });
  ch.send(hello);
  ch.send({ jsonrpc: "2.0", id: 2, method: "hostRunner.stream",
    params: { streamId: "28523696-dbe2-4750-8626-a8a1ec48e14a" }, _meta: { capabilityCall: "owned-call" } });
  await waitFor(() => out.some(row => row.method === "capability.process.duplex.read"));
  await waitFor(() => out.some(row => row.id === 2), 7000);
  const request = out.find(row => row.method === "capability.process.duplex.read")!;
  expect(out.find(row => row.id === 2)).toMatchObject({
    error: { data: { code: "plugin_timeout" } },
  });
  ch.send({ jsonrpc: "2.0", id: request.id, result: { base64: "", eof: false } });
  await Bun.sleep(10);
  expect(out.filter(row => row.id === 2)).toHaveLength(1);
  ch.close(); await done;
}, 10_000);
