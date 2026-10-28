import { desktopUpdateIndicator } from "../../../src/view-model/updates";
import { SETTINGS_PAGES } from '../settings-pages';
import { Icon, type IconName } from '../ds/icons';
import { AppLink } from "../navigation";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import type { Counts } from "../../../src/api/read-model/types";
import { routes, type Route, type RouteTarget } from "../router";
/** 200 px panel beside the rail while any settings screen is open. `embedded` returns only the links, for a SidePanel that owns the landmark. */
export function SettingsPanel({ route, counts, snapshot, badges = {}, embedded = false }: { route: Route; counts: Counts | null; snapshot?: ClientSnapshot | null; badges?: Record<string, string | number>; embedded?: boolean }) {
  const hosts = snapshot?.hosts ? snapshot.hosts.filter(host => host.state === "needs_setup").length : counts?.hostsWithProblems ?? 0;
  const down = snapshot?.executors?.filter(e => e.state === "down" || e.state === "failing").length ?? 0;
  const blocked = snapshot?.executors?.filter(e => e.state === "blocked").length ?? 0;
  const update = desktopUpdateIndicator(snapshot?.desktopUpdates);
  badges = { ...badges, updates: update?.glyph ?? "", ...(snapshot?.accounts ? {accounts:snapshot.accounts.length} : {}), executors:down+blocked ? String(down+blocked) : "" };
  const item = (to: RouteTarget, label: string, on: boolean, badge: string | number = "", tone = "neutral", icon: IconName = "settings", badgeLabel = String(badge)) =>
    <AppLink className={`pc-panel__item${on ? " on" : ""}`} to={to} query={route.query} aria-current={on ? "page" : undefined}><Icon name={icon}/>{label}{badge !== "" && <span className={`pc-rail__badge pc-rail__badge--${tone}`} aria-label={badgeLabel} title={badgeLabel}>{badge}</span>}</AppLink>;
  const links = SETTINGS_PAGES.map(({ id, label, icon }) => {
      const on = id === 'hosts' ? route.name === 'hosts' : id === 'add-executor' ? route.name === 'add-executor' : route.name === 'settings' && (route.section ?? '') === id;
      const badge = id === 'hosts' ? (hosts ? `${hosts} needs setup` : '') : badges[id] ?? '';
      const to=id==='hosts'?routes.hosts():id==='add-executor'?routes.addExecutor():routes.settings(id||undefined);
      return item(to, label, on, badge, id === 'hosts' ? 'warn' : id === 'executors' ? 'bad' : id === 'updates' && update && ['bad', 'warn', 'info'].includes(update.tone) ? update.tone : 'neutral', icon, id === 'executors' ? `${down} need attention; ${blocked} blocked` : id === 'updates' ? update?.label : undefined);
    });
  return embedded ? <>{links}</> : <aside className="pc-panel" aria-label="Settings">{links}</aside>;
}

export function SettingsPanelData({ route, counts, snapshot, embedded }: { route: Route; counts: Counts | null; snapshot?: ClientSnapshot | null; embedded?: boolean }) {
  return <SettingsPanel route={route} counts={counts} snapshot={snapshot} embedded={embedded} />;
}
