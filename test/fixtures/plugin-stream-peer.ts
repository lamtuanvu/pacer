import { createInterface } from "node:readline";

const send = (message: object) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
let original = 0;
let stream = "";
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line) as { id?: number | string; method?: string;
    params?: { streamId?: string; mode?: string }; _meta?: unknown; result?: unknown; error?: unknown };
  if (message.method !== "hostRunner.stream") {
    if (message.id === "ack") send({ id: original, result: { code: message.error ? 1 : 0, bytes: message.error ? 0 : 3 } });
    continue;
  }
  original = message.id as number;
  stream = message.params?.streamId ?? "";
  const event = { streamId: stream, seq: 0,
    base64: message.params?.mode === "bad-base64" ? "%%%" : Buffer.from("abc").toString("base64") };
  send({ method: "$/progress", params: { id: message.params?.mode === "wrong-id" ? original + 1 : original, event } });
  if (message.params?.mode === "double") send({ method: "$/progress", params: { id: original, event: { ...event, seq: 1 } } });
  if (message.params?.mode === "no-ack") continue;
  send({ id: "ack", method: "$/streamAck", params: { request: original, streamId: stream, seq: 0 },
    _meta: message.params?.mode === "wrong-token" ? { capabilityCall: "forged" } : message._meta });
}
