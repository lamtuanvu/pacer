import type { ComponentChildren } from "preact";

/**
 * The fixed bottom-right area that holds every nonmodal notice. Notices shown together stack in source order, top to bottom,
 * so none covers another and keyboard order matches what is on screen. Wide layouts sit above the status bar, narrow ones above the bottom navigation.
 */
export function NoticeStack({ narrow = false, children }: { narrow?: boolean; children?: ComponentChildren }) {
  return <div className={`pc-notice-stack${narrow ? " pc-notice-stack--narrow" : ""}`}>{children}</div>;
}

/** Nonmodal bottom-right notice for a NoticeStack, laid out like UpdateNoticeCard; appearance never moves keyboard focus. */
export function NoticeCard({ label, title, children, actions, busy = false }: {
  label: string; title: ComponentChildren; children?: ComponentChildren; actions: ComponentChildren; busy?: boolean;
}) {
  return <aside className="pc-update-notice" aria-label={label} aria-busy={busy}>
    <div role="status" aria-live="polite"><strong>{title}</strong></div>
    {children}
    <div className="row-actions">{actions}</div>
  </aside>;
}
