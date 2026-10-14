import { compareVersions, isVersion } from "../../src/update/version";
import type { UpdateCheck } from "../../src/update/check";
import type { OrcaHost } from "./orca-api";
import type { PluginMode } from "./mode";
export const UPDATE_INTERVAL_MS = 6 * 60 * 60 * 1000;
export interface PluginUpdates { plugin: string; cli: string | null; latest: string | null; available: boolean }
export const updateInstruction = (mode: PluginMode) => mode === "bootstrap"
  ? "In Orca Settings > Plugins, click Refresh, then Update plugin."
  : "Click Update in the pacer panel.";
export async function notifyUpdates(host: OrcaHost, mode: PluginMode, plugin: string, check: UpdateCheck | null, cli: string | null): Promise<PluginUpdates> {
  const newer = (v: string | null) => !!v && isVersion(v) && isVersion(plugin) && compareVersions(v, plugin) > 0;
  for (const [kind, version] of [["release", check?.latest ?? null], ["cli", cli]] as const) {
    if (!newer(version)) continue;
    const key = `pacer-update-${kind}-${version}`;
    if ((await host.call("storage.get", { key })).value === true) continue;
    const message = kind === "release" ? `pacer ${version} is available. ${updateInstruction(mode)}`
      : `The pacer CLI ${version} is newer than the Orca plugin ${plugin}. ${mode === "live" ? "Run pacer plugin install, then turn pacer off and on in Orca Settings > Plugins." : updateInstruction(mode)}`;
    const sent = await host.call("notifications.show", { title: "pacer update", body: message });
    if (sent.delivered) await host.call("storage.set", { key, value: true });
  }
  return { plugin, cli, latest: check?.latest ?? null, available: newer(check?.latest ?? null) || (!!check?.latest && !!cli && isVersion(cli) && compareVersions(check.latest, cli) > 0) };
}
