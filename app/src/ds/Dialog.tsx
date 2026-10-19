import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { SectionHeading } from "./SectionHeading";
import { Button } from "./Button";

export function Dialog({ title, close, children }: { title: string; close: () => void; children: ComponentChildren }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const dialog = ref.current!; dialog.showModal(); return () => { dialog.close(); }; }, []);
  return <dialog ref={ref} aria-label={title} onCancel={event => { event.preventDefault(); close(); }}><div className="dialog-head"><SectionHeading>{title}</SectionHeading><Button onClick={close}>Close</Button></div>{children}</dialog>;
}
