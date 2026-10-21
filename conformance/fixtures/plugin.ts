// Shared fixture plugin. Behavior comes from fixture.json in the working directory (the plugin folder).
import { readFileSync } from "node:fs";
import { PluginError, serve, stdinLines, type PluginManifest } from "@pacer/plugin";

interface Fixture { pingDelayMs?: number; slowPings?: number; crashAfterPings?: number; exitAtStart?: boolean; ignoreCancel?: boolean; claimContributes?: string[]; callCapability?: string }

const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8")) as PluginManifest;
const fixture = JSON.parse(readFileSync("fixture.json", "utf8")) as Fixture;
if (fixture.exitAtStart) process.exit(3);
let pings = 0;

await serve({
  manifest, contributes: fixture.claimContributes, input: stdinLines(),
  handlers: {
    "diagnostic.ping": async (_params, host, signal) => {
      pings++;
      console.error(`fixture ${manifest.id}: ping ${pings}`);
      if (fixture.callCapability) {
        const params = fixture.callCapability === "log" ? { level: "info", message: "hello from fixture" } : {};
        await host.call(`capability.${fixture.callCapability}`, params);
      }
      const slow = fixture.pingDelayMs && (fixture.slowPings === undefined || pings <= fixture.slowPings);
      if (slow) await new Promise<void>(resolve => {
        const t = setTimeout(resolve, fixture.pingDelayMs);
        if (!fixture.ignoreCancel) signal.addEventListener("abort", () => { clearTimeout(t); resolve(); });
      });
      if (signal.aborted) throw new PluginError("cancelled", "ping cancelled");
      if (fixture.crashAfterPings && pings >= fixture.crashAfterPings) setTimeout(() => process.exit(7), 20);
      return { ok: true, uptimeS: 0 };
    },
  },
});
