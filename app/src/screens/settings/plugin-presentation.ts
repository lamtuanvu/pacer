import type { PluginInfo, SurfaceInfo } from "../../../../src/plugins/registry";
import { PLUGIN_ICONS } from "../../plugins/icons";
export function pluginIcon(plugin: string, surfaces: SurfaceInfo[]) {
  if (plugin === "pacer-agent-session") return "plugin-terminal";
  if (plugin === "pacer-assistant" || plugin === "assistant-pacer") return "spark";
  const icon = surfaces.find(s => s.plugin === plugin && (s.surface === "activity" || s.surface === "panelTabs"))?.icon;
  return PLUGIN_ICONS[icon as keyof typeof PLUGIN_ICONS] ?? "plugin";
}
const capabilities: Record<string,string> = { "tasks.read":"Read tasks", "events.subscribe":"Follow events", "process.spawn":"Run programs", "fs.read":"Read files", "net.http":"Reach the network", "assistant.tool":"Read pacer data for the assistant", "secrets.resolve":"Use secret references", "config.get":"Read its settings", "entitlement.report":"Report its licence", log:"Write logs" };
export const capabilityWords = (plugin: PluginInfo) => plugin.capabilities.map(cap => `${capabilities[cap.name] ?? cap.name}${cap.scopes?.length ? `: ${cap.scopes.join(", ")}` : ""}`);
export function pluginAdditions(plugin: PluginInfo) {
  const names = {settings:"Settings page",activity:"Activity view",panelTabs:"Right-panel tab",status:"Status bar item"};
  const points: Record<string,string> = {diagnostic:"Diagnostic checks",agentSession:"Terminal sessions",observation:"Usage reader",decision:"Routing engine"};
  return [...Object.entries(names).flatMap(([kind,label]) => { const count = plugin.ui[kind as keyof typeof names]; return count ? [count > 1 ? `${label} · ${count}` : label] : []; }), ...plugin.contributes.flatMap(point => points[point] ? [points[point]!] : [])];
}
/** Optional native sibling of pacer-core is absent or stale (ADR 0028/0031). Turns fall back; not attention. */
export function isNativeSiblingMissing(plugin: PluginInfo): boolean {
  return plugin.bundled
    && plugin.state === "refused"
    && typeof plugin.error === "string"
    && (/native executable .+ is not installed next to pacer-core/.test(plugin.error)
      || /native executable .+ is outdated/.test(plugin.error));
}

export const attentionState = (plugin: PluginInfo) =>
  ["failing", "refused", "needs_grant"].includes(plugin.state) && !isNativeSiblingMissing(plugin);

export function pluginStatus(plugin: PluginInfo): { tone: "bad" | "warn" | "neutral"; label: string } | undefined {
  if (isNativeSiblingMissing(plugin)) {
    const outdated = typeof plugin.error === "string" && /outdated/.test(plugin.error);
    return { tone: "neutral", label: outdated ? "Outdated" : "Not installed" };
  }
  if (plugin.state === "failing") return { tone: "bad", label: "Failing" };
  if (plugin.state === "refused") return { tone: "bad", label: "Refused" };
  if (plugin.state === "needs_grant") return { tone: "warn", label: "Needs permission" };
  return undefined;
}

/** Card chrome for attention/bad — missing optional natives stay neutral. */
export function pluginCardTone(plugin: PluginInfo): "bad" | "attention" | null {
  if (isNativeSiblingMissing(plugin)) return null;
  if (plugin.state === "failing" || plugin.state === "refused") return "bad";
  return attentionState(plugin) ? "attention" : null;
}

const bundledPresentation: Record<string, { name: string; description: string }> = {
  "pacer-agent-session": { name: "Agent sessions", description: "Live terminal sessions for delegated tasks" },
  "pacer-assistant": { name: "Assistant", description: "The always-on assistant behind ⌘J" },
  "assistant-pacer": { name: "Pacer assistant", description: "Pacer's own agent (native reply backend)" },
};
export function pluginPresentation(plugin: PluginInfo) {
  return (plugin.bundled && bundledPresentation[plugin.id]) || { name: plugin.id, description: null };
}
