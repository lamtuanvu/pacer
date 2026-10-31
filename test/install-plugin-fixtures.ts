import { join } from "node:path";
import { fakeCtx as baseCtx } from "./helpers";
import { BUNDLED } from "../plugins/bundled";
import { pluginRegistry, shutdownPlugins } from "../src/plugins";
import type { Ctx } from "../src/types";
import { registerFixtureCleanup } from "./fixture-cleanup";
/** Real source child, independent of the fixture's intentionally fictitious embedded PACER_BIN. */
export function fakeCtx(options: Partial<Ctx> = {}): Ctx {
  const ctx = baseCtx(options);
  pluginRegistry(ctx, {
    bundled: BUNDLED,
    spawnBundled: (_ctx, id) => ({
      argv: [
        process.execPath,
        join(import.meta.dir, "../src/cli.ts"),
        "plugin",
        "run",
        id,
      ],
      cwd: ctx.home,
      env: { PATH: process.env.PATH },
    }),
  });
  const pacerHome = ctx.pacerHome;
  registerFixtureCleanup(() => shutdownPlugins({ pacerHome }));
  return ctx;
}
