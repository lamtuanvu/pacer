import { useDiagnosticsStatus } from "../data/diagnostics-status";
import { useContext, useEffect, useState } from "preact/hooks";
import { PluginContext } from "../plugins/catalog";
import { PLUGIN_ICONS } from "../plugins/icons";
import type { PluginInfo } from "../../../src/plugins/registry";
import { useTaskContext } from "../screens/task-shared";
import { SETTINGS_GROUPS, SETTINGS_PAGES, settingsAttention, settingsNavId } from '../settings-pages';
import { SettingsNav, type SettingsNavGroup, type SettingsNavItem } from "../ds/SettingsNav";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import type { Counts } from "../../../src/api/read-model/types";
import { hrefFor, routes, type Route } from "../router";
/** 240 px panel beside the rail while any settings screen is open. `embedded` returns only the nav, for a SidePanel that owns the landmark. */
export function SettingsPanel({ route, counts, snapshot, embedded = false }: { route: Route; counts: Counts | null; snapshot?: ClientSnapshot | null; embedded?: boolean }) {
  const context = useTaskContext(), api = context?.api, state = context?.state, { surfaces, revision } = useContext(PluginContext);
  const [plugins, setPlugins] = useState<PluginInfo[] | undefined>();
  useEffect(() => { if(!api) return; let active = true; void api.call<{plugins:PluginInfo[]}>("plugin.list", {}).then(data => { if(active) setPlugins(data.plugins ?? []); }, () => { if(active) setPlugins(undefined); }); return () => {active=false;}; }, [api, revision, state?.connected]);
  const needs = (plugins ?? []).filter(plugin => ["failing", "refused", "needs_grant"].includes(plugin.state)).length;
  const attention = settingsAttention(snapshot, counts), diagnostics = useDiagnosticsStatus();
  let current = route.name === 'hosts' ? 'machine' : route.name === 'add-executor' ? 'executors' : route.name === 'settings' ? settingsNavId(route.section) : null;
  if (current?.startsWith("plugins/") && !surfaces.some(surface => surface.surface === "settings" && surface.visible && `plugins/${surface.plugin}` === current)) current = "plugins";
  const groups: (Omit<SettingsNavGroup,"items"> & {items:SettingsNavItem[]})[] = SETTINGS_GROUPS.map(group => ({ ...group, items: SETTINGS_PAGES.filter(page => page.group === group.id).map(({ id, label, icon }) => ({
    id: id || 'overview', label, icon, current: id === current,
    href: hrefFor(routes.settings(id || undefined), route.query),
    badge: id === 'plugins' && needs ? {text:String(needs),label:`${needs} ${needs === 1 ? 'plugin needs' : 'plugins need'} attention`,tone:'warn' as const} : id === 'diagnostics' ? (!diagnostics.checked || diagnostics.issues ? {text:'!',label:diagnostics.checked ? `${diagnostics.issues} checks need attention` : 'Checks not run yet',tone:'warn' as const} : undefined) : id === 'executors' ? attention[id] : undefined,
  })) }));
  const extend = groups.find(group => group.id === 'extend')!;
  for (const surface of (plugins ? surfaces : []).filter(surface => surface.surface === 'settings' && surface.visible)) extend.items.push({
    id:`plugins/${surface.plugin}`,label:surface.title,icon:surface.icon === 'check-square' ? 'settings-release' : PLUGIN_ICONS[surface.icon as keyof typeof PLUGIN_ICONS] ?? 'checks',
    current:current === `plugins/${surface.plugin}`,href:hrefFor(routes.pluginSettings(surface.plugin),route.query),badge:undefined,plugin:true,
  } as SettingsNavItem);
  const nav = <SettingsNav label="Settings pages" groups={groups} backHref={hrefFor(routes.dispatch(), route.query)}/>;
  return embedded ? nav : <aside className="pc-panel" aria-label="Settings">{nav}</aside>;
}

export function SettingsPanelData({ route, counts, snapshot, embedded }: { route: Route; counts: Counts | null; snapshot?: ClientSnapshot | null; embedded?: boolean }) {
  return <SettingsPanel route={route} counts={counts} snapshot={snapshot} embedded={embedded} />;
}
