import { IconButton } from "../ds/Button";
import { keys } from "../keys/instance";
import type { RouteQuery } from "../router";
import { TerminalScreen } from "../screens/terminal/Terminal";

export const DOCK_ID = "pc-terminal-dock";
/**
 * The workspace terminal below the work area. Ctrl shortcuts are offered to the registry while the event is still
 * capturing, because a terminal with control stops keys from bubbling to the window.
 */
export function TerminalDock({ query, close }: { query: RouteQuery; close: () => void }) {
  return <section id={DOCK_ID} className="pc-dock__panel" tabIndex={-1} aria-label="Terminal panel"
    onKeyDownCapture={event => { if (event.ctrlKey && keys.handle(event)) event.stopPropagation(); }}>
    <div className="pc-dock__bar"><strong>Terminal</strong><IconButton size="sm" variant="quiet" aria-label="Hide terminal panel" title="Hide terminal panel" onClick={close}>×</IconButton></div>
    <div className="pc-dock__body"><TerminalScreen embedded query={query} /></div>
  </section>;
}
