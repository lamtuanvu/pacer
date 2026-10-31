import type { PluginInfo, SurfaceInfo } from "../../../../src/plugins/registry";
import { PLUGIN_ICONS } from "../../plugins/icons";
export function pluginIcon(plugin: string, surfaces: SurfaceInfo[]) {
  if (plugin === "pacer-agent-session") return "plugin-terminal";
  if (plugin === "pacer-assistant") return "spark";
  const icon = surfaces.find(s => s.plugin === plugin && (s.surface === "activity" || s.surface === "panelTabs"))?.icon;
  return PLUGIN_ICONS[icon as keyof typeof PLUGIN_ICONS] ?? "plugin";
}
const capabilities: Record<string,string> = { "tasks.read":"Read tasks", "events.subscribe":"Follow events", "process.spawn":"Run programs", "fs.read":"Read files", "net.http":"Reach the network", "secrets.resolve":"Use secret references", "config.get":"Read its settings", "entitlement.report":"Report its licence", log:"Write logs" };
export const capabilityWords = (plugin: PluginInfo) => plugin.capabilities.map(cap => `${capabilities[cap.name] ?? cap.name}${cap.scopes?.length ? `: ${cap.scopes.join(", ")}` : ""}`);
export function pluginAdditions(plugin: PluginInfo) {
  const names = {settings:"Settings page",activity:"Activity view",panelTabs:"Right-panel tab",status:"Status bar item"};
  const points: Record<string,string> = {diagnostic:"Diagnostic checks",agentSession:"Terminal sessions",observation:"Usage reader",decision:"Routing engine"};
  return [...Object.entries(names).flatMap(([kind,label]) => { const count = plugin.ui[kind as keyof typeof names]; return count ? [count > 1 ? `${label} · ${count}` : label] : []; }), ...plugin.contributes.flatMap(point => points[point] ? [points[point]!] : [])];
}
export const attentionState = (plugin: PluginInfo) => ["failing","refused","needs_grant"].includes(plugin.state);

const bundledPresentation: Record<string, { name: string; description: string }> = {
  "pacer-agent-session": { name: "Agent sessions", description: "Live terminal sessions for delegated tasks" },
  "pacer-assistant": { name: "Assistant", description: "The always-on assistant behind ⌘J" },
};
export function pluginPresentation(plugin: PluginInfo) {
  return (plugin.bundled && bundledPresentation[plugin.id]) || { name: plugin.id, description: null };
}
