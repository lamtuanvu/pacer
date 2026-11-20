import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { classNames as classes } from "./classNames";
import { Icon } from "./icons";
import { Kbd } from "./Kbd";

/**
 * The assistant sheet. Three layers: a decorative aurora (`aria-hidden`), the conversation (a `log` region) and the
 * composer. The aurora is solid at the bottom edge and masked to transparent toward the top, and the log fades older
 * messages the same way. It drifts while open, as on the Shell board, and never under reduced motion. Message text sits on solid
 * card surfaces supplied by the consumer, never on the gradient.
 *
 * Open state is a prop and the sheet stays mounted, so a conversation survives closing. Opening moves focus to the
 * `[data-autofocus]` element; closing, by Escape or `onClose`, returns focus to where it was.
 */
export function AuroraSheet({ label, open, generating = false, narrow = false, onClose, expanded = false, maximized = false, autoScroll = true, followKey, restoreFocus, covers, header, messages, suggestions, composer, logLabel = "Conversation" }: {
  label: string; open: boolean; generating?: boolean; narrow?: boolean; onClose: () => void; /** Taller conversation while an action card is pending. */ expanded?: boolean;
  /** Fill the whole content area instead of the bottom sheet height. */ maximized?: boolean; header?: ComponentChildren;
  /** Follow newly appended conversation messages; disable for setup/status cards. */ autoScroll?: boolean;
  /** Changes when the user sends a message: the log returns to the newest message even if they had scrolled up. */ followKey?: unknown;
  /** Where focus goes on close when the element that opened the sheet is gone, such as a launcher hidden while open. */ restoreFocus?: () => HTMLElement | null | undefined;
  /** The region a maximized sheet covers; it is made inert so nothing hidden behind the sheet takes focus or clicks. */ covers?: () => HTMLElement | null | undefined;
  messages: ComponentChildren; suggestions?: ComponentChildren; composer: ComponentChildren; logLabel?: string;
}) {
  const root = useRef<HTMLElement>(null), log = useRef<HTMLDivElement>(null), opener = useRef<HTMLElement | null>(null), was = useRef(false);
  /** Whether the log sits at its newest message. Scrolling up to read releases it; returning to the bottom pins it again. */
  const pinned = useRef(true), lastTop = useRef(0);
  useEffect(() => {
    if (open === was.current) return;
    was.current = open;
    if (open) {
      const active = document.activeElement;
      opener.current = active instanceof HTMLElement && active !== document.body ? active : null;
      root.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus({ preventScroll: true });
    } else {
      const target = opener.current?.isConnected ? opener.current : restoreFocus?.() ?? null;
      if (root.current?.contains(document.activeElement) || document.activeElement === document.body) target?.focus({ preventScroll: true });
      opener.current = null;
    }
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      // An open dialog closes before the sheet (same layering as AssistantHost / Layout).
      if (document.querySelector("dialog[open]")) return;
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
  // A maximized sheet covers the page in the same way, within the region the consumer names.
  useEffect(() => {
    if (!open || narrow || !maximized) return;
    const region = covers?.();
    if (!region || region.inert) return;
    region.inert = true;
    return () => { region.inert = false; };
  }, [open, narrow, maximized]);
  // Keep the newest message in view as the conversation grows, but only while the reader is already there:
  // the page behind the sheet re-renders on every poll, and that must not pull them away from an older message.
  useEffect(() => {
    pinned.current = autoScroll;
    // A status card is read from its top, once, when it replaces the conversation.
    if (!autoScroll && log.current) { log.current.scrollTop = 0; lastTop.current = 0; }
  }, [followKey, autoScroll]);
  // Record where our own scroll lands, so the next scroll event compares the reader's move against it, not a stale value.
  useEffect(() => { const el = log.current; if (el && pinned.current) { el.scrollTop = el.scrollHeight; lastTop.current = el.scrollTop; } });
  return <section ref={root} aria-label={label} className={classes("pc-aurora", narrow && "pc-aurora--narrow", maximized && !narrow && "pc-aurora--max")} data-state={open ? "open" : "closed"} data-generating={generating ? "true" : "false"} inert={!open} onKeyDown={event => {
    // Own Escape inside the sheet before the shell's settings-navigation shortcut.
    // Menus inside the sheet may consume it first. An open dialog closes before the sheet.
    if (open && event.key === "Escape" && !event.defaultPrevented && !document.querySelector("dialog[open]")) {
      event.preventDefault(); event.stopPropagation(); onClose();
    }
  }}>
    <div className="pc-aurora__veil" aria-hidden="true" />
    <div className="pc-aurora__glow" aria-hidden="true"><div className="pc-aurora__gradient" /><div className="pc-aurora__blobs"><span /><span /><span /></div></div>
    <div className="pc-aurora__column">
      {header && <div className="pc-aurora__bar">{header}</div>}
      <div ref={log} role="log" aria-label={logLabel} aria-live="polite" aria-relevant="additions" tabIndex={0} className="pc-aurora__log" data-expanded={expanded ? "true" : "false"} onScroll={event => {
        const el = event.currentTarget, up = el.scrollTop < lastTop.current - 1;
        lastTop.current = el.scrollTop;
        if (!autoScroll) return;
        // The sheet only ever scrolls itself down, so only an upward scroll is the reader leaving the newest message.
        // Content that grows before our own scroll event lands must not release the pin.
        if (el.scrollHeight - el.scrollTop - el.clientHeight <= PIN_SLACK) pinned.current = true;
        else if (up) pinned.current = false;
      }}>{messages}</div>
      {suggestions && <div className="pc-aurora__chips">{suggestions}</div>}
      {composer}
    </div>
  </section>;
}

/** Pixels from the bottom that still count as reading the newest message (sub-pixel rounding, a stray wheel tick). */
const PIN_SLACK = 24;

/** The pill that opens the sheet. `aria-expanded` follows the sheet, and the shortcut is shown beside the name. */
export function AuroraLauncher({ open, onClick, shortcut, controls, className }: { open: boolean; onClick: () => void; shortcut?: string; controls?: string; className?: string }) {
  return <button type="button" className={classes("pc-aurora-launcher", className)} aria-expanded={open} aria-controls={controls} aria-label={open ? "Close assistant" : "Open assistant"} onClick={onClick}>
    <span className="pc-aurora-avatar" aria-hidden="true" />
    <span>{open ? "Close assistant" : "Ask pacer"}</span>
    {shortcut && <Kbd>{shortcut}</Kbd>}
  </button>;
}

/** The assistant's mark: a decorative radial swatch from the aurora tokens. */
export function AuroraAvatar({ size = "md" }: { size?: "sm" | "md" }) { return <span className={classes("pc-aurora-avatar", size === "sm" && "pc-aurora-avatar--sm")} aria-hidden="true" />; }

/** Static activity indicator for reduced motion and screen readers' sighted counterparts. */
export function Thinking({ label = "Thinking…" }: { label?: string }) { return <span className="pc-aurora-thinking"><Icon name="spark" />{label}</span>; }
