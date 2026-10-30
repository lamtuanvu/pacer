import { serve } from "../../../packages/plugin-sdk/src";
await serve({
  manifest: {
    id: "sp06-rpc",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1.6",
    contributes: { planner: {} },
    capabilities: [],
  },
  handlers: {
    "planner.install": () => ({ schema: 1, text: "界".repeat(380000) }),
    "planner.plan": () => ({ schema: 1, text: "界".repeat(380000) }),
  },
});
