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
  /** Actions inside the bordered layout-toggle group, after the panel toggles. */
  actions?: HTMLElement | null;
  left: HTMLElement | null;
  right: HTMLElement | null;
  /** Side panels cannot show (narrow layouts); a screen may then provide its own in-page `right` target. */
  inline: boolean;
  /** The right panel's open state, for the title-bar toggle. Absent when there is no right panel. */
  details?: { open: boolean; toggle: () => void };
  heading: (value: FrameHeading | null) => void;
}
export const FrameContext = createContext<FrameSlots | null>(null);
export const useFrame = () => useContext(FrameContext);

/** Renders children into a frame region. Outside the frame, or while the region is closed, nothing renders. */
export function FrameSlot({ name, children }: { name: "title" | "actions" | "left" | "right"; children: ComponentChildren }) {
  const target = useFrame()?.[name];
  const group = useRef<HTMLSpanElement>(null), within = useRef(false);
  useEffect(() => {
    if (name === "actions" && within.current && document.activeElement === document.body) {
      const bar = target?.closest(".pc-topbar");
      (bar?.querySelector<HTMLElement>(".pc-layout-toggles button") ?? bar?.querySelector<HTMLElement>("button"))?.focus();
      within.current = false;
    }
  });
  return target ? createPortal(name === "actions" ? <span ref={group} className="pc-frame-actions"
    onFocusIn={() => { within.current = true; }}
    onFocusOut={event => { if (event.relatedTarget) within.current = group.current!.contains(event.relatedTarget as Node); }}>{children}</span> : <>{children}</>, target) : null;
}

/** The top bar shows the screen's own title (and agent) instead of the route name while the screen is mounted. */
export function useFrameHeading(value: FrameHeading | null) {
  const frame = useFrame();
  useEffect(() => {
    frame?.heading(value);
    return () => frame?.heading(null);
  }, [frame?.heading, value?.title, value?.agent]);
}
