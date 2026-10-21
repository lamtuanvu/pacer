import type { ComponentChildren } from "preact";
import { Button } from "./Button";

/** Nonmodal notification; appearance never moves keyboard focus. */
export function UpdateNoticeCard({ version, restart, later, busy, children, narrow = false }: {
  version: string; restart: () => void; later: () => void; busy: boolean; children?: ComponentChildren; narrow?: boolean;
}) {
  return <aside className={`pc-update-notice${narrow ? " pc-update-notice--narrow" : ""}`} aria-label="Desktop update" aria-busy={busy}>
    <div role="status" aria-live="polite"><strong>Update ready · {version}</strong></div>
    <p>Restart when you’re ready. Active work will finish first.</p>
    <div className="row-actions">
      <Button variant="primary" aria-disabled={busy} onClick={() => { if (!busy) restart(); }}>Restart to update</Button>
      <Button aria-disabled={busy} onClick={() => { if (!busy) later(); }}>Later</Button>
    </div>
    {busy && <p role="status">Sending request…</p>}
    {children}
  </aside>;
}
