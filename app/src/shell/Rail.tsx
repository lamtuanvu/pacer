import type { Counts } from "../../../src/api/read-model/types";
import { Mark } from "../ds/Mark";
import { Tooltip } from "../ds/Tooltip";
import { Icon, type IconName } from "../ds/icons";
import { withQuery, type Route } from "../router";

const ITEMS: { name: "overview" | "review" | "sessions"; label: string; href: string; icon: IconName; count: (c: Counts) => number; words: string; tone: "warn" | "info" }[] = [
  { name: "overview", label: "Overview", href: "#/", icon: "overview", count: c => c.attention, words: "need you", tone: "warn" },
  { name: "review", label: "Review", href: "#/review", icon: "review", count: c => c.review, words: "waiting", tone: "warn" },
  { name: "sessions", label: "Sessions", href: "#/sessions", icon: "sessions", count: c => c.running, words: "running", tone: "info" },
];
const SETTINGS = new Set(["settings", "hosts", "add-executor"]);
/** 56 px icon rail. Badges and the gear dot come from the service's counts only. */
export function Rail({ route, counts }: { route: Route; counts: Counts | null }) {
  const setupOpen = (counts?.setupOpen ?? 0) > 0;
  return <nav className="pc-rail" aria-label="pacer">
    <a className="pc-rail__mark" href={withQuery("#/", route.query)} aria-label="pacer home"><Mark size={22} wordmark={false} /></a>
    <span className="pc-rail__divider" />
    {ITEMS.map(item => {
      const n = counts ? item.count(counts) : 0;
      const label = n > 0 ? `${item.label} · ${n} ${item.words}` : item.label;
      return <Tooltip key={item.name} text={label}>
        <a className={`pc-rail__item${route.name === item.name ? " on" : ""}`} href={withQuery(item.href, route.query)} aria-label={label} aria-current={route.name === item.name ? "page" : undefined}>
          <Icon name={item.icon} />{n > 0 && <span className={`pc-rail__badge pc-rail__badge--${item.tone}`} aria-hidden="true">{n}</span>}
        </a>
      </Tooltip>;
    })}
    <span className="grow" />
    <Tooltip text={setupOpen ? "Settings · setup needs you" : "Settings"}>
      <a className={`pc-rail__item${SETTINGS.has(route.name) ? " on" : ""}`} href="#/settings" aria-label={setupOpen ? "Settings · setup needs you" : "Settings"} aria-current={SETTINGS.has(route.name) ? "page" : undefined}>
        <Icon name="settings" />{setupOpen && <span className="pc-rail__dot" aria-hidden="true" />}
      </a>
    </Tooltip>
  </nav>;
}
