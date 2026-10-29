import type { ComponentChildren, JSX } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { cycleDialogFocus } from "./Dialog";
import { Button } from "./Button";

/** A native modal side panel; Escape closes, Tab cycles, and focus returns to its invoker. */
export function SideDialog({ title, mark, close, footer, children, onKeyDown }: { title: string; mark?: ComponentChildren; close: () => void; footer: ComponentChildren; children: ComponentChildren; onKeyDown?: JSX.KeyboardEventHandler<HTMLDialogElement> }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current!, invoking = document.activeElement as HTMLElement | null;
    dialog.showModal();
    return () => { dialog.close(); if (invoking?.isConnected) invoking.focus(); };
  }, []);
  return <dialog ref={ref} className="pc-side-dialog" aria-label={title} tabIndex={-1} onCancel={event => { event.preventDefault(); close(); }} onKeyDown={event => { cycleDialogFocus(event.currentTarget, event); onKeyDown?.(event); }}>
    <header className="pc-side-dialog__header">{mark}<h2>{title}</h2><Button variant="quiet" size="sm" aria-label="Close" onClick={close}>×</Button></header>
    <div className="pc-side-dialog__body">{children}</div><footer className="pc-side-dialog__footer">{footer}</footer>
  </dialog>;
}
