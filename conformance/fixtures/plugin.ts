// Shared fixture plugin. Behavior comes from fixture.json in the working directory (the plugin folder).
import { appendFileSync, readFileSync } from "node:fs";
import { PluginError, serve, stdinLines, type PluginManifest } from "@pacer/plugin";

interface Fixture { pingProbe?: "serial" | "barrier"; pingDelayMs?: number; slowPings?: number; crashAfterPings?: number; exitAtStart?: boolean; ignoreCancel?: boolean; claimContributes?: string[]; callCapability?: string }

const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8")) as PluginManifest;
const fixture = JSON.parse(readFileSync("fixture.json", "utf8")) as Fixture;
if (fixture.exitAtStart) process.exit(3);
let pings = 0, active = 0, sequence = 0;
let releaseBarrier: (() => void) | undefined;
const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
function receipt(ping: number, phase: "enter" | "exit" | "abort"): void {
  appendFileSync("ping-receipts.jsonl", JSON.stringify({ seq: ++sequence, ping, phase, active }) + "\n", { mode: 0o600 });
}

await serve({
  manifest, contributes: fixture.claimContributes, input: stdinLines(),
  handlers: {
    "diagnostic.ping": async (_params, host, signal) => {
      const ping = ++pings;
      const measured = fixture.pingProbe !== undefined && ping > 1;
      if (measured) {
        active++; receipt(ping, "enter");
        if (fixture.pingProbe === "barrier") {
          if (active === 2) releaseBarrier?.();
          await new Promise<void>((resolve, reject) => {
            const aborted = () => reject(new PluginError("cancelled", "overlap barrier cancelled"));
            signal.addEventListener("abort", aborted, { once: true });
            if (signal.aborted) aborted();
            barrier.then(() => { signal.removeEventListener("abort", aborted); resolve(); });
          }).catch(error => { active--; receipt(ping, "abort"); throw error; });
        }
      }
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
      if (signal.aborted) {
        if (measured) { active--; receipt(ping, "abort"); }
        throw new PluginError("cancelled", "ping cancelled");
      }
      if (measured) { active--; receipt(ping, "exit"); }
      if (fixture.crashAfterPings && pings >= fixture.crashAfterPings) setTimeout(() => process.exit(7), 20);
      return { ok: true, uptimeS: 0 };
    },
  },
});
