import type { ComponentChildren, JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import type { StatusTone } from "../../../src/view-model/words";
import { IconButton } from "./Button";
import { classNames as classes } from "./classNames";
import { cycleDialogFocus } from "./Dialog";
import { Icon } from "./icons";
import { Pill } from "./Pill";

const RADIO = '[role="radio"]';
/**
 * A labelled radio group of button radios (RadioCard, RadioChip, OptionRow). One radio is in the Tab order: the
 * checked one, else the first enabled one. Arrow keys, Home and End move to and select the next enabled radio.
 */
export function RadioGroup({ label, className, children, ...props }: JSX.HTMLAttributes<HTMLDivElement> & { label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const radios = [...(ref.current?.querySelectorAll<HTMLElement>(RADIO) ?? [])];
    const enabled = radios.filter(radio => radio.getAttribute("aria-disabled") !== "true");
    const current = enabled.find(radio => radio.getAttribute("aria-checked") === "true") ?? enabled[0];
    for (const radio of radios) radio.tabIndex = radio === current ? 0 : -1;
  });
  return <div {...props} ref={ref} role="radiogroup" aria-label={label} className={classes("pc-radio-group", className)} onKeyDown={event => {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (step === undefined && event.key !== "Home" && event.key !== "End") return;
    const enabled = [...event.currentTarget.querySelectorAll<HTMLElement>(RADIO)].filter(radio => radio.getAttribute("aria-disabled") !== "true");
    if (!enabled.length) return;
    const at = enabled.indexOf(document.activeElement as HTMLElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? enabled.length - 1 : (Math.max(at, 0) + step! + enabled.length) % enabled.length;
    event.preventDefault();
    enabled[next]!.focus();
    enabled[next]!.click();
  }}>{children}</div>;
}

interface RadioProps { checked: boolean; onSelect: () => void; disabled?: boolean }
/** A workspace-style choice: radio dot, title, optional status pill, and a caption. */
export function RadioCard({ checked, onSelect, disabled, title, sub, tag }: RadioProps & { title: ComponentChildren; sub: ComponentChildren; tag?: { label: string; tone: StatusTone } }) {
  return <button type="button" role="radio" aria-checked={checked} aria-disabled={disabled || undefined} className="pc-radio-card" onClick={() => { if (!disabled) onSelect(); }}>
    <span className="pc-radio-card__head"><span className="pc-radio-card__dot" aria-hidden="true" /><span className="pc-radio-card__title">{title}</span>{tag && <Pill tone={tag.tone}>{tag.label}</Pill>}</span>
    <span className="pc-radio-card__sub">{sub}</span>
  </button>;
}
/** A pill-shaped single choice, such as a task kind. `note` reads after the label ("· detected"). */
export function RadioChip({ checked, onSelect, disabled, children, note }: RadioProps & { children: ComponentChildren; note?: string }) {
  return <button type="button" role="radio" aria-checked={checked} aria-disabled={disabled || undefined} className="pc-radio-chip" onClick={() => { if (!disabled) onSelect(); }}>
    {children}{note && <span className="pc-radio-chip__note">· {note}</span>}
  </button>;
}
/** A list choice with a leading mark, a name and caption, and a status pill. Unavailable rows stay visible with their reason. */
export function OptionRow({ checked, onSelect, disabled, leading, title, sub, pill, variant }: RadioProps & { leading?: ComponentChildren; title: ComponentChildren; sub?: ComponentChildren; pill?: { label: string; tone: StatusTone }; variant?: "retry" }) {
  return <button type="button" role="radio" aria-checked={checked} aria-disabled={disabled || undefined} className={classes("pc-option-row", variant && `pc-option-row--${variant}`)} onClick={() => { if (!disabled) onSelect(); }}>
    {leading}<span className="pc-option-row__text"><span className="pc-option-row__title">{title}</span>{sub && <span className="pc-option-row__sub">{sub}</span>}</span>
    {pill && <Pill tone={pill.tone}>{pill.label}</Pill>}
  </button>;
}
/** A toggleable list row, such as an acceptance check: a checkbox button, the text, an optional detail line and a source pill. */
export function CheckRow({ checked, onToggle, label, detail, source, actions }: { checked: boolean; onToggle: () => void; label: ComponentChildren; detail?: ComponentChildren; source?: string; actions?: ComponentChildren }) {
  return <div className={classes("pc-check-row", !checked && "pc-check-row--off")}>
    <button type="button" role="checkbox" aria-checked={checked} className="pc-check-row__box" onClick={onToggle}><svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4 10-10" /></svg><span className="sr-only">{label}</span></button>
    <span className="pc-check-row__text" aria-hidden="true"><span className="pc-check-row__label">{label}</span>{detail && <span className="pc-check-row__detail">{detail}</span>}</span>
    {source && <Pill tone="neutral">{source}</Pill>}
    {actions}
  </div>;
}
/** A removable chip for an attachment or a mentioned path. */
export function FileChip({ children, removeLabel, onRemove, mono }: { children: ComponentChildren; removeLabel: string; onRemove: () => void; mono?: boolean }) {
  return <span className={classes("pc-file-chip", mono && "pc-file-chip--mono")}>{children}<IconButton variant="quiet" size="sm" aria-label={removeLabel} icon="close" onClick={onRemove} /></span>;
}
/** A read-only value shown in the geometry of a picker trigger. */
export function ValueBox({ children, meta, className, ...props }: JSX.HTMLAttributes<HTMLDivElement> & { meta?: ComponentChildren }) {
  return <div {...props} className={classes("pc-value-box", className)}><span className="pc-value-box__value">{children}</span>{meta && <span className="pc-value-box__meta">{meta}</span>}</div>;
}
/** A drill-in row for narrow sheets: a caption, the current value and a chevron. */
export function DrillRow({ label, value, onClick }: { label: string; value: ComponentChildren; onClick: () => void }) {
  return <button type="button" className="pc-drill-row" onClick={onClick}>
    <span className="pc-drill-row__text"><span className="pc-drill-row__label">{label}</span><span className="pc-drill-row__value">{value}</span></span>
    <Icon name="chevron-right" />
  </button>;
}
/**
 * A full-screen native modal for narrow layouts: a 52px header with Close, the title and an optional action, a
 * scrolling body and a pinned footer. Escape closes it; focus cycles inside and returns to the opener.
 */
export function Sheet({ title, close, action, footer, children, className }: { title: string; close: () => void; action?: ComponentChildren; footer?: ComponentChildren; children: ComponentChildren; className?: string }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const invoking = dialog.ownerDocument.activeElement as HTMLElement | null;
    if (!dialog.open) dialog.showModal();
    return () => { dialog.close(); if (invoking?.isConnected) invoking.focus(); };
  }, []);
  return <dialog ref={ref} className={classes("pc-sheet", className)} aria-label={title} tabIndex={-1}
    onKeyDown={event => cycleDialogFocus(event.currentTarget, event)}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className="pc-sheet__head"><IconButton variant="quiet" aria-label="Close" icon="close" className="pc-sheet__close" onClick={close} /><h1 className="pc-sheet__title">{title}</h1>{action}</header>
    <div className="pc-sheet__body">{children}</div>
    {footer && <footer className="pc-sheet__foot">{footer}</footer>}
  </dialog>;
}
