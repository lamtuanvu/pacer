import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { IconButton } from "./Button";

/**
 * Collapsible frame column. Closed panels keep only a strip with the control that reopens them. The open and closed
 * toggles are different elements, so focus follows to the new one when the old one had it or the panel took it away.
 * With `contentToggle`, the owner renders the toggle with id `${id}-toggle` inside unpadded content; the closed strip remains.
 * With `bar={false}` alone the owner shows the toggle elsewhere (the title bar), and a closed panel renders nothing.
 */
export function SidePanel({ side, label, open, onToggle, bar = true, wide = false, contentToggle = false, children }: {
  side: "left" | "right"; label: string; open: boolean; onToggle: (open: boolean) => void; bar?: boolean; wide?: boolean; contentToggle?: boolean; children?: ComponentChildren;
}) {
  const id = `pc-side-panel-${side}`;
  const button = useRef<HTMLButtonElement>(null), clicked = useRef(false), first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const lost = document.activeElement === document.body || document.activeElement === null;
    if (clicked.current || lost) {
      const target = button.current ?? document.getElementById(`${id}-toggle`);
      if (target) target.focus();
      // The frame portal mounts the owner's toggle after the panel's content ref updates.
      else if (contentToggle) requestAnimationFrame(() => {
        if (document.activeElement === document.body) document.getElementById(`${id}-toggle`)?.focus();
      });
    }
    clicked.current = false;
  }, [open]);
  const toggle = <IconButton ref={button} size="sm" variant="quiet" icon={`panel-${side}`} aria-label={`${open ? "Hide" : "Show"} ${label}`}
    title={`${open ? "Hide" : "Show"} ${label}`} aria-expanded={open} aria-controls={open ? id : undefined}
    onClick={() => { clicked.current = true; onToggle(!open); }} />;
  if (!bar && !contentToggle && !open) return null;
  return open
    ? <aside className={`pc-side-panel pc-side-panel--${side}${wide ? " pc-side-panel--wide" : ""}`} aria-label={label}>
      {bar && <div className="pc-side-panel__bar">{toggle}</div>}
      <div id={id} className={`pc-side-panel__content${contentToggle ? " pc-side-panel__content--flush" : ""}`}>{children}</div>
    </aside>
    : <div className={`pc-side-panel pc-side-panel--${side} pc-side-panel--closed`}>{toggle}</div>;
}
