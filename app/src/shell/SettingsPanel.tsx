import { TextAction } from "../ds/Button";
import { useResource } from "../screens/settings/shared";
import type { RoutingRules } from "../model/executors";
import type { StrategyRow } from "../model/strategy";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import type { Counts } from "../../../src/api/read-model/types";
import { withQuery, type Route } from "../router";
/** 220 px panel beside the rail while any settings screen is open. */
export function SettingsPanel({ route, counts, snapshot, badges = {} }: { route: Route; counts: Counts | null; snapshot?: ClientSnapshot | null; badges?: Record<string, string | number> }) {
  const hosts = snapshot?.hosts ? snapshot.hosts.filter(host => host.state === "needs_setup").length : counts?.hostsWithProblems ?? 0;
  const down = snapshot?.executors?.filter(e => e.state === "down" || e.state === "failing").length ?? 0;
  badges = { ...badges, ...(snapshot?.accounts ? {accounts:snapshot.accounts.length} : {}), executors:down ? `${down} down` : "" };
  const item = (href: string, label: string, on: boolean, badge: string | number = "", tone = "neutral") =>
    <TextAction className={`pc-panel__item${on ? " on" : ""}`} href={withQuery(href, route.query)} aria-current={on ? "page" : undefined}>{label}{badge !== "" && <span className={`pc-rail__badge pc-rail__badge--${tone}`} aria-label={String(badge)}>{badge}</span>}</TextAction>;
  return <aside className="pc-panel" aria-label="Settings">
    {item("#/settings", "General", route.name === "settings" && !route.section)}
    {([['planner','Planner & pacing'],['accounts','Accounts'],['executors','Executors'],['hosts','Remote hosts'],['routing','Routing'],['strategies','Strategies'],['updates','Updates'],['notifications','Notifications'],['appearance','Appearance'],['diagnostics','Diagnostics']] as const).map(([section,label])=>item(`#/settings/${section}`,label,section==='hosts'?route.name==='hosts':route.name==='settings'&&route.section===section,section==='hosts'?(hosts ? `${hosts} needs setup` : ''):badges[section] ?? '',section==='hosts'?'warn':section==='executors'?'bad':'neutral'))}
    {item("#/settings/add-executor", "Add executor", route.name === "add-executor")}
  </aside>;
}

export function SettingsPanelData({ route, counts, snapshot }: { route: Route; counts: Counts | null; snapshot?: ClientSnapshot | null }) {
  const routing = useResource<RoutingRules>("routing.get"), strategies = useResource<StrategyRow[]>("strategy.list");
  return <SettingsPanel route={route} counts={counts} snapshot={snapshot} badges={{routing:routing.data ? `${routing.data.rules.length} ${routing.data.rules.length === 1 ? "rule" : "rules"}` : "",strategies:strategies.data?.length ?? ""}} />;
}
