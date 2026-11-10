import { defaultPumpDeps, pumpOnce } from "../../src/link/pump";
import { publish } from "../../src/link/publish";
import type { Ctx } from "../../src/types";

declare const self: Worker;
self.onmessage = async (event: MessageEvent<{ home: string; pacerHome: string; now: number }>) => {
  const c: Ctx = { ...event.data, env: { HOME: event.data.home, PACER_HOME: event.data.pacerHome }, which: () => null,
    run: async () => ({ code: 127, stdout: "", stderr: "disabled in fixture" }) };
  try {
    await pumpOnce(c, { ...defaultPumpDeps,
      status: async () => ({ generatedAt: c.now, strategy: "s", planner: "p", mode: "normal", disabled: false, calendarPace: false, providers: [], executors: { ranked: [], excluded: [] } }) as any,
      publish: async (ctx, events, prepare) => {
        const report = await publish(ctx, events, prepare);
        if (prepare && report.transports.includes("outbox")) {
          self.postMessage("published");
          await new Promise(() => {}); // parent terminates this isolate before checkpoint
        }
        return report;
      },
    });
  } catch (error) { self.postMessage({ error: String(error) }); }
};
