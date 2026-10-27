import { SETTINGS_GROUPS, SETTINGS_PAGES, settingsAttention, settingsPageId } from '../settings-pages';
import { SettingsNav } from "../ds/SettingsNav";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import type { Counts } from "../../../src/api/read-model/types";
import { hrefFor, routes, type Route } from "../router";
/** 200 px panel beside the rail while any settings screen is open. */
export function SettingsPanel({ route, counts, snapshot }: { route: Route; counts: Counts | null; snapshot?: ClientSnapshot | null }) {
  const attention = settingsAttention(snapshot, counts);
  const current = route.name === 'hosts' ? 'hosts' : route.name === 'add-executor' ? 'add-executor' : route.name === 'settings' ? settingsPageId(route.section) : null;
  const groups = SETTINGS_GROUPS.map(group => ({ ...group, items: SETTINGS_PAGES.filter(page => page.group === group.id).map(({ id, label, icon }) => ({
    id: id || 'overview', label, icon, current: id === current,
    href: hrefFor(id === 'hosts' ? routes.hosts() : id === 'add-executor' ? routes.addExecutor() : routes.settings(id || undefined), route.query),
    badge: attention[id],
  })) }));
  return <aside className="pc-panel" aria-label="Settings"><SettingsNav label="Settings pages" groups={groups}/></aside>;
}

export function SettingsPanelData({ route, counts, snapshot }: { route: Route; counts: Counts | null; snapshot?: ClientSnapshot | null }) {
  return <SettingsPanel route={route} counts={counts} snapshot={snapshot} />;
}
