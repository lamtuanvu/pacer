import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { platform } from '../platform';
import type { DesktopConnection } from '../platform/ipc';

/** The document and workspace survive service recovery; only the shell state changes. */
export function DesktopConnectionShell({ children }: { children: ComponentChildren }) {
  const [connection, setConnection] = useState<DesktopConnection>({status:'connecting'});
  const connected = useRef(false);
  if (connection.status === 'connected') connected.current = true;
  const blocked = platform.desktop && (!connected.current || connection.status === 'incompatible' || connection.reason === 'sessionExpired');
  useEffect(() => platform.subscribeDesktopConnection?.(setConnection), []);
  useEffect(() => {
    const shell = document.getElementById('desktop-shell');
    if (shell) shell.hidden = !blocked;
  }, [blocked]);
  if (!platform.desktop) return <>{children}</>;
  // pc-desktop-connection keeps the desktop height chain (#app → .pc-app → .pc-work → .pc-main) intact.
  return <div className="pc-desktop-connection" hidden={blocked} inert={blocked || undefined}>
    {/* Reconnecting is shown by each surface's own styled notice (OfflineNotice, the tray notice). */}
    {connection.warning && <div className="connection-bar" role="status"><span className="connection-bar__glyph" aria-hidden="true">◐</span><span>{connection.warning}</span></div>}
    {children}
  </div>;
}
