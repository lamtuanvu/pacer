import { PluginContext } from "../plugins/catalog";
import { PLUGIN_ICONS } from "../plugins/icons";
import { AppLink } from "../navigation";
import { useContext } from "preact/hooks";
import { SetupContext } from "../screens/setup/context";
import type { Counts } from "../../../src/api/read-model/types";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { Tooltip } from "../ds/Tooltip";
import { Icon, type IconName } from "../ds/icons";
import { primaryFor, routes, type Route, type RouteTarget } from "../router";
import { StrategyQuickAccess } from "./StrategyQuickAccess";

const ITEMS: { name: "insights" | "dispatch" | "review" | "sessions" | "terminal"; label: string; to: RouteTarget; icon: IconName; count: (c: Counts) => number; words: string; tone: "warn" | "info" }[] = [
  { name: "dispatch", label: "Dispatch", to: routes.dispatch(), icon: "activity-dispatch", count: () => 0, words: "", tone: "info" },
  { name: "review", label: "Needs you", to: routes.needsYou(), icon: "needs-you", count: c => c.attention, words: "items", tone: "warn" },
  { name: "sessions", label: "Tasks", to: routes.tasks(), icon: "task-checklist", count: () => 0, words: "running", tone: "info" },
  { name: "insights", label: "Insights", to: routes.insights(), icon: "activity-insights", count: () => 0, words: "", tone: "info" },
  { name: "terminal", label: "Terminal", to: routes.terminal(), icon: "activity-terminal", count: () => 0, words: "", tone: "info" },
];
const SETTINGS = new Set(["settings", "hosts", "add-executor"]);
const EXECUTOR_PROBLEMS = new Set(["failing", "down", "blocked", "exhausted"]);
/** Enabled executors that cannot take work; the Settings item says how many. */
export const settingsAttention = (snapshot: ClientSnapshot | null): number => snapshot?.executors?.filter(e => e.enabled && EXECUTOR_PROBLEMS.has(e.state)).length ?? 0;
/** 52 px desktop activity bar; touch-sized bottom navigation on narrow screens. Setup readiness comes from the shared service checklist. */
export function Rail({ route, counts, narrow = false, settingsAttention: attention = 0, terminal }: { route: Route; counts: Counts | null; narrow?: boolean; settingsAttention?: number; terminal?: {open: boolean; toggle: () => void} }) {
  const { surfaces } = useContext(PluginContext);
  const { checklist } = useContext(SetupContext);
  const setupOpen = checklist ? !checklist.complete : (counts?.setupOpen ?? 0) > 0;
  const showSetup = checklist ? !checklist.ready : setupOpen;
  const settingsLabel = attention ? `Settings, ${attention} ${attention === 1 ? "agent needs" : "agents need"} attention` : "Settings";
  return <nav className={narrow ? "pc-bottom-bar" : "pc-rail"} aria-label="pacer">
    {ITEMS.filter(item => !narrow || item.name !== "terminal").map(item => {
      const n = counts && !(narrow && item.name === "sessions") ? item.count(counts) : 0;
      const label = item.name === "terminal" ? "Terminal panel (Ctrl+`)" : n > 0 ? `${item.label}, ${n} ${item.words}` : item.label;
      return <Tooltip key={item.name} text={item.name === "terminal" ? "Terminal panel" : label} shortcut={item.name === "terminal" ? "Ctrl+`" : undefined}>
        <AppLink className={`pc-rail__item${primaryFor(route) === item.name ? " on" : ""}`} to={item.to} query={route.query} aria-label={label} onClick={item.name === "terminal" && terminal ? event => {event.preventDefault(); terminal.toggle();} : undefined} aria-expanded={item.name === "terminal" ? terminal?.open : undefined} aria-current={primaryFor(route) === item.name ? "page" : undefined}>
          <Icon name={item.icon} />{narrow && <span>{item.label}</span>}{n > 0 && <span className={`pc-rail__badge pc-rail__badge--${item.tone}${item.tone === "warn" ? " pc-rail__badge--count" : ""}`} aria-hidden="true">{n}</span>}
        </AppLink>
      </Tooltip>;
    })}
    {!narrow && <><span className="pc-rail__divider" /><div role="group" aria-labelledby="rail-plugins" className="pc-rail__plugins"><span id="rail-plugins" className="pc-rail__plugins-label">Plugins</span>
      {surfaces.filter(s => s.surface === "activity" && s.visible).map(s => {
        const active = route.name === "plugin" && route.plugin === s.plugin && route.id === s.id;
        const label = `${s.title} (plugin)`;
        return <Tooltip key={`${s.plugin}/${s.id}`} text={label}><AppLink className={`pc-rail__item${active ? " on" : ""}`} to={routes.plugin(s.plugin, s.id)} query={route.query} aria-label={label} aria-current={active ? "page" : undefined}><Icon name={s.icon === "check-square" ? "plugin-checklist" : PLUGIN_ICONS[s.icon as keyof typeof PLUGIN_ICONS] ?? "plugin"} /></AppLink></Tooltip>;
      })}
      <Tooltip text="Add a plugin"><AppLink className="pc-rail__item pc-rail__add-plugin" to={routes.settings("plugins")} query={route.query} aria-label="Add a plugin"><Icon name="add-plugin" /></AppLink></Tooltip>
      </div><span className="grow" /></>}
    {!narrow && showSetup && <Tooltip text={setupOpen ? "Setup · needs you" : "Setup"}><AppLink className={`pc-rail__item${route.name === "setup" ? " on" : ""}`} to={routes.setup()} query={route.query} aria-label={setupOpen ? "Setup · needs you" : "Setup"} aria-current={route.name === "setup" ? "page" : undefined}><Icon name="tasks" />{setupOpen && <span className="pc-rail__dot" aria-hidden="true" />}</AppLink></Tooltip>}

    <Tooltip text={settingsLabel}>
      <AppLink className={`pc-rail__item${SETTINGS.has(route.name) ? " on" : ""}`} to={routes.settings()} query={route.query} aria-label={settingsLabel} aria-current={SETTINGS.has(route.name) ? "page" : undefined}>
        <Icon name="settings" />{narrow && <span>Settings</span>}{attention > 0 && <span className="pc-rail__dot" aria-hidden="true" />}
      </AppLink>
    </Tooltip>
  </nav>;
}
