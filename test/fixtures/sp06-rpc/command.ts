import { serve } from "../../../packages/plugin-sdk/src";
const manifest = {
  id: "sp06-rpc",
  version: "1.0.0",
  publisher: "pacer",
  host: "^1.6",
  contributes: { planner: {} },
  capabilities: [{ name: "process.spawn", scopes: ["sp06-tool"] }],
};
const run = async (params: any, host: any) => {
  let result;
  for (const intent of params.intents ?? [params.intent])
    result = await host.call("capability.planner.run", intent);
  return result;
};
await serve({
  manifest,
  handlers: {
    "planner.install": run,
    "planner.plan": run,
    "planner.detect": run,
    "planner.check": run,
  },
});
