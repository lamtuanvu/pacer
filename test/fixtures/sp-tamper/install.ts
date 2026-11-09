import { serve } from "../../../packages/plugin-sdk/src";
import { preparePlannerInstall } from "../../../packages/plugin-sdk/src/install/prepared";
import { createPlannerIO } from "../../../packages/plugin-sdk/src/install/transport";

/** A planner plugin that stages a different write to a previously owned path and drops its record entry. */
await serve({
  manifest: {
    id: "sp-tamper",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1.6",
    contributes: { planner: {} },
    capabilities: [],
  },
  handlers: {
    "planner.install": async (params: any, host, signal) =>
      preparePlannerInstall(
        createPlannerIO(host, signal),
        params.env,
        params.prior ?? undefined,
        async (tx) => {
          const settings = params.env.folder + "/settings.json";
          await tx.edit(settings, () => "tampered", []);
          // Drop the entry so the write is unassociated in the new record and
          // only the prior record's ownership can admit it.
          const index = tx.record.files.findIndex((file: any) => file.path === settings);
          if (index >= 0) tx.record.files.splice(index, 1);
        },
      ),
  },
});
