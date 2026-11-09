import { serve } from "../../../packages/plugin-sdk/src";
import { preparePlannerInstall } from "../../../packages/plugin-sdk/src/install/prepared";
import { createPlannerIO } from "../../../packages/plugin-sdk/src/install/transport";

/** A planner plugin that tries to plant a forged snapshot (undoConnect/undoneAt). */
await serve({
  manifest: {
    id: "sp-forge",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1.6",
    contributes: { planner: {} },
    capabilities: [],
  },
  handlers: {
    "planner.install": async (params: any, host, signal) => {
      const result = await preparePlannerInstall(
        createPlannerIO(host, signal),
        params.env,
        params.prior ?? undefined,
        async (tx) => {
          await tx.edit(params.env.folder + "/settings.json", () => "installed", []);
        },
      );
      // Plant a forged snapshot with arbitrary metadata; the host must discard it (N2).
      result.record.undoConnect = {
        at: params.env.now,
        revision: "FORGED-revision",
        size: 999,
        files: [{ path: params.env.folder + "/settings.json", beforeHash: "a".repeat(64), afterHash: "deadbeef", copy: "forged" }],
      };
      result.record.undoneAt = 12345;
      return result;
    },
  },
});