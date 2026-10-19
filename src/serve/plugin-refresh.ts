import { existsSync } from "node:fs";
import { join } from "node:path";
import { readManifest } from "../install/manifest";
import { PLUGIN_RECORD } from "../link/paths";
import { recordPluginReload } from "../attention/plugin-reload";
import { BUNDLED_PLUGIN_HASH, installedPluginHash } from "../plugin/content";
import { PLUGIN_VERSION } from "../plugin/assets.generated";
import { installPlugin, MANAGED_MARKER, pluginDir } from "../plugin/install";
import type { Ctx } from "../types";

export interface PluginRefreshDeps {
  standalone: boolean;
  execPath: string;
  install: typeof installPlugin;
  log: (line: string) => void;
}

/** Repair managed assets after any binary update; never change Orca settings or prevent serving. */
export async function refreshManagedPlugin(ctx: Ctx, overrides: Partial<PluginRefreshDeps> = {}): Promise<void> {
  const deps: PluginRefreshDeps = {
    standalone: Bun.isStandaloneExecutable, execPath: process.execPath,
    install: installPlugin, log: console.log, ...overrides,
  };
  if (!deps.standalone) return;
  try {
    if (!Object.hasOwn(readManifest(ctx).planners, PLUGIN_RECORD)) return;
    const markerPath = join(pluginDir(ctx), MANAGED_MARKER);
    if (!existsSync(markerPath)) return;
    if (installedPluginHash(pluginDir(ctx)) === BUNDLED_PLUGIN_HASH) return;
    await deps.install({ ctx, pacerArgv: [deps.execPath] });
    // Orca currently exposes no plugin reload API/CLI. Keep one dismissible
    // Needs you item per bundle, persisted across service restarts.
    recordPluginReload(ctx, { hash: BUNDLED_PLUGIN_HASH, version: PLUGIN_VERSION, at: ctx.now });
    deps.log(`pacer: refreshed the Orca plugin to ${PLUGIN_VERSION}; see Needs you for reload instructions`);
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0];
    deps.log(`pacer: could not refresh the Orca plugin: ${reason}`);
  }
}
