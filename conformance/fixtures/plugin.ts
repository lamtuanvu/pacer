// Shared fixture plugin. Behavior comes from fixture.json in the working directory (the plugin folder).
import { appendFileSync, readFileSync } from "node:fs";
import { PluginError, serve, stdinLines, type PluginManifest } from "@pacer/plugin";

interface Fixture { pingProbe?: "serial" | "barrier"; pingDelayMs?: number; slowPings?: number; crashAfterPings?: number; exitAtStart?: boolean; ignoreCancel?: boolean; claimContributes?: string[]; callCapability?: string; renderDelayMs?: number; uiDocument?: unknown; renderCrash?: boolean; invalidateOnRender?: boolean; actionMessage?: string; validateErrors?: { path: string; message: string }[] }

const manifest = JSON.parse(readFileSync("pacer-plugin.json", "utf8")) as PluginManifest;
const fixture = JSON.parse(readFileSync("fixture.json", "utf8")) as Fixture;
if (fixture.exitAtStart) process.exit(3);
let pings = 0, active = 0, sequence = 0;
let renders = 0;
let activePings = 0;
let peakConcurrentPings = 0;
let releaseBarrier: (() => void) | undefined;
const barrier = new Promise<void>(resolve => { releaseBarrier = resolve; });
function receipt(ping: number, phase: "enter" | "exit" | "abort"): void {
  appendFileSync("ping-receipts.jsonl", JSON.stringify({ seq: ++sequence, ping, phase, active }) + "\n", { mode: 0o600 });
}

await serve({
  manifest, contributes: fixture.claimContributes, input: stdinLines(),
  handlers: {
    "ui.render": async (_params, host) => {
      renders++;
      if (fixture.renderCrash) setTimeout(() => process.exit(9), 10);
      if (fixture.renderDelayMs) await new Promise<void>(r => setTimeout(r, fixture.renderDelayMs));
      if (fixture.invalidateOnRender) for (let i = 0; i < 5; i++) host.invalidate();
      return { document: fixture.uiDocument ?? { type: "text", text: `render ${renders}` }, ttlS: 0 };
    },
    "ui.action": async () => ({ result: "refresh", message: fixture.actionMessage ?? "done" }),
    "ui.settings.validate": async () => fixture.validateErrors ? { ok: false, errors: fixture.validateErrors } : { ok: true },
    "diagnostic.ping": async (_params, host, signal) => {
      const ping = ++pings;
      const measured = fixture.pingProbe !== undefined && ping > 1;
      let entered = false, completed = false;
      activePings++;
      peakConcurrentPings = Math.max(peakConcurrentPings, activePings);
      try {
        console.error(`fixture ${manifest.id}: ping ${ping}`);
        console.error(`fixture ${manifest.id}: active pings ${activePings}`);
        if (measured) {
          active++; entered = true; receipt(ping, "enter");
          if (fixture.pingProbe === "barrier") {
            if (active === 2) releaseBarrier?.();
            let aborted: (() => void) | undefined;
            try {
              await new Promise<void>((resolve, reject) => {
                aborted = () => reject(new PluginError("cancelled", "overlap barrier cancelled"));
                signal.addEventListener("abort", aborted, { once: true });
                if (signal.aborted) aborted();
                barrier.then(resolve);
              });
            } finally {
              if (aborted) signal.removeEventListener("abort", aborted);
            }
          }
        }
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
        completed = true;
        return { ok: true, uptimeS: 0, peakConcurrentPings };
      } finally {
        try {
          if (entered) { active--; receipt(ping, completed ? "exit" : "abort"); }
        } finally {
          activePings--;
        }
      }
    },
  },
});
