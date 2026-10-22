import { AppLink } from "../navigation";
import { useContext } from "preact/hooks";
import { SetupContext } from "../screens/setup/context";
import type { Counts } from "../../../src/api/read-model/types";
import { Mark } from "../ds/Mark";
import { Tooltip } from "../ds/Tooltip";
import { Icon, type IconName } from "../ds/icons";
import { primaryFor, routes, type Route, type RouteTarget } from "../router";

const ITEMS: { name: "start" | "overview" | "review" | "sessions"; label: string; to: RouteTarget; icon: IconName; count: (c: Counts) => number; words: string; tone: "warn" | "info" }[] = [
  { name: "start", label: "Start work", to: routes.start(), icon: "tasks", count: () => 0, words: "running", tone: "info" },
  { name: "overview", label: "Overview", to: routes.overview(), icon: "overview", count: () => 0, words: "need you", tone: "warn" },
  { name: "review", label: "Needs you", to: routes.needsYou(), icon: "review", count: c => c.attention, words: "need you", tone: "warn" },
  { name: "sessions", label: "Tasks", to: routes.tasks(), icon: "sessions", count: c => c.running, words: "running", tone: "info" },
];
const SETTINGS = new Set(["settings", "hosts", "add-executor"]);
/** 56 px icon rail. Setup readiness comes from the shared service checklist. */
export function Rail({ route, counts, narrow = false }: { route: Route; counts: Counts | null; narrow?: boolean }) {
  const { checklist } = useContext(SetupContext);
  const setupOpen = checklist ? !checklist.complete : (counts?.setupOpen ?? 0) > 0;
  const showSetup = checklist ? !checklist.ready : setupOpen;
  return <nav className={narrow ? "pc-bottom-bar" : "pc-rail"} aria-label="pacer">
    {!narrow && <AppLink className="pc-rail__mark" to={routes.overview()} query={route.query} aria-label="pacer home"><Mark size={22} wordmark={false} /></AppLink>}
    {!narrow && <span className="pc-rail__divider" />}
    {ITEMS.map(item => {
      const n = counts ? item.count(counts) : 0;
      const label = n > 0 ? `${item.label} · ${n} ${item.words}` : item.label;
      return <Tooltip key={item.name} text={label}>
        <AppLink className={`pc-rail__item${primaryFor(route) === item.name ? " on" : ""}`} to={item.to} query={route.query} aria-label={label} aria-current={primaryFor(route) === item.name ? "page" : undefined}>
          <Icon name={item.icon} />{n > 0 && <span className={`pc-rail__badge pc-rail__badge--${item.tone}`} aria-hidden="true">{n}</span>}
        </AppLink>
      </Tooltip>;
    })}
    {!narrow && <span className="grow" />}
    {showSetup && <Tooltip text={setupOpen ? "Setup · needs you" : "Setup"}><AppLink className={`pc-rail__item${route.name === "setup" ? " on" : ""}`} to={routes.setup()} query={route.query} aria-label={setupOpen ? "Setup · needs you" : "Setup"} aria-current={route.name === "setup" ? "page" : undefined}><Icon name="tasks" />{setupOpen && <span className="pc-rail__dot" aria-hidden="true" />}</AppLink></Tooltip>}
    <Tooltip text="Settings">
      <AppLink className={`pc-rail__item${SETTINGS.has(route.name) ? " on" : ""}`} to={routes.settings()} query={route.query} aria-label="Settings" aria-current={SETTINGS.has(route.name) ? "page" : undefined}>
        <Icon name="settings" />
      </AppLink>
    </Tooltip>
  </nav>;
}
