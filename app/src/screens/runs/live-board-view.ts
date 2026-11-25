/** Pan and zoom for the Live board: pure view math and the keyboard map, so pointer and keyboard share one path. */

export interface BoardView { x: number; y: number; k: number }
export const MIN_ZOOM = 0.4;
export const MAX_ZOOM = 2.5;
export const ZOOM_STEP = 1.25;
export const PAN_STEP = 48;
export const PAN_STEP_LARGE = 192;

export const clampZoom = (k: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
const round = (n: number): number => Math.round(n * 100) / 100;

/** Move the view by (dx, dy) screen pixels. Dragging right moves the content right. */
export function panBy(view: BoardView, dx: number, dy: number): BoardView {
  return { x: round(view.x + dx), y: round(view.y + dy), k: view.k };
}

/** Zoom by `factor` keeping the point (cx, cy), in viewport pixels, fixed on screen. */
export function zoomAt(view: BoardView, factor: number, cx: number, cy: number): BoardView {
  const k = clampZoom(view.k * factor);
  if (k === view.k) return view;
  const ratio = k / view.k;
  return { x: round(cx - (cx - view.x) * ratio), y: round(cy - (cy - view.y) * ratio), k: round(k * 1000) / 1000 };
}

/** The whole board inside the viewport, centred, never zoomed in past 1. */
export function fitView(content: { width: number; height: number }, viewport: { width: number; height: number }, pad = 16): BoardView {
  if (content.width <= 0 || content.height <= 0 || viewport.width <= 0 || viewport.height <= 0) return { x: 0, y: 0, k: 1 };
  const k = clampZoom(Math.min(1, (viewport.width - 2 * pad) / content.width, (viewport.height - 2 * pad) / content.height));
  return {
    x: round((viewport.width - content.width * k) / 2),
    y: round((viewport.height - content.height * k) / 2),
    k: round(k * 1000) / 1000,
  };
}

export type BoardKeyAction =
  | { type: "pan"; dx: number; dy: number }
  | { type: "zoom"; factor: number }
  | { type: "fit" };

/**
 * Arrow keys move the view in that direction (ArrowRight shows what lies to the right, so the content moves left);
 * Shift moves further. + and - zoom, 0 fits the board. Keys with Ctrl, Meta or Alt belong to the browser.
 */
export function keyAction(e: { key: string; shiftKey?: boolean; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): BoardKeyAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null;
  const step = e.shiftKey ? PAN_STEP_LARGE : PAN_STEP;
  switch (e.key) {
    case "ArrowLeft": return { type: "pan", dx: step, dy: 0 };
    case "ArrowRight": return { type: "pan", dx: -step, dy: 0 };
    case "ArrowUp": return { type: "pan", dx: 0, dy: step };
    case "ArrowDown": return { type: "pan", dx: 0, dy: -step };
    case "+": case "=": return { type: "zoom", factor: ZOOM_STEP };
    case "-": case "_": return { type: "zoom", factor: 1 / ZOOM_STEP };
    case "0": return { type: "fit" };
    default: return null;
  }
}
