import type { ComponentChildren } from 'preact';
import { useEffect, useLayoutEffect, useRef } from 'preact/hooks';
import { SectionHeading } from './SectionHeading';
import { Button } from './Button';

const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])';
const isNamedRadio = (element: HTMLElement): element is HTMLInputElement =>
  (element as HTMLInputElement).type === 'radio' && !!(element as HTMLInputElement).name;
/**
 * A native radio group is one Tab stop: the focused radio, else the checked one, else the first
 * (the last when moving backwards). Arrow keys still move inside the group.
 */
function tabStops(controls: HTMLElement[], active: HTMLElement | null, backwards: boolean): HTMLElement[] {
  return controls.filter(element => {
    if (!isNamedRadio(element)) return true;
    const group = controls.filter((other): other is HTMLInputElement =>
      isNamedRadio(other) && other.name === element.name && other.form === element.form);
    const stop = group.find(radio => radio === active) ?? group.find(radio => radio.checked) ?? group[backwards ? group.length - 1 : 0];
    return element === stop;
  });
}
/** Explicit cycling prevents native modal boundaries from moving focus to browser chrome. */
export function cycleDialogFocus(dialog: HTMLDialogElement, event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'> & { defaultPrevented?: boolean }): void {
  if (event.key !== 'Tab' || event.defaultPrevented) return;
  const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element =>
    !element.matches(':disabled,[tabindex="-1"]') && !element.closest('[hidden],[inert],[aria-hidden="true"]') && element.getClientRects().length > 0);
  event.preventDefault();
  if (!controls.length) { dialog.focus(); return; }
  const active = dialog.ownerDocument.activeElement as HTMLElement | null;
  const stops = tabStops(controls, active, event.shiftKey);
  const index = active ? stops.indexOf(active) : -1;
  if (index >= 0) { stops[(index + (event.shiftKey ? -1 : 1) + stops.length) % stops.length]!.focus(); return; }
  // Focus on a programmatic target inside the dialog (an autofocused heading): continue from where it sits.
  const ordered = event.shiftKey ? [...stops].reverse() : stops;
  const direction = event.shiftKey ? 2 /* preceding */ : 4 /* following */;
  const neighbor = active && dialog.contains?.(active)
    ? ordered.find(stop => active.compareDocumentPosition(stop) & direction)
    : undefined;
  (neighbor ?? ordered[0]!).focus();
}

export function Dialog({ title, close, children, showClose = true }: { title: string; close: () => void; children: ComponentChildren; showClose?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const invoking = dialog.ownerDocument.activeElement as HTMLElement | null;
    dialog.showModal();
    // Same entry focus as AuroraSheet: prefer [data-autofocus], else first focusable control.
    const autofocus = dialog.querySelector<HTMLElement>("[data-autofocus]");
    const first = autofocus ?? [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].find(element =>
      !element.matches(':disabled,[tabindex="-1"]') && !element.closest('[hidden],[inert],[aria-hidden="true"]'));
    (autofocus ?? first)?.focus({ preventScroll: true });
    return () => {
      dialog.close();
      if (invoking?.isConnected) invoking.focus();
    };
  }, []);
  return <dialog className="pc-dialog" ref={ref} tabIndex={-1} aria-modal="true" aria-label={title}
    onKeyDown={event => cycleDialogFocus(event.currentTarget, event)}
    onCancel={event => { event.preventDefault(); close(); }}>
    <div className="pc-dialog__head"><SectionHeading>{title}</SectionHeading>{showClose && <Button onClick={close}>Close</Button>}</div>
    {children}
  </dialog>;
}

/** Anchored native modal for compact detail panels. The caller owns only the panel content. */
export function PopoverDialog({ id, title, close, children }: { id: string; title: string; close: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useLayoutEffect(() => {
    const dialog = ref.current!;
    const invoking = dialog.ownerDocument.activeElement as HTMLElement | null;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus();
    return () => {
      dialog.close();
      if (invoking?.isConnected) invoking.focus();
    };
  }, []);
  return <dialog className="pc-dialog-popover" id={id} ref={ref} tabIndex={-1} aria-label={title}
    onKeyDown={event => cycleDialogFocus(event.currentTarget, event)}
    onCancel={event => { event.preventDefault(); close(); }}
    onClick={event => { if (event.target === event.currentTarget) close(); }}>
    {children}
  </dialog>;
}
