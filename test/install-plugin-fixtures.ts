import { afterEach } from "bun:test";
import { join } from "node:path";
import { fakeCtx as baseCtx } from "./helpers";
import { BUNDLED } from "../plugins/bundled";
import { pluginRegistry, shutdownPlugins } from "../src/plugins";
import type { Ctx } from "../src/types";
const contexts: Ctx[] = [];
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await shutdownPlugins(ctx);
});
/** Real source child, independent of the fixture's intentionally fictitious embedded PACER_BIN. */
export function fakeCtx(options: Partial<Ctx> = {}): Ctx {
  const ctx = baseCtx(options);
  contexts.push(ctx);
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
  return ctx;
}
