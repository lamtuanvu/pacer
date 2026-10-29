import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PluginRegistry } from "../../../src/plugins/registry";
import { CAPABILITY_METHODS } from "../../../src/plugins/protocol";
import { fakeCtx, cleanupTestTmp } from "../../helpers";
// This timeout override is isolated in its own process; no shared suite schema mutation.
CAPABILITY_METHODS["capability.process.spawn"]!.deadlineMs = 25;
const ctx = fakeCtx(), executable = join(ctx.home, "owned-provider"), marker = join(ctx.home, "owned-pid");
writeFileSync(executable, `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid)); setInterval(()=>{},10);\n`, { mode: 0o700 });
ctx.which = () => executable;
const manifest = { id: "budget-fixture", version: "0.2.0", publisher: "test", host: "^1.5", contributes: { usage: {} },
  capabilities: [{ name: "process.spawn" as const, scopes: ["opencode"] }], reentrant: false, tier: "free" as const };
const registry = new PluginRegistry({ bundled: [{ manifest, main: async () => ({ handlers: {} }) }],
  spawnBundled: c => ({ argv: [process.execPath, join(import.meta.dir, "peer.ts")], cwd: c.home, env: {} }) });
let code = "success", elapsed = 0, alive = false;
try {
  const started = Date.now();
  try {
    await registry.call(ctx, manifest.id, "usage.read", { provider: "suppress-spawn", usage: "quota", account: null, accountHome: null,
      model: null, weeklyTokens: null, weeklyUsd: null, quotaSource: null, now: 100, readOnly: true, refresh: false },
    { resources: { reads: [], stores: [], commands: [{ argv: ["opencode", "stats", "--models", "--cost", "--json", "--days", "7"], timeoutMs: 2000 }] } });
  } catch (error) { code = (error as { code?: string }).code ?? "unknown"; }
  elapsed = Date.now() - started;
  if (existsSync(marker)) { try { process.kill(Number(readFileSync(marker, "utf8")), 0); alive = true; } catch {} }
} finally { await registry.shutdown(); cleanupTestTmp(); }
console.log(JSON.stringify({ code, elapsed, alive }));
