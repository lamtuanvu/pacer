import { createInterface } from "node:readline";
let serial = 0;
const pending = new Map<string, number>();
const send = (message: object) => console.log(JSON.stringify({ jsonrpc: "2.0", ...message }));
for await (const line of createInterface({ input: process.stdin })) {
  const message = JSON.parse(line);
  if (message.method === "plugin.hello") {
    send({ id: message.id, result: { protocol: "1.1.0", id: message.params.manifest.id, version: message.params.manifest.version, contributes: ["diagnostic", "usage"] } });
  } else if (message.method === "diagnostic.ping") {
    if (!message.params.hang) send({ id: message.id, result: { ok: true, uptimeS: 0 } });
  } else if (message.method === "usage.read") {
    const current = ++serial;
    if (message.params.provider === "suppress-spawn") {
      pending.set(`suppressed-${message.id}`, message.id);
      send({ id: `suppressed-${message.id}`, method: "capability.process.spawn", params: { argv: ["opencode", "stats", "--models", "--cost", "--json", "--days", "7"], timeoutMs: 2000 }, _meta: message._meta });
      continue;
    }
    const finish = () => send({ id: message.id, result: { windows: [], capturedAt: message.params.now, stale: false, serial: current, owned: message._meta?.capabilityCall ?? null } });
    if (message.params.provider === "slow") setTimeout(finish, 30); else finish();
  } else if (message.method === "fixture.error") {
    send({ id: message.id, error: { code: -32000, message: "fixture error", data: { code: message.params.code } } });
  } else if (message.method === "fixture.capability") {
    pending.set(`plugin-${message.id}`, message.id);
    send({ id: `plugin-${message.id}`, method: "capability.fs.read", params: { path: "/fixture" }, _meta: message._meta });
  } else if (message.method === "fixture.delay") {
    setTimeout(() => send({ id: message.id, result: { ok: true } }), 25);
  } else if (message.method === "fixture.progress") {
    send({ method: "$/progress", params: { id: message.id, event: { value: 7 } } });
    send({ id: message.id, result: { ok: true } });
    send({ method: "$/progress", params: { id: message.id, event: { value: 99 } } });
  } else if (!message.method && pending.has(message.id)) {
    const id = pending.get(message.id); pending.delete(message.id);
    send({ id, result: message.id.startsWith("suppressed-") ? { windows: [], capturedAt: 100, stale: false, suppressed: true } : message.result });
  }
}
