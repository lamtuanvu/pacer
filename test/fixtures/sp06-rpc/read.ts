import { serve } from "../../../packages/plugin-sdk/src";
await serve({
  manifest: {
    id: "sp06-read",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1.6",
    contributes: { planner: {} },
    capabilities: [],
  },
  handlers: {
    "planner.install": async (params: any, host) =>
      host.call(
        params.method ?? "capability.fs.read",
        params.input ?? { path: params.path },
      ),
  },
});
