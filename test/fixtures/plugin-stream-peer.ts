import { createInterface } from "node:readline";
import { writeFileSync } from "node:fs";

const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let original = 0;
let stream = "";
let metadata: unknown;
let mode = "";
let handle = "";
let readyFile = "";
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as { id?: number | string; method?: string;
    params?: { streamId?: string; mode?: string; argv?: string[]; readyFile?: string; request?: number; seq?: number; base64?: string };
    _meta?: unknown; result?: unknown; error?: unknown };
  if (message.method === "$/streamInput") {
    const frame = message.params as { request: number; streamId: string; seq: number; base64: string };
    if (mode === "input-no-ack") continue;
    if (mode === "input" && handle) {
      send({ id: "write", method: "capability.process.duplex.write",
        params: { handle, base64: frame.base64, timeoutMs: 1000 }, _meta: metadata });
      continue;
    }
    send({ id: "input-ack", method: "$/streamInputAck",
      params: { request: frame.request, streamId: frame.streamId, seq: frame.seq },
      _meta: mode === "input-wrong-token" ? { capabilityCall: "forged" } : metadata });
    continue;
  }
  if (message.method !== "hostRunner.stream") {
    if (message.id === "open") { handle = (message.result as { handle?: string } | undefined)?.handle ?? "";
      if (handle && readyFile) writeFileSync(readyFile, "ready");
      continue; }
    if (message.id === "write") {
      send({ id: "input-ack", method: "$/streamInputAck",
        params: { request: original, streamId: stream, seq: 0 }, _meta: metadata });
      continue;
    }
    if (message.id === "ack") send({ id: original, result: { code: message.error ? 1 : 0, bytes: message.error ? 0 : 3 } });
    if (message.id === "input-ack") send({ id: original, result: { code: message.error ? 1 : 0, bytes: message.error ? 0 : 3 } });
    continue;
  }
  original = message.id as number;
  stream = message.params?.streamId ?? "";
  metadata = message._meta;
  mode = message.params?.mode ?? "";
  readyFile = message.params?.readyFile ?? "";
  if (mode === "input" && message.params?.argv) {
    send({ id: "open", method: "capability.process.duplex.open",
      params: { argv: message.params.argv, timeoutMs: 1000 }, _meta: metadata });
    continue;
  }
  if (mode.startsWith("input")) continue;
  const event = { streamId: stream, seq: 0,
    base64: message.params?.mode === "bad-base64" ? "%%%" : Buffer.from("abc").toString("base64") };
  send({ method: "$/progress", params: { id: message.params?.mode === "wrong-id" ? original + 1 : original, event } });
  if (message.params?.mode === "double") send({ method: "$/progress", params: { id: original, event: { ...event, seq: 1 } } });
  if (message.params?.mode === "no-ack") continue;
  send({ id: "ack", method: "$/streamAck", params: { request: original, streamId: stream, seq: 0 },
    _meta: message.params?.mode === "wrong-token" ? { capabilityCall: "forged" } : message._meta });
}
