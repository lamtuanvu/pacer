import { SETTINGS_GROUPS, SETTINGS_PAGES, settingsAttention, settingsNavId } from '../settings-pages';
import { SettingsNav } from "../ds/SettingsNav";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import type { Counts } from "../../../src/api/read-model/types";
import { hrefFor, routes, type Route } from "../router";
/** 240 px panel beside the rail while any settings screen is open. `embedded` returns only the nav, for a SidePanel that owns the landmark. */
export function SettingsPanel({ route, counts, snapshot, embedded = false }: { route: Route; counts: Counts | null; snapshot?: ClientSnapshot | null; embedded?: boolean }) {
  const attention = settingsAttention(snapshot, counts);
  const current = route.name === 'hosts' ? 'machine' : route.name === 'add-executor' ? 'executors' : route.name === 'settings' ? settingsNavId(route.section) : null;
  const groups = SETTINGS_GROUPS.map(group => ({ ...group, items: SETTINGS_PAGES.filter(page => page.group === group.id).map(({ id, label, icon }) => ({
    id: id || 'overview', label, icon, current: id === current,
    href: hrefFor(routes.settings(id || undefined), route.query),
    badge: id === 'executors' ? attention[id] : undefined,
  })) }));
  const nav = <SettingsNav label="Settings pages" groups={groups} backHref={hrefFor(routes.start(), route.query)}/>;
  return embedded ? nav : <aside className="pc-panel" aria-label="Settings">{nav}</aside>;
}

export function SettingsPanelData({ route, counts, snapshot, embedded }: { route: Route; counts: Counts | null; snapshot?: ClientSnapshot | null; embedded?: boolean }) {
  return <SettingsPanel route={route} counts={counts} snapshot={snapshot} embedded={embedded} />;
}
