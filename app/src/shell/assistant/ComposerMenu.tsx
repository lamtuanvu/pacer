import { useEffect, useRef, useState } from "preact/hooks";
import { Button, IconButton } from "../../ds/Button";

/** The composer's "+" menu: only what works here, which is a fresh conversation and the context choice. */
export function ComposerMenu({ canStartNew, busy, sheetOpen, onNew, onContext }: { canStartNew: boolean; busy: boolean; sheetOpen: boolean; onNew: () => void; onContext: () => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  // Closing the sheet (Escape, the shortcut, the launcher) closes the menu with it, so it is never open when the sheet returns.
  useEffect(() => { if (!sheetOpen) setOpen(false); }, [sheetOpen]);
  useEffect(() => {
    if (!open) return;
    root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    const away = (event: MouseEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open]);
  const close = (restore = true) => { setOpen(false); if (restore) root.current?.querySelector<HTMLElement>("button[aria-haspopup]")?.focus(); };
  // Tabbing out of the menu closes it, so it never stays open behind the sheet.
  // WebKit does not focus a button on mousedown, so a null relatedTarget is a click inside, not a Tab out: only a real
  // focus target outside the menu closes it (outside clicks are handled by the pointerdown listener).
  const onBlur = (event: FocusEvent) => { const next = event.relatedTarget as Node | null; if (open && next && !root.current?.contains(next)) setOpen(false); };
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const items = Array.from(root.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };
  return <div ref={root} className="pc-aurora-menu-anchor" onKeyDown={onKey} onFocusOut={onBlur}>
    <IconButton ref={trigger} icon="plus" size="sm" variant="quiet" className="pc-aurora-tool" aria-label="Conversation options" title="New conversation or change context" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(o => !o)} />
    {open && <div role="menu" aria-label="Conversation options" className="pc-aurora-menu">
      {canStartNew && !busy && <Button role="menuitem" variant="quiet" size="sm" onClick={() => { close(); onNew(); }}>New conversation</Button>}
      <Button role="menuitem" variant="quiet" size="sm" onClick={() => { close(false); onContext(); }}>Change context</Button>
    </div>}
  </div>;
}
