import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { classNames as classes } from "./classNames";
import { Icon } from "./icons";
import { Kbd } from "./Kbd";

/**
 * The assistant sheet. Three layers: a decorative aurora (`aria-hidden`), the conversation (a `log` region) and the
 * composer. The aurora is solid at the bottom edge and masked to transparent toward the top, and the log fades older
 * messages the same way. It drifts only while `generating`, and never under reduced motion. Message text sits on solid
 * card surfaces supplied by the consumer, never on the gradient.
 *
 * Open state is a prop and the sheet stays mounted, so a conversation survives closing. Opening moves focus to the
 * `[data-autofocus]` element; closing, by Escape or `onClose`, returns focus to where it was.
 */
export function AuroraSheet({ label, open, generating = false, narrow = false, onClose, expanded = false, header, messages, suggestions, composer, logLabel = "Conversation" }: {
  label: string; open: boolean; generating?: boolean; narrow?: boolean; onClose: () => void; /** Taller conversation while an action card is pending. */ expanded?: boolean; header?: ComponentChildren;
  messages: ComponentChildren; suggestions?: ComponentChildren; composer: ComponentChildren; logLabel?: string;
}) {
  const root = useRef<HTMLElement>(null), log = useRef<HTMLDivElement>(null), opener = useRef<HTMLElement | null>(null), was = useRef(false);
  useEffect(() => {
    if (open === was.current) return;
    was.current = open;
    if (open) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      root.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    } else {
      const target = opener.current?.isConnected ? opener.current : null;
      if (root.current?.contains(document.activeElement) || document.activeElement === document.body) target?.focus();
      opener.current = null;
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const active = document.activeElement;
      if (active && active !== document.body && !root.current?.contains(active)) return;
      event.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);
  // A full-screen sheet covers the page, so the page behind it must not take focus: make every other region inert.
  useEffect(() => {
    if (!open || !narrow || !root.current) return;
    const marked: HTMLElement[] = [];
    for (let path: HTMLElement | null = root.current; path && !path.classList.contains("pc-app"); path = path.parentElement) {
      for (const sibling of Array.from(path.parentElement?.children ?? [])) {
        if (sibling !== path && sibling instanceof HTMLElement && !sibling.inert) { sibling.inert = true; marked.push(sibling); }
      }
    }
    return () => { for (const el of marked) el.inert = false; };
  }, [open, narrow]);
  // Keep the newest message in view as the conversation grows.
  useEffect(() => { const el = log.current; if (el) el.scrollTop = el.scrollHeight; });
  return <section ref={root} aria-label={label} className={classes("pc-aurora", narrow && "pc-aurora--narrow")} data-state={open ? "open" : "closed"} data-generating={generating ? "true" : "false"} inert={!open}>
    <div className="pc-aurora__veil" aria-hidden="true" />
    <div className="pc-aurora__glow" aria-hidden="true"><span /><span /><span /><span /></div>
    <div className="pc-aurora__column">
      {header && <div className="pc-aurora__bar">{header}</div>}
      <div ref={log} role="log" aria-label={logLabel} aria-live="polite" aria-relevant="additions" tabIndex={0} className="pc-aurora__log" data-expanded={expanded ? "true" : "false"}>{messages}</div>
      {suggestions && <div className="pc-aurora__chips">{suggestions}</div>}
      {composer}
    </div>
  </section>;
}

/** The pill that opens the sheet. `aria-expanded` follows the sheet, and the shortcut is shown beside the name. */
export function AuroraLauncher({ open, onClick, shortcut, controls, className }: { open: boolean; onClick: () => void; shortcut?: string; controls?: string; className?: string }) {
  return <button type="button" className={classes("pc-aurora-launcher", className)} aria-expanded={open} aria-controls={controls} aria-label={open ? "Close assistant" : "Ask pacer assistant"} onClick={onClick}>
    <span className="pc-aurora-avatar" aria-hidden="true" />
    <span>{open ? "Close assistant" : "Ask pacer"}</span>
    {shortcut && <Kbd>{shortcut}</Kbd>}
  </button>;
}

/** The assistant's mark: a decorative radial swatch from the aurora tokens. */
export function AuroraAvatar({ size = "md" }: { size?: "sm" | "md" }) { return <span className={classes("pc-aurora-avatar", size === "sm" && "pc-aurora-avatar--sm")} aria-hidden="true" />; }

/** Static activity indicator for reduced motion and screen readers' sighted counterparts. */
export function Thinking({ label = "Thinking…" }: { label?: string }) { return <span className="pc-aurora-thinking"><Icon name="spark" />{label}</span>; }
