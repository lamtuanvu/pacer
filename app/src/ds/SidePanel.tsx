import type { ComponentChildren } from "preact";
import { IconButton } from "./Button";

/** Collapsible frame column. Closed panels keep only a strip with the control that reopens them. */
export function SidePanel({ side, label, open, onToggle, children }: {
  side: "left" | "right"; label: string; open: boolean; onToggle: (open: boolean) => void; children?: ComponentChildren;
}) {
  const id = `pc-side-panel-${side}`;
  const toggle = <IconButton size="sm" variant="quiet" icon={`panel-${side}`} aria-label={`${open ? "Hide" : "Show"} ${label}`}
    title={`${open ? "Hide" : "Show"} ${label}`} aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => onToggle(!open)} />;
  return open
    ? <aside className={`pc-side-panel pc-side-panel--${side}`} aria-label={label}>
      <div className="pc-side-panel__bar">{toggle}</div>
      <div id={id} className="pc-side-panel__content">{children}</div>
    </aside>
    : <div className={`pc-side-panel pc-side-panel--${side} pc-side-panel--closed`}>{toggle}</div>;
}
