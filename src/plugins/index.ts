import { BUNDLED } from "../../plugins/bundled";
import { pacerArgv } from "../install/self";
import type { Ctx } from "../types";
import { PluginRegistry } from "./registry";

const registries = new Map<string, PluginRegistry>();

/** One registry per pacer home in this process; plugins spawn lazily on first call. */
export function pluginRegistry(ctx: Ctx): PluginRegistry {
  let r = registries.get(ctx.pacerHome);
  if (!r) {
    r = new PluginRegistry({ bundled: BUNDLED, spawnBundled: (c, id) => ({ argv: [...pacerArgv(c.env), "plugin", "run", id], cwd: c.pacerHome, env: {} }) });
    registries.set(ctx.pacerHome, r);
  }
  return r;
}

/** Terminate every plugin child of this home; a no-op when none was started. */
export async function shutdownPlugins(ctx: Pick<Ctx, "pacerHome">): Promise<void> {
  const r = registries.get(ctx.pacerHome);
  if (r) { registries.delete(ctx.pacerHome); await r.shutdown(); }
}
