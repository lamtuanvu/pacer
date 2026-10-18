import type { Counts } from "../../../src/api/read-model/types";
import type { Route } from "../router";
/** 220 px panel beside the rail while any settings screen is open. */
export function SettingsPanel({ route, counts }: { route: Route; counts: Counts | null }) {
  const hosts = counts?.hostsWithProblems ?? 0;
  const item = (href: string, label: string, on: boolean, badge = 0) =>
    <a className={`pc-panel__item${on ? " on" : ""}`} href={href} aria-current={on ? "page" : undefined}>{label}{badge > 0 && <span className="pc-rail__badge pc-rail__badge--warn" aria-label={`${badge} with a problem`}>{badge}</span>}</a>;
  return <aside className="pc-panel" aria-label="Settings">
    <h2>Settings</h2>
    {item("#/settings", "General", route.name === "settings" && !route.section)}
    {([['planner','Planner & pacing'],['accounts','Accounts'],['executors','Executors'],['routing','Routing'],['strategies','Strategies'],['updates','Updates & plugin'],['notifications','Notifications'],['appearance','Appearance']] as const).map(([section,label])=>item(`#/settings/${section}`,label,route.name==='settings'&&route.section===section))}
    {item("#/settings/hosts", "Remote hosts", route.name === "hosts", hosts)}
    {item("#/settings/add-executor", "Add executor", route.name === "add-executor")}
  </aside>;
}
