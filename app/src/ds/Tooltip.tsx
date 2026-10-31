import { cloneElement, type VNode } from "preact";
import { createPortal } from "preact/compat";
import { useId, useLayoutEffect, useRef, useState } from "preact/hooks";
import { Kbd } from "./Kbd";

/** Body-level overlay; hover/focus opens it and Escape dismisses it. */
export function Tooltip({ text, shortcut, children }: { text: string; shortcut?: string; children: VNode<Record<string, unknown>> }) {
  const id = `tip-${useId()}`;
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLSpanElement>(null);
  const bubble = useRef<HTMLSpanElement>(null);
  const hovered = useRef(false);
  const focused = useRef(false);
  const dismissed = useRef(false);
  const sync = () => setOpen(!dismissed.current && (hovered.current || focused.current));

  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = trigger.current?.getBoundingClientRect();
      const tip = bubble.current;
      if (!anchor || !tip) return;
      // The DS owns spacing; only measured viewport geometry becomes a transform.
      const gap = parseFloat(getComputedStyle(tip).getPropertyValue("--space-2"));
      const { width, height } = tip.getBoundingClientRect();
      const right = anchor.right + gap;
      const left = right + width <= window.innerWidth - gap ? right : anchor.left - gap - width;
      const x = Math.max(gap, Math.min(left, window.innerWidth - gap - width));
      const y = Math.max(gap, Math.min(anchor.top + (anchor.height - height) / 2, window.innerHeight - gap - height));
      tip.style.transform = `translate(${x}px, ${y}px)`;
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(trigger.current!);
    observer.observe(bubble.current!);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, text, shortcut]);

  const content = <span ref={bubble} role="tooltip" id={id} className="pc-tooltip__bubble" hidden={!open}>{text}{shortcut && <Kbd size="sm">{shortcut}</Kbd>}</span>;
  const describedBy = [children.props["aria-describedby"], id].filter(Boolean).join(" ");
  return <span ref={trigger} className="pc-tooltip"
    onMouseEnter={() => { dismissed.current = false; hovered.current = true; sync(); }} onMouseLeave={() => { hovered.current = false; sync(); }}
    onFocusIn={() => { dismissed.current = false; focused.current = true; sync(); }} onFocusOut={() => { focused.current = false; sync(); }}
    onKeyDown={e => { if (e.key === "Escape") { dismissed.current = true; setOpen(false); } }}>
    {cloneElement(children, { "aria-describedby": describedBy })}
    {open ? createPortal(content, document.body) : content}
  </span>;
}
