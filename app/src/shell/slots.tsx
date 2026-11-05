import { useViewActive, WorkspaceScope } from '../workspace/state';
import { createContext, type ComponentChildren } from "preact";
import { createPortal } from "preact/compat";
import { useContext, useEffect, useRef } from "preact/hooks";

export interface FrameHeading { title: string; agent?: string }
/**
 * Frame regions a screen may fill. The frame owns the regions and their toggles; the screen renders into them
 * through `FrameSlot`, so its state and context stay with the screen.
 */
export interface FrameSlots {
  /** Title-bar area after the page title: the screen's facts and actions. */
  title: HTMLElement | null;
  /** Actions for the active panel, right of search and before the layout toggles. */
  actions?: HTMLElement | null;
  /** The static page-head region above `main`: a screen's own header and filter strip. Never scrolls. */
  header: HTMLElement | null;
  left: HTMLElement | null;
  right: HTMLElement | null;
  /** Side panels cannot show (narrow layouts); a screen may then provide its own in-page `right` target. */
  inline: boolean;
  /** Left Sessions panel state, for the navigator header toggle. */
  sessions?: { open: boolean; toggle: () => void };
  /** The right panel's open state, for the title-bar toggle. Absent when there is no right panel. */
  details?: { open: boolean; toggle: () => void };
  heading: (value: FrameHeading | null) => void;
}
export const FrameContext = createContext<FrameSlots | null>(null);
export const useFrame = () => useContext(FrameContext);

/** Renders children into a frame region. Outside the frame, or while the region is closed, nothing renders. */
export function FrameSlot({ name, children }: { name: "title" | "actions" | "header" | "left" | "right"; children: ComponentChildren }) {
  const target = useFrame()?.[name], active = useViewActive(), scope = useContext(WorkspaceScope);
  const group = useRef<HTMLSpanElement>(null), within = useRef(false);
  const node = useRef<HTMLDivElement | null>(null);
  // A plain ref callback, not an object ref: it only ever records a real, attached element. React/Preact call a
  // ref callback with null as part of unmounting, before this component's own effect cleanups run; capturing the
  // node this way instead keeps a usable reference through that window for the defensive cleanup below.
  const setNode = (element: HTMLDivElement | null) => { if (element) node.current = element; };
  useEffect(() => {
    if (active && name === "actions" && within.current && document.activeElement === document.body) {
      const bar = target?.closest(".pc-topbar");
      (bar?.querySelector<HTMLElement>(".pc-layout-toggles button") ?? bar?.querySelector<HTMLElement>("button"))?.focus();
      within.current = false;
    }
  });
  // Defensive cleanup: when a whole route's view is torn down at once (switching between two routes that both
  // fill the same frame region, outside the session views that stay mounted and merely hide), the portal host's
  // own unmount can run after the real target already has a new screen's content. Remove this node directly so
  // a destroyed screen never leaves stale content sitting alongside — or on top of — what fills the slot next.
  useEffect(() => () => { if (node.current?.parentNode) node.current.parentNode.removeChild(node.current); }, []);
  return target ? createPortal(<div ref={setNode} className="pc-view-slot" data-workspace-root={scope ?? undefined} hidden={!active} inert={!active ? true : undefined}>{name === "actions" ? <span ref={group} className="pc-frame-actions"
    onFocusIn={() => { within.current = true; }}
    onFocusOut={event => { if (event.relatedTarget) within.current = group.current!.contains(event.relatedTarget as Node); }}>{children}</span> : <>{children}</>}</div>, target) : null;
}

/** The top bar shows the screen's own title (and agent) instead of the route name while the screen is mounted. */
export function useFrameHeading(value: FrameHeading | null) {
  const frame = useFrame(), active = useViewActive();
  useEffect(() => {
    if (!active) return;
    frame?.heading(value);
    return () => frame?.heading(null);
  }, [frame?.heading, value?.title, value?.agent, active]);
}
