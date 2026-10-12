import { clip, type LinkSnapshot } from "../../src/link/envelope";
import type { OrcaHost } from "./orca-api";
import type { PluginSettings } from "./settings";
export async function notifyNewAlerts(host: OrcaHost, s: LinkSnapshot, settings: PluginSettings, activatedAtS: number): Promise<number> {
  const alerts = s.alerts.filter(a => a.at > Math.max(settings.lastAlertAt, activatedAtS - 600)).sort((a,b) => a.at-b.at).slice(0,3);
  let newest = settings.lastAlertAt;
  for (const a of alerts) {
    const result = await host.call("notifications.show", { title: clip(a.title, 120), body: clip(a.body, 1000) });
    if (!result.delivered) break;
    newest = a.at;
  }
  if (newest > settings.lastAlertAt) {
    settings.lastAlertAt = newest;
    await host.call("settings.set", { key: "lastAlertAt", value: newest });
  }
  return newest;
}
