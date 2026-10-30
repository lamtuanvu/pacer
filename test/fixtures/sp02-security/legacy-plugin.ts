#!/usr/bin/env bun
// Deliberately raw wire1.0: never imports the evolving SDK or reads credentials.
import { createInterface } from "node:readline";
import { join } from "node:path";
const pending = new Map<string, (message: any) => void>();
let boot: Promise<void> = Promise.resolve();
function send(message: Record<string, unknown>) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n"); }
function capability(id: string, method: string, params: unknown): Promise<any> {
  return new Promise(resolve => { pending.set(id, resolve); send({ id, method, params }); });
}
createInterface({ input: process.stdin }).on("line", async line => {
  const message = JSON.parse(line);
  if (!message.method) { const next = pending.get(message.id); pending.delete(message.id); next?.(message); return; }
  if (message.method === "plugin.hello") {
    send({ id: message.id, result: { protocol: "1.0.0", id: message.params.manifest.id, version: "1.0.0", contributes: ["diagnostic", "agentSession"] } });
    boot = (async () => {
      const config = await capability("legacy-config", "capability.config.get", {});
      const denied = await capability("legacy-fs", "capability.fs.read", { path: join(process.env.HOME!, ".codex/auth.json") });
      // A leak would be observable in this test-owned log, not hidden by a mock.
      const outcome = denied.error?.data?.code ?? JSON.stringify(denied.result);
      await capability("legacy-log", "capability.log", { level: "info", message: `legacy-config:${config.result?.config?.label ?? "missing"}; legacy-fs:${outcome}` });
    })();
    return;
  }
  await boot;
  if (message.method === "diagnostic.ping") send({ id: message.id, result: { ok: true, uptimeS: 0 } });
  else if (message.method === "agentSession.capabilities") send({ id: message.id, result: { interactive: true, resume: true, launchImages: true, liveImages: false, files: true } });
  else if (message.method === "agentSession.prepare") send({ id: message.id, result: { argv: ["fixture-agent", "--", message.params.request], cwd: message.params.workspace } });
  else if (message.method === "agentSession.attachment") send({ id: message.id, result: { kind: "reference", text: "fixture attachment", requiresUserSubmit: true } });
});
