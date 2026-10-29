import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { keys } from "../keys/instance";
import type { RouteQuery } from "../router";
import { TerminalScreen } from "../screens/terminal/Terminal";

export const DOCK_ID = "pc-terminal-dock";
/** Panel height is a local preference, clamped to the centre column’s work area. */
export function TerminalDock({ query, close, folder }: { query: RouteQuery; close: () => void; folder?: string | null }) {
  const panel = useRef<HTMLElement>(null);
  const [height, setHeight] = useState(() => { try { const n = Number(localStorage.getItem("pacer.terminal.height")); return Number.isFinite(n) && n >= 120 ? n : 260; } catch { return 260; } });
  const [area, setArea] = useState(836);
  const [maximized, setMaximized] = useState(false);
  useLayoutEffect(() => {
    const app = panel.current?.closest<HTMLElement>(".pc-app");
    if (!app) return;
    const measure = () => setArea(app.clientHeight - parseFloat(getComputedStyle(app).paddingBottom) - (app.querySelector(".pc-topbar")?.getBoundingClientRect().height ?? 36));
    measure(); const observer = new ResizeObserver(measure); observer.observe(app); return () => observer.disconnect();
  }, []);
  const max = Math.max(120, Math.floor(area * .8));
  const value = maximized ? Math.round(area) : Math.max(120, Math.min(max, height));
  const change = (next: number) => { const clamped = Math.max(120, Math.min(max, next)); setMaximized(false); setHeight(clamped); try { localStorage.setItem("pacer.terminal.height", String(clamped)); } catch { /* memory fallback */ } };
  return <section ref={panel} id={DOCK_ID} className={`pc-dock__panel${maximized ? " pc-dock__panel--maximized" : ""}`} style={{ flexGrow: value / Math.max(1, area - value) }} tabIndex={-1} aria-label="Terminal panel"
    onKeyDownCapture={event => { if (event.ctrlKey && keys.handle(event)) event.stopPropagation(); }}>
    <div className="pc-terminal-sash" role="separator" aria-label="Resize terminal panel" aria-orientation="horizontal" aria-valuemin={120} aria-valuemax={maximized ? Math.round(area) : max} aria-valuenow={Math.round(value)} tabIndex={0} title="Drag to resize · double-click to restore"
      onDblClick={() => change(260)} onKeyDown={event => { const next = event.key === "ArrowUp" ? value + 16 : event.key === "ArrowDown" ? value - 16 : event.key === "Home" ? 120 : event.key === "End" ? max : null; if (next !== null) { event.preventDefault(); change(next); } }}
      onPointerDown={event => { if (event.button !== 0) return; const target = event.currentTarget; target.setPointerCapture(event.pointerId); event.preventDefault(); }}
      onPointerMove={event => { if (event.currentTarget.hasPointerCapture(event.pointerId) && panel.current) change(panel.current.getBoundingClientRect().bottom - event.clientY); }}
      onPointerUp={event => { if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId); }} />
    <TerminalScreen embedded query={query} folder={folder ?? undefined} closePanel={close} maximize={() => setMaximized(!maximized)} maximized={maximized} />
  </section>;
}
