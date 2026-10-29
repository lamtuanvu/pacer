import { createInterface } from "node:readline";
const send = (m: object) => console.log(JSON.stringify({ jsonrpc: "2.0", ...m }));
const pending = new Map<string, { request: number; bytes: number; mode: string; meta: unknown }>();
for await (const line of createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  if (m.method === "plugin.hello") send({ id: m.id, result: { protocol: m.params.protocol, id: m.params.manifest.id, version: m.params.manifest.version, contributes: ["usage"], features: ["chunkedResults"] } });
  else if (m.method === "usage.read") {
    if (m.params.mode === "ordinary") { send({ id: m.id, result: { windows: [], capturedAt: 100, stale: false } }); continue; }
    const value = Buffer.from(m.params.mode === "partial" ? '{"windows":[' : JSON.stringify({ windows: [], capturedAt: 100, stale: false }));
    const id = `chunk-${m.id}`;
    pending.set(id, { request: m.id, bytes: value.length, mode: m.params.mode, meta: m._meta });
    send({ id, method: "$/resultChunk", params: { request: m.id, offset: m.params.mode === "out-of-order" ? 3 : 0, base64: m.params.mode.startsWith("malformed") ? "not base64" : value.toString("base64") },
      _meta: m.params.mode === "wrong-token" ? { capabilityCall: "forged-token" } : m._meta });
    if (m.params.mode === "racing") send({ id: m.id, result: { windows: [], capturedAt: 100, stale: false, marker: "ordinary-before-chunk-ack" } });
  } else if (pending.has(m.id)) {
    const p = pending.get(m.id)!; pending.delete(m.id);
    if (p.mode === "malformed-caught") {
      send({ id: p.request, result: { windows: [], capturedAt: 100, stale: false } });
    } else if (p.mode === "hold") {
      setTimeout(() => {
        send({ id: `late-${p.request}`, method: "$/resultChunk", params: { request: p.request, offset: p.bytes, base64: "eA==" }, _meta: p.meta });
        send({ id: p.request, result: { _chunkedResult: { bytes: p.bytes + 1 } } });
      }, 80);
    } else send({ id: p.request, result: { _chunkedResult: { bytes: p.bytes } } });
  }
}
