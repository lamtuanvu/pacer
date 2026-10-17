import { cloneElement, type VNode } from "preact";
import { useId, useState } from "preact/hooks";
/** Shown on hover and on keyboard focus; Escape hides it. The trigger references it with aria-describedby. */
export function Tooltip({ text, children }: { text: string; children: VNode<Record<string, unknown>> }) {
  const id = `tip-${useId()}`;
  const [open, setOpen] = useState(false);
  const show = () => setOpen(true), hide = () => setOpen(false);
  return <span className="pc-tooltip" onMouseEnter={show} onMouseLeave={hide} onFocusIn={show} onFocusOut={hide} onKeyDown={e => { if (e.key === "Escape") hide(); }}>
    {cloneElement(children, { "aria-describedby": id })}
    <span role="tooltip" id={id} className="pc-tooltip__bubble" hidden={!open}>{text}</span>
  </span>;
}
