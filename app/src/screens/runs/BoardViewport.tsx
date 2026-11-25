/** A pannable, zoomable SVG board: pointer drag, Ctrl/Cmd wheel, keyboard and toolbar all go through the same view math. */
import { useEffect, useRef, useState } from "preact/hooks";
import type { ComponentChildren } from "preact";
import { Button } from "../../ds/Button";
import { fitView, keyAction, panBy, zoomAt, ZOOM_STEP, type BoardKeyAction, type BoardView } from "./live-board-view";

const FALLBACK_VIEWPORT = { width: 960, height: 540 };

export function BoardViewport({ content, resetKey, markerId, ariaLabel, children }: {
  content: { width: number; height: number };
  /** The view fits once per key (a run); later refreshes keep the view the person set. */
  resetKey: string;
  markerId: string;
  ariaLabel: string;
  children: ComponentChildren;
}) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);
  const fittedFor = useRef<string | null>(null);
  const [view, setView] = useState<BoardView>({ x: 0, y: 0 , k: 1 });
  const [dragging, setDragging] = useState(false);
  const [announce, setAnnounce] = useState("");

  const size = () => {
    const r = viewportRef.current?.getBoundingClientRect?.();
    return r && r.width > 0 && r.height > 0 ? { width: r.width, height: r.height } : FALLBACK_VIEWPORT;
  };
  const fit = () => { setView(fitView(content, size())); setAnnounce("Board fitted to the window"); };
  useEffect(() => {
    if (fittedFor.current !== resetKey) { fittedFor.current = resetKey; setView(fitView(content, size())); }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fit once per key
  }, [resetKey, content.width, content.height]);

  const act = (a: BoardKeyAction | null) => {
    if (!a) return;
    if (a.type === "pan") { setView(v => panBy(v, a.dx, a.dy)); return; }
    if (a.type === "fit") { fit(); return; }
    const s = size();
    setView(v => {
      const next = zoomAt(v, a.factor, s.width / 2, s.height / 2);
      if (next !== v) setAnnounce(`Zoom ${Math.round(next.k * 100)}%`);
      return next;
    });
  };
  const onKeyDown = (e: KeyboardEvent) => {
    const a = keyAction(e);
    if (!a) return;
    e.preventDefault();
    act(a);
  };
  const isAgentTarget = (t: EventTarget | null) => !!(t as Element | null)?.closest?.("[data-agent]");
  const onPointerDown = (e: PointerEvent) => {
    if ((e.button ?? 0) !== 0 || isAgentTarget(e.target)) return;
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDragging(true);
  };
  const onPointerMove = (e: PointerEvent) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x, dy = e.clientY - d.y;
    drag.current = { ...d, x: e.clientX, y: e.clientY };
    setView(v => panBy(v, dx, dy));
  };
  const endDrag = (e: PointerEvent) => {
    if (drag.current?.id !== e.pointerId) return;
    drag.current = null;
    setDragging(false);
  };
  const onWheel = (e: WheelEvent) => {
    // A plain wheel scrolls the page; a pinch or Ctrl/Cmd wheel zooms at the pointer.
    if (!(e.ctrlKey || e.metaKey)) return;
    e.preventDefault();
    const r = viewportRef.current?.getBoundingClientRect?.();
    setView(v => zoomAt(v, e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP, e.clientX - (r?.left ?? 0), e.clientY - (r?.top ?? 0)));
  };
  const pct = Math.round(view.k * 100);
  return (
    <>
      <div className="lb-toolbar" role="group" aria-label="Board view">
        <Button size="sm" onClick={() => act({ type: "zoom", factor: 1 / ZOOM_STEP })}>Zoom out</Button>
        <Button size="sm" onClick={() => act({ type: "zoom", factor: ZOOM_STEP })}>Zoom in</Button>
        <Button size="sm" variant="quiet" onClick={() => act({ type: "fit" })}>Fit board</Button>
        <span className="lb-cap" data-zoom>{pct}%</span>
        {/* The same pans the arrow keys make, for people who cannot drag or use the keyboard on the board */}
        <Button size="sm" variant="quiet" onClick={() => act(keyAction({ key: "ArrowLeft" }))}>Pan left</Button>
        <Button size="sm" variant="quiet" onClick={() => act(keyAction({ key: "ArrowRight" }))}>Pan right</Button>
        <Button size="sm" variant="quiet" onClick={() => act(keyAction({ key: "ArrowUp" }))}>Pan up</Button>
        <Button size="sm" variant="quiet" onClick={() => act(keyAction({ key: "ArrowDown" }))}>Pan down</Button>
      </div>
      <p className="lb-cap" id={`${markerId}-hint`}>Drag to pan, or use the pan buttons. With the board focused, arrow keys pan (Shift for further), + and - zoom, 0 fits the board.</p>
      <p className="sr-only" role="status" aria-live="polite">{announce}</p>
      <div
        ref={viewportRef}
        className={`lb-viewport${dragging ? " is-dragging" : ""}`}
        tabIndex={0}
        role="group"
        aria-roledescription="pannable board"
        aria-label={ariaLabel}
        aria-describedby={`${markerId}-hint`}
        onKeyDown={onKeyDown}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onWheel={onWheel}
      >
        <svg className="lb-svg" xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id={`${markerId}-arrow`} markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
              <path className="lb-arrow" d="M0 0 L8 4 L0 8 z" />
            </marker>
          </defs>
          <g className="lb-world" data-world transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>{children}</g>
        </svg>
      </div>
    </>
  );
}
