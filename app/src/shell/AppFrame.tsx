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
    let dock: HTMLElement | null = null, sessionHeader: HTMLElement | null = null, workHeader: HTMLElement | null = null, topBar: HTMLElement | null = null;
    const measureDock = () => {
      root.style.setProperty("--pc-dock-height", `${dock?.getBoundingClientRect().height ?? 0}px`);
      root.style.setProperty("--pc-work-header-height", `${workHeader?.getBoundingClientRect().height ?? 0}px`);
      root.style.setProperty("--pc-frame-header-height", `${topBar?.getBoundingClientRect().height ?? 0}px`);
      const body = root.querySelector(".pc-body");
      root.style.setProperty("--pc-assistant-header-height", `${sessionHeader && body ? Math.max(0, sessionHeader.getBoundingClientRect().bottom - body.getBoundingClientRect().top) : 0}px`);
    };
    const observer = new ResizeObserver(measureDock);
    const observeDock = () => {
      const nextTopBar = root.querySelector<HTMLElement>(".pc-topbar");
      if (nextTopBar !== topBar) {
        if (topBar) observer.unobserve(topBar);
        topBar = nextTopBar;
        if (topBar) observer.observe(topBar);
      }
      const next = root.querySelector<HTMLElement>(".pc-work-wrap > .pc-dock > .pc-offline-controls > .pc-dock__panel");
      if (next !== dock) {
        if (dock) observer.unobserve(dock);
        dock = next;
        if (dock) observer.observe(dock);
      }
      const header = root.querySelector<HTMLElement>(".pc-session-bar, .pc-main .pc-page > header, .pc-main .pc-page-header");
      if (header !== sessionHeader) {
        if (sessionHeader) observer.unobserve(sessionHeader);
        sessionHeader = header;
        if (sessionHeader) observer.observe(sessionHeader);
      }
      const top = root.querySelector<HTMLElement>(".pc-work > .pc-topbar");
      if (top !== workHeader) {
        if (workHeader) observer.unobserve(workHeader);
        workHeader = top;
        if (workHeader) observer.observe(workHeader);
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
    {narrow && <div aria-live="polite" role="status" className="pc-live-region">{live}</div>}
    <main id="main-content" tabIndex={-1} className={mainClass}><fieldset className="pc-offline-controls" disabled={!!live} title={live ? "pacer is offline" : undefined} aria-label={live ? "pacer is offline" : undefined}>{main}</fieldset></main>
  </div>;
  return <div ref={frame} className={`pc-app${narrow ? " pc-app--narrow" : ""}${status ? " pc-app--with-status" : ""}${docked ? " pc-app--with-dock" : ""}${live ? " pc-app--offline" : ""}`}>
    <TextAction href="#main-content" className="skip-link" onClick={event => { event.preventDefault(); document.getElementById("main-content")?.focus(); }}>Skip to content</TextAction>
    {!narrow && top}
    {!narrow && <div aria-live="polite" role="status" className="pc-live-region">{live}</div>}
    {narrow && activity}
    <div className="pc-body">
      {!narrow && activity}
      {left}
      {<div className="pc-work-wrap">{work}{docked && <div className="pc-dock"><fieldset className="pc-offline-controls" disabled={!!live} title={live ? "pacer is offline" : undefined} aria-label={live ? "pacer is offline" : undefined}>{dock}</fieldset></div>}{overlay && <fieldset className="pc-offline-controls" disabled={!!live} title={live ? "pacer is offline" : undefined} aria-label={live ? "pacer is offline" : undefined}>{overlay}</fieldset>}</div>}
      {!narrow && right}
    </div>
    {status}
  </div>;
}
