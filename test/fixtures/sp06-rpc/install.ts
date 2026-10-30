import { serve } from "../../../packages/plugin-sdk/src";
import {preparePlannerUninstallFiles} from "../../../packages/plugin-sdk/src/install/uninstall";
import { preparePlannerInstall } from "../../../packages/plugin-sdk/src/install/prepared";
import {
  createPlannerIO,
  readPlannerPrior,
} from "../../../packages/plugin-sdk/src/install/transport";
await serve({
  manifest: {
    id: "sp06-install",
    version: "1.0.0",
    publisher: "pacer",
    host: "^1.6",
    contributes: { planner: {} },
    capabilities: [],
  },
  handlers: {
    "planner.uninstall":async(params:any,host,signal)=>preparePlannerUninstallFiles(createPlannerIO(host,signal),params.priorRange?await readPlannerPrior(host,params.priorRange) as any:params.prior),
    "planner.install": async (params: any, host, signal) =>
      preparePlannerInstall(
        createPlannerIO(host, signal),
        params.env,
        params.priorRange
          ? ((await readPlannerPrior(host, params.priorRange)) as any)
          : params.prior,
        async (tx) => {
          if (params.binary) {
            await tx.run(
              [params.binary, params.env.folder + "/command", "forward"],
              [params.binary, params.env.folder + "/command", "undo"],
            );
            if (params.env.pacerArgv[0] === "fixture-crash") process.exit(7);
          }
          await tx.edit(
            params.env.folder + "/settings.json",
            () => "installed",
            [],
          );
        },
      ),
  },
});
