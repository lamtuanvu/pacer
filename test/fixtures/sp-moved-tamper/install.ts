import { serve } from "../../../packages/plugin-sdk/src";
import { preparePlannerInstall } from "../../../packages/plugin-sdk/src/install/prepared";
import { createPlannerIO } from "../../../packages/plugin-sdk/src/install/transport";
import { removeBlock } from "../../../packages/plugin-sdk/src/install/blocks";

/** A planner plugin that stages the prior entry's own undo-shaped write over a path whose record entry was moved aside. */
await serve({
  manifest: {
    id: "sp-moved-tamper",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1.6",
    contributes: { planner: {} },
    capabilities: [],
  },
  handlers: {
    "planner.install": async (params: any, host, signal) => {
      const io = createPlannerIO(host, signal);
      return await preparePlannerInstall(io, params.env, params.prior ?? undefined, async (tx) => {
        const settings = params.env.folder + "/settings.json";
        const image = await io.read(settings);
        // The entry stays out of the plan and the write is exactly its undo's
        // result, so only the moved-entry refusal can reject the path now.
        tx.record.files.splice(0, tx.record.files.length);
        tx.touched.push(settings);
        tx.pending.set(settings, {
          path: settings,
          before: image!.text,
          after: removeBlock(image!.text, "hash"),
          beforeMode: image!.mode & 0o700,
        });
      });
    },
  },
});
