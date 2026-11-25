import { BUNDLED } from "./bundled";
import { pacerArgv } from "../install/self";
import type { Ctx } from "../types";
import { CoreError } from "../core/errors";
import { inspectBundledNativeExecutable, nativeSiblingRefusal } from "./native-bundled";
import { PluginRegistry,type RegistryDeps } from "./registry";
import { fileURLToPath } from "node:url";

const registries = new Map<string, PluginRegistry>();

/** Preserve front/wrapper routing while binding development children to this source core. */
export function bundledPluginSpawn(c: Ctx, id: string, runtime: {executable:string;bunVersion?:string} = {executable:process.execPath,bunVersion:process.versions.bun}) {
  const bundled = BUNDLED.find(plugin => plugin.manifest.id === id);
  if (bundled?.executable) {
    const sibling = inspectBundledNativeExecutable(bundled.executable, c.env, runtime.executable);
    if (sibling.status !== "ready") {
      throw new CoreError("plugin_unavailable", nativeSiblingRefusal(bundled.executable, sibling) ?? `native executable ${bundled.executable} is not installed next to pacer-core`);
    }
    return { argv: [sibling.path], cwd: c.home, env: {} };
  }
  const source = Boolean(runtime.bunVersion) && /(^|\/)bun(?:\.exe)?$/.test(runtime.executable);
  // A source front runs the SDK example directly; a compiled front goes through
  // the Rust `plugin run` door, which serves every shipped row natively. There
  // is no selector env any more: the Rust door needs no TypeScript child.
  // A Bun host always runs the source example directly: the compiled core no
  // longer carries a TypeScript runner, so routing a source child through
  // `pacer-core plugin run` would fail. Only a compiled host uses the Rust door.
  const argv = source
    ? [runtime.executable, fileURLToPath(new URL("../../examples/plugins/run.ts", import.meta.url)), id]
    : [...pacerArgv(c.env), "plugin", "run", id];
  return { argv, cwd: c.home, env: {} };
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

/** Pacer homes with a registry in this process; test teardown stops the ones a test left running. */
export function pluginRegistryHomes(): string[] {
  return [...registries.keys()];
}
