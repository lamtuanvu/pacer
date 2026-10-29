import { useLayoutEffect, useId, useRef, useState } from "preact/hooks";
import { Icon } from "./icons";
import { Button } from "./Button";
import styles from "./action-menu.css" with { type: "text" };
const styled = new WeakSet<Document>();
/** Small action menu; opening focuses an item, closing restores its trigger. */
export function ActionMenu({ label, items }: { label: string; items: { label: string; onSelect: () => void }[] }) {
  const [open, setOpen] = useState(false), id = useId(), root = useRef<HTMLSpanElement>(null), trigger = useRef<HTMLButtonElement>(null), last = useRef(false);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (!styled.has(document)) { const sheet = new CSSStyleSheet(); sheet.replaceSync(styles); document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]; styled.add(document); }
    if (!open) return;
    const options = root.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
    options?.[last.current ? options.length - 1 : 0]?.focus();
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  return <span className="pc-action-menu" ref={root} onKeyDown={event => {
    if (event.key === "Escape") { event.preventDefault(); close(); }
    if (event.key === "Tab") { setOpen(false); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    if (!open) { last.current = event.key === "ArrowUp" || event.key === "End"; setOpen(true); return; }
    const options = Array.from(root.current!.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    options[event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (at + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
  }}>
    <Button ref={trigger} size="sm" variant="ghost" className="pc-action-menu__trigger" aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => { last.current = false; setOpen(!open); }}><Icon name="more" /></Button>
    {open && <span id={id} role="menu" aria-label={label} className="pc-action-menu__items">{items.map(item => <Button key={item.label} variant="ghost" size="sm" role="menuitem" tabIndex={-1} onClick={() => { close(); item.onSelect(); }}>{item.label}</Button>)}</span>}
  </span>;
}
