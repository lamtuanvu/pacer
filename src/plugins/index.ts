import { BUNDLED } from "../../plugins/bundled";
import { pacerArgv } from "../install/self";
import type { Ctx } from "../types";
import { PluginRegistry,type RegistryDeps } from "./registry";
import { fileURLToPath } from "node:url";

const registries = new Map<string, PluginRegistry>();

/** Preserve front/wrapper routing while binding development children to this source core. */
export function bundledPluginSpawn(c: Ctx, id: string, runtime: {executable:string;bunVersion?:string} = {executable:process.execPath,bunVersion:process.versions.bun}) {
  const source = Boolean(runtime.bunVersion) && /(^|\/)bun(?:\.exe)?$/.test(runtime.executable);
  const cli = fileURLToPath(new URL("../cli.ts", import.meta.url));
  const argv = !c.env.PACER_BIN && source ? [runtime.executable, cli] : pacerArgv(c.env);
  // Never copy or evaluate the ambient selector. A source front needs only the
  // already-running host's fixed runtime and module, not arbitrary child env.
  const env = source && c.env.PACER_BIN && c.env.PACER_CORE_ARGV !== undefined
    ? {PACER_CORE_ARGV:JSON.stringify([runtime.executable,cli])} : {};
  return {argv:[...argv,"plugin","run",id],cwd:c.home,env};
}

/** One registry per pacer home in this process; plugins spawn lazily on first call. */
export function pluginRegistry(ctx: Ctx, dependencies?:RegistryDeps): PluginRegistry {
  let r = registries.get(ctx.pacerHome);
  if (!r) {
    r = new PluginRegistry(dependencies??{ bundled: BUNDLED, spawnBundled: bundledPluginSpawn });
    registries.set(ctx.pacerHome, r);
  }
  return r;
}

/** Terminate every plugin child of this home; a no-op when none was started. */
export async function shutdownPlugins(ctx: Pick<Ctx, "pacerHome">): Promise<void> {
  const r = registries.get(ctx.pacerHome);
  if (r) { registries.delete(ctx.pacerHome); await r.shutdown(); }
}
