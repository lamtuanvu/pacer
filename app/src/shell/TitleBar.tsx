import { useContext, useEffect, useState } from "preact/hooks";
import { SetupContext } from "../screens/setup/context";
import type { Counts } from "../../../src/api/read-model/types";
import { Mark } from "../ds/Mark";
import { Tooltip } from "../ds/Tooltip";
import { Icon, type IconName } from "../ds/icons";
import { TextAction } from "../ds/Button";
import { TrafficLights } from "../ds/TrafficLights";
import { withQuery, type Route } from "../router";
import { windowControls } from "../data/desktop";
const ITEMS: { name: "start" | "overview" | "review" | "sessions"; label: string; href: string; icon: IconName; count: (c: Counts) => number; words: string; tone: "warn" | "info" }[] = [
  { name: "start", label: "Start work", href: "#/", icon: "tasks", count: () => 0, words: "running", tone: "info" },
  { name: "overview", label: "Overview", href: "#/overview", icon: "overview", count: () => 0, words: "need you", tone: "warn" },
  { name: "review", label: "Needs you", href: "#/needs-you", icon: "review", count: c => c.attention, words: "need you", tone: "warn" },
  { name: "sessions", label: "Tasks", href: "#/tasks", icon: "sessions", count: c => c.running, words: "running", tone: "info" },
];
const SETTINGS = new Set(["settings", "hosts", "add-executor"]);
/** 56 px unified titlebar: traffic lights + nav + optional controls. */
export function TitleBar({ route, counts }: { route: Route; counts: Counts | null }) {
  const { checklist } = useContext(SetupContext);
  const setupOpen = checklist ? !checklist.complete : (counts?.setupOpen ?? 0) > 0;
  const showSetup = checklist ? !checklist.ready : setupOpen;
  const [desktop, setDesktop] = useState(false);
  const [controls] = useState(() => windowControls());
  useEffect(() => {
    setDesktop(controls.desktop);
  }, [controls]);
  return (
    <header className="pc-titlebar" data-tauri-drag-region>
      {/* macOS traffic lights area - always reserve space even in browser */}
      <div className="pc-titlebar__traffic">
        <TrafficLights
          desktop={desktop}
          onClose={() => void controls.close()}
          onMinimize={() => void controls.minimize()}
          onMaximize={() => void controls.toggleMaximize()}
        />
      </div>
      {/* Divider after traffic */}
      <div className="pc-titlebar__divider" aria-hidden="true" />
      {/* Navigation items */}
      <nav className="pc-titlebar__nav" aria-label="pacer navigation">
        <TextAction className="pc-titlebar__mark" href={withQuery("#/", route.query)} aria-label="pacer home">
          <Mark size={20} wordmark={false} />
        </TextAction>
        <div className="pc-titlebar__nav-divider" aria-hidden="true" />
        {ITEMS.map(item => {
          const n = counts ? item.count(counts) : 0;
          const label = n > 0 ? `${item.label} · ${n} ${item.words}` : item.label;
          return (
            <Tooltip key={item.name} text={label}>
              <TextAction
                className={`pc-titlebar__item${route.name === item.name ? " on" : ""}`}
                href={withQuery(item.href, route.query)}
                aria-label={label}
                aria-current={route.name === item.name ? "page" : undefined}
              >
                <Icon name={item.icon} />
                {n > 0 && (
                  <span className={`pc-titlebar__badge pc-titlebar__badge--${item.tone}`} aria-hidden="true">
                    {n}
                  </span>
                )}
              </TextAction>
            </Tooltip>
          );
        })}
      </nav>
      {/* Right side: spacer then secondary items */}
      <span className="pc-titlebar__grow" />
      <nav className="pc-titlebar__nav" aria-label="pacer secondary">
        {showSetup && (
          <Tooltip text={setupOpen ? "Setup · needs you" : "Setup"}>
            <TextAction
              className={`pc-titlebar__item${route.name === "setup" ? " on" : ""}`}
              href={withQuery("#/setup", route.query)}
              aria-label={setupOpen ? "Setup · needs you" : "Setup"}
              aria-current={route.name === "setup" ? "page" : undefined}
            >
              <Icon name="tasks" />
              {setupOpen && <span className="pc-titlebar__dot" aria-hidden="true" />}
            </TextAction>
          </Tooltip>
        )}
        <Tooltip text="Settings">
          <TextAction
            className={`pc-titlebar__item${SETTINGS.has(route.name) ? " on" : ""}`}
            href={withQuery("#/settings", route.query)}
            aria-label="Settings"
            aria-current={SETTINGS.has(route.name) ? "page" : undefined}
          >
            <Icon name="settings" />
          </TextAction>
        </Tooltip>
      </nav>
    </header>
  );
}
