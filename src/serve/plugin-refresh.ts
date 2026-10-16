import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readManifest } from "../install/manifest";
import { PLUGIN_RECORD } from "../link/paths";
import { publish } from "../link/publish";
import { installPlugin, MANAGED_MARKER, pluginDir } from "../plugin/install";
import type { Ctx } from "../types";

export interface PluginRefreshDeps {
  standalone: boolean;
  execPath: string;
  install: typeof installPlugin;
  publish: typeof publish;
  log: (line: string) => void;
}

/** Repair managed assets after any binary update; never change Orca settings or prevent serving. */
export async function refreshManagedPlugin(ctx: Ctx, version: string, overrides: Partial<PluginRefreshDeps> = {}): Promise<void> {
  const deps: PluginRefreshDeps = {
    standalone: Bun.isStandaloneExecutable, execPath: process.execPath,
    install: installPlugin, publish, log: console.log, ...overrides,
  };
  if (!deps.standalone) return;
  try {
    if (!Object.hasOwn(readManifest(ctx).planners, PLUGIN_RECORD)) return;
    const markerPath = join(pluginDir(ctx), MANAGED_MARKER);
    if (!existsSync(markerPath)) return;
    const marker = JSON.parse(readFileSync(markerPath, "utf8"));
    if (marker.version === version) return;
    await deps.install({ ctx, pacerArgv: [deps.execPath] });
    const hint = `pacer: refreshed the Orca plugin to ${version}; turn pacer off and on in Orca Settings > Plugins to load it`;
    deps.log(hint);
    await deps.publish(ctx, [{ v: 1, type: "alert", data: {
      key: "plugin-refreshed", level: "info", title: "Orca plugin refreshed", body: hint, at: ctx.now,
    } }], { bridge: false, channel: false });
  } catch (error) {
    const reason = (error instanceof Error ? error.message : String(error)).split(/\r?\n/)[0];
    deps.log(`pacer: could not refresh the Orca plugin: ${reason}`);
  }
}
