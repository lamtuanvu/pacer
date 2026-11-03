export type BuildDiagnostic = 'unverified' | 'mismatch' | 'unknown';

/** Fixed desktop-owned copy: service claims are never rendered as markup or authority. */
export function ServiceBuildGuidance({ diagnostic, connected }: { diagnostic: BuildDiagnostic; connected: boolean }) {
  const detail = !connected ? 'Reconnecting; the service core descriptor comparison may be out of date.'
    : diagnostic === 'mismatch' ? 'The bundled and service core descriptor claims differ.'
    : diagnostic === 'unverified' ? 'The bundled and service core descriptor claims match.'
    : 'The desktop could not compare the service core descriptor claims.';
  return <div role="status" aria-live="polite" aria-label="Service build guidance">
    <p>{detail} These claims are not verified; they do not prove the running service or app identity.</p>
    <p>Service reconciliation is unavailable. Identify who manages this installation. Finish active tasks and terminal sessions before updating or restarting; an older updater may restart immediately.</p>
    <p>Consult the installation documentation after identifying the owner. If this is an external service, leave it attached and ask its owner to manage it.</p>
  </div>;
}
