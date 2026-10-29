import { useLayoutEffect, useRef } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { TextAction } from "../ds/Button";

/**
 * The one window frame: top bar, activity rail, optional side panels around the work area, an optional bottom dock
 * and the status bar. Narrow layouts keep the touch order (bottom navigation first, header inside the work area)
 * and never show a right panel or a dock.
 */
export function AppFrame({ top, activity, left, main, right, dock, status, overlay, narrow = false, live, mainClass = "pc-main" }: {
  top?: ComponentChildren; activity?: ComponentChildren; left?: ComponentChildren; main: ComponentChildren;
  right?: ComponentChildren; dock?: ComponentChildren; status?: ComponentChildren; narrow?: boolean;
  /** Floats over the work area, above the dock and status bar, such as the assistant sheet. */
  overlay?: ComponentChildren;
  /** Polite announcements above the main landmark, such as a lost connection. */
  live?: ComponentChildren; mainClass?: string;
}) {
  const docked = !narrow && !!dock;
  const frame = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = frame.current;
    if (!root) return;
    let dock: HTMLElement | null = null, sessionHeader: HTMLElement | null = null;
    const measureDock = () => {
      root.style.setProperty("--pc-dock-height", `${dock?.getBoundingClientRect().height ?? 0}px`);
      const body = root.querySelector(".pc-body");
      root.style.setProperty("--pc-assistant-header-height", `${sessionHeader && body ? Math.max(0, sessionHeader.getBoundingClientRect().bottom - body.getBoundingClientRect().top) : 0}px`);
    };
    const observer = new ResizeObserver(measureDock);
    const observeDock = () => {
      const next = root.querySelector<HTMLElement>(":scope > .pc-dock > .pc-dock__panel");
      if (next !== dock) {
        if (dock) observer.unobserve(dock);
        dock = next;
        if (dock) observer.observe(dock);
      }
      const header = root.querySelector<HTMLElement>(".pc-session-bar");
      if (header !== sessionHeader) {
        if (sessionHeader) observer.unobserve(sessionHeader);
        sessionHeader = header;
        if (sessionHeader) observer.observe(sessionHeader);
      }
      measureDock();
    };
    observeDock();
    const children = new MutationObserver(observeDock);
    children.observe(root, { childList: true, subtree: true });
    return () => { children.disconnect(); observer.disconnect(); };
  }, [docked]);
  const work = <div className="pc-work">
    {narrow && top}
    <div aria-live="polite" role="status" className="pc-live-region">{live}</div>
    <main id="main-content" tabIndex={-1} className={mainClass}>{main}</main>
  </div>;
  return <div ref={frame} className={`pc-app${narrow ? " pc-app--narrow" : ""}${status ? " pc-app--with-status" : ""}${docked ? " pc-app--with-dock" : ""}`}>
    <TextAction href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</TextAction>
    {!narrow && top}
    {narrow && activity}
    <div className="pc-body">
      {!narrow && activity}
      {left}
      {overlay ? <div className="pc-work-wrap">{work}{overlay}</div> : work}
      {!narrow && right}
    </div>
    {docked && <div className="pc-dock">{dock}</div>}
    {status}
  </div>;
}
