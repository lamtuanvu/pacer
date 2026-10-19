import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';
import { SectionHeading } from './SectionHeading';
import { Button } from './Button';

const FOCUSABLE = 'a[href],button,input,select,textarea,summary,[tabindex]:not([tabindex="-1"])';
/** Explicit cycling prevents native modal boundaries from moving focus to browser chrome. */
export function cycleDialogFocus(dialog: HTMLDialogElement, event: Pick<KeyboardEvent, 'key' | 'shiftKey' | 'preventDefault'> & { defaultPrevented?: boolean }): void {
  if (event.key !== 'Tab' || event.defaultPrevented) return;
  const controls = [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(element =>
    !element.matches(':disabled,[tabindex="-1"]') && !element.closest('[hidden],[inert],[aria-hidden="true"]') && element.getClientRects().length > 0);
  event.preventDefault();
  if (!controls.length) { dialog.focus(); return; }
  const index = controls.indexOf(dialog.ownerDocument.activeElement as HTMLElement);
  const next = index < 0 ? (event.shiftKey ? controls.length - 1 : 0)
    : (index + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
  controls[next]!.focus();
}

export function Dialog({ title, close, children }: { title: string; close: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!;
    const invoking = dialog.ownerDocument.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => {
      dialog.close();
      if (invoking?.isConnected) invoking.focus();
    };
  }, []);
  return <dialog className="pc-dialog" ref={ref} tabIndex={-1} aria-label={title}
    onKeyDown={event => cycleDialogFocus(event.currentTarget, event)}
    onCancel={event => { event.preventDefault(); close(); }}>
    <div className="pc-dialog__head"><SectionHeading>{title}</SectionHeading><Button onClick={close}>Close</Button></div>
    {children}
  </dialog>;
}
