import { expect, test } from "bun:test";
import { serve } from "@pacer/plugin";

function channel() {
  const queue: string[] = []; let wake: (() => void) | undefined, closed = false;
  return {
    input: { async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length) yield queue.shift()!;
        if (closed) return;
        await new Promise<void>(resolve => { wake = resolve; });
      }
    } },
    send(value: unknown) { queue.push(JSON.stringify(value)); wake?.(); },
    close() { closed = true; wake?.(); },
  };
}
const manifest = { id: "fx-stream", version: "1.0.0", publisher: "test", host: "^1", contributes: { hostRunner: { kinds: ["ssh"] } } };

test("SDK stream progress waits for scoped acknowledgement and stays unavailable to ordinary calls", async () => {
  const ch = channel(), output: Record<string, any>[] = [];
  const streamId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  let ordinaryCanStream = true;
  const done = serve({ manifest, input: ch.input, write(line) { output.push(JSON.parse(line)); }, handlers: {
    "diagnostic.ping": (_params, host) => { ordinaryCanStream = host.streamProgress !== undefined; return { ok: true, uptimeS: 0 }; },
    "hostRunner.stream": async (_params, host) => {
      await host.streamProgress!(streamId, 0, Buffer.from("abc"));
      return { code: 0, bytes: 3 };
    },
  } });
  try {
    ch.send({ jsonrpc: "2.0", id: 1, method: "plugin.hello",
      params: { protocol: "1.5.0", pacer: "test", manifest, config: {}, grants: [] } });
    ch.send({ jsonrpc: "2.0", id: 2, method: "diagnostic.ping", params: {} });
    ch.send({ jsonrpc: "2.0", id: 3, method: "hostRunner.stream", params: { streamId },
      _meta: { capabilityCall: "owned-token" } });
    const until = Date.now() + 2000;
    while (!output.some(frame => frame.method === "$/streamAck") && Date.now() < until) await Bun.sleep(5);
    const progress = output.find(frame => frame.method === "$/progress")!;
    const ack = output.find(frame => frame.method === "$/streamAck")!;
    expect(progress).toMatchObject({ params: { id: 3, event: { streamId, seq: 0, base64: "YWJj" } } });
    expect(ack).toMatchObject({ params: { request: 3, streamId, seq: 0 }, _meta: { capabilityCall: "owned-token" } });
    expect(output.some(frame => frame.id === 3 && frame.result)).toBe(false);
    ch.send({ jsonrpc: "2.0", id: ack.id, result: { seq: 0 } });
    while (!output.some(frame => frame.id === 3 && frame.result) && Date.now() < until) await Bun.sleep(5);
    expect(output.find(frame => frame.id === 3)?.result).toEqual({ code: 0, bytes: 3 });
    expect(ordinaryCanStream).toBe(false);
  } finally { ch.close(); await done; }
});

test("SDK stream input is one owned frame and acknowledges only after provider work", async () => {
  const ch = channel(), output: Record<string, any>[] = [];
  const streamId = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
  let received = "";
  const done = serve({ manifest, input: ch.input, write(line) { output.push(JSON.parse(line)); }, handlers: {
    "hostRunner.stream": async (_params, host) => {
      const frame = await host.streamInput!.next();
      received = Buffer.from(frame.bytes).toString();
      await frame.ack();
      return { code: 0, bytes: frame.bytes.length };
    },
  } });
  try {
    ch.send({ jsonrpc: "2.0", id: 1, method: "plugin.hello",
      params: { protocol: "1.5.0", pacer: "test", manifest, config: {}, grants: [] } });
    ch.send({ jsonrpc: "2.0", id: 3, method: "hostRunner.stream", params: { streamId },
      _meta: { capabilityCall: "owned-token" } });
    ch.send({ jsonrpc: "2.0", method: "$/streamInput", params: { request: 3, streamId, seq: 0, base64: "YWJj" } });
    const until = Date.now() + 2000;
    while (!output.some(frame => frame.method === "$/streamInputAck") && Date.now() < until) await Bun.sleep(5);
    const ack = output.find(frame => frame.method === "$/streamInputAck")!;
    expect(received).toBe("abc");
    expect(ack).toMatchObject({ params: { request: 3, streamId, seq: 0 },
      _meta: { capabilityCall: "owned-token" } });
    expect(output.some(frame => frame.id === 3 && frame.result)).toBe(false);
    ch.send({ jsonrpc: "2.0", id: ack.id, result: { seq: 0 } });
    while (!output.some(frame => frame.id === 3 && frame.result) && Date.now() < until) await Bun.sleep(5);
    expect(output.find(frame => frame.id === 3)?.result).toEqual({ code: 0, bytes: 3 });
  } finally { ch.close(); await done; }
});
