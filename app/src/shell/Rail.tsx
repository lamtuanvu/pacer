import { TextAction } from "../ds/Button";
import { useContext } from "preact/hooks";
import { SetupContext } from "../screens/setup/context";
import type { Counts } from "../../../src/api/read-model/types";
import { Mark } from "../ds/Mark";
import { Tooltip } from "../ds/Tooltip";
import { Icon, type IconName } from "../ds/icons";
import { withQuery, type Route } from "../router";

const ITEMS: { name: "overview" | "review" | "sessions"; label: string; href: string; icon: IconName; count: (c: Counts) => number; words: string; tone: "warn" | "info" }[] = [
  { name: "overview", label: "Overview", href: "#/", icon: "overview", count: () => 0, words: "need you", tone: "warn" },
  { name: "review", label: "Needs you", href: "#/needs-you", icon: "review", count: c => c.attention, words: "need you", tone: "warn" },
  { name: "sessions", label: "Tasks", href: "#/tasks", icon: "sessions", count: c => c.running, words: "running", tone: "info" },
];
const SETTINGS = new Set(["settings", "hosts", "add-executor"]);
/** 56 px icon rail. Setup readiness comes from the shared service checklist. */
export function Rail({ route, counts, narrow = false }: { route: Route; counts: Counts | null; narrow?: boolean }) {
  const { checklist } = useContext(SetupContext);
  const setupOpen = checklist ? !checklist.complete : (counts?.setupOpen ?? 0) > 0;
  const showSetup = checklist ? !checklist.ready : setupOpen;
  return <nav className={narrow ? "pc-bottom-bar" : "pc-rail"} aria-label="pacer">
    {!narrow && <TextAction className="pc-rail__mark" href={withQuery("#/", route.query)} aria-label="pacer home"><Mark size={22} wordmark={false} /></TextAction>}
    {!narrow && <span className="pc-rail__divider" />}
    {ITEMS.map(item => {
      const n = counts ? item.count(counts) : 0;
      const label = n > 0 ? `${item.label} · ${n} ${item.words}` : item.label;
      return <Tooltip key={item.name} text={label}>
        <TextAction className={`pc-rail__item${route.name === item.name ? " on" : ""}`} href={withQuery(item.href, route.query)} aria-label={label} aria-current={route.name === item.name ? "page" : undefined}>
          <Icon name={item.icon} />{n > 0 && <span className={`pc-rail__badge pc-rail__badge--${item.tone}`} aria-hidden="true">{n}</span>}
        </TextAction>
      </Tooltip>;
    })}
    {!narrow && <span className="grow" />}
    {showSetup && <Tooltip text={setupOpen ? "Setup · needs you" : "Setup"}><TextAction className={`pc-rail__item${route.name === "setup" ? " on" : ""}`} href={withQuery("#/setup", route.query)} aria-label={setupOpen ? "Setup · needs you" : "Setup"} aria-current={route.name === "setup" ? "page" : undefined}><Icon name="tasks" />{setupOpen && <span className="pc-rail__dot" aria-hidden="true" />}</TextAction></Tooltip>}
    <Tooltip text="Settings">
      <TextAction className={`pc-rail__item${SETTINGS.has(route.name) ? " on" : ""}`} href={withQuery("#/settings", route.query)} aria-label="Settings" aria-current={SETTINGS.has(route.name) ? "page" : undefined}>
        <Icon name="settings" />
      </TextAction>
    </Tooltip>
  </nav>;
}
