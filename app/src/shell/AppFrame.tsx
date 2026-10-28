import type { ComponentChildren } from "preact";
import { TextAction } from "../ds/Button";

/**
 * The one window frame: top bar, activity rail, optional side panels around the work area, an optional bottom dock
 * and the status bar. Narrow layouts keep the touch order (bottom navigation first, header inside the work area)
 * and never show a right panel or a dock.
 */
export function AppFrame({ top, activity, left, main, right, dock, status, narrow = false, live, mainClass = "pc-main" }: {
  top?: ComponentChildren; activity?: ComponentChildren; left?: ComponentChildren; main: ComponentChildren;
  right?: ComponentChildren; dock?: ComponentChildren; status?: ComponentChildren; narrow?: boolean;
  /** Polite announcements above the main landmark, such as a lost connection. */
  live?: ComponentChildren; mainClass?: string;
}) {
  const docked = !narrow && !!dock;
  return <div className={`pc-app${narrow ? " pc-app--narrow" : ""}${status ? " pc-app--with-status" : ""}${docked ? " pc-app--with-dock" : ""}`}>
    <TextAction href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</TextAction>
    {!narrow && top}
    {narrow && activity}
    <div className="pc-body">
      {!narrow && activity}
      {left}
      <div className="pc-work">
        {narrow && top}
        <div aria-live="polite" role="status" className="pc-live-region">{live}</div>
        <main id="main-content" tabIndex={-1} className={mainClass}>{main}</main>
      </div>
      {!narrow && right}
    </div>
    {docked && <div className="pc-dock">{dock}</div>}
    {status}
  </div>;
}
