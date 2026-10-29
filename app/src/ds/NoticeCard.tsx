import type { ComponentChildren } from "preact";

/** Nonmodal bottom-right notice, laid out like UpdateNoticeCard; appearance never moves keyboard focus. */
export function NoticeCard({ label, title, children, actions, busy = false, narrow = false }: {
  label: string; title: ComponentChildren; children?: ComponentChildren; actions: ComponentChildren; busy?: boolean; narrow?: boolean;
}) {
  return <aside className={`pc-update-notice${narrow ? " pc-update-notice--narrow" : ""}`} aria-label={label} aria-busy={busy}>
    <div role="status" aria-live="polite"><strong>{title}</strong></div>
    {children}
    <div className="row-actions">{actions}</div>
  </aside>;
}
