import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { platform } from '../platform';
import type { DesktopConnection } from '../platform/ipc';

/** The desktop service warning (for example an older service), for a surface that shows it in its own notice area. */
export function useDesktopWarning(): string | undefined {
  const [warning, setWarning] = useState<string | undefined>();
  useEffect(() => platform.subscribeDesktopConnection?.(state => setWarning(state.warning)), []);
  return warning;
}

export function DesktopWarningBar({ warning }: { warning: string }) {
  return <div className="connection-bar"><span className="connection-bar__glyph" aria-hidden="true">◐</span><span>{warning}</span></div>;
}

/** The document and workspace survive service recovery; only the shell state changes.
 *  The main window shows the warning below its top bar (Layout), clear of the macOS window controls; the tray has none. */
export function DesktopConnectionShell({ children, warning = true }: { children: ComponentChildren; warning?: boolean }) {
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
    {warning && connection.warning && <div role="status"><DesktopWarningBar warning={connection.warning} /></div>}
    {children}
  </div>;
}
