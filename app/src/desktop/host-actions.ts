import { useEffect, useState } from 'preact/hooks';
import { desktopHost, type DesktopHost } from '../data/desktop';

/** A file named by one local session attempt; the shell resolves it through the service (ADR 0011). */
export interface SessionFileRef { id: string; attempt: number; reference: string }

/** Desktop-only file hand-offs. Browsers and older shells get none, so their buttons are not rendered (UI-13). */
export interface HostActions {
  openInEditor(ref: SessionFileRef): Promise<void>;
  reveal?: { label: string; run(ref: SessionFileRef): Promise<void> };
}

/** The shell's own answer decides; the presence of Tauri alone does not. */
export async function readHostActions(host: DesktopHost = desktopHost()): Promise<HostActions | null> {
  const invoke = host.__TAURI__?.core?.invoke;
  if (!invoke) return null;
  let supported: { open?: unknown; reveal?: unknown; revealLabel?: unknown } | null;
  try { supported = await invoke('host_file_actions') as typeof supported; }
  catch { return null; }
  if (!supported || supported.open !== true) return null;
  const run = (action: 'open' | 'reveal') => async (ref: SessionFileRef) => {
    await invoke('open_session_file', { id: ref.id, attempt: ref.attempt, reference: ref.reference, action });
  };
  const label = typeof supported.revealLabel === 'string' && supported.revealLabel.trim() ? supported.revealLabel : null;
  return {
    openInEditor: run('open'),
    ...(supported.reveal === true && label ? { reveal: { label, run: run('reveal') } } : {}),
  };
}

/** Workspace-relative path and optional line, as the file viewer reports them. */
export const sessionFileReference = (path: string, line?: number) =>
  line !== undefined && Number.isSafeInteger(line) && line > 0 ? `${path}:${line}` : path;

/**
 * Bind the editor hand-off to one session attempt in the shape of the viewer's
 * optional `onOpenInEditor(path, line?)` prop; undefined keeps the action hidden.
 */
export function editorHandler(actions: HostActions | null, session: { id: string; attempt?: number | null },
  onError?: (message: string) => void): ((path: string, line?: number) => void) | undefined {
  const attempt = session.attempt;
  if (!actions || !attempt) return undefined;
  return (path, line) => {
    actions.openInEditor({ id: session.id, attempt, reference: sessionFileReference(path, line) })
      .catch(error => onError?.(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unable to open the file'));
  };
}

/** Same binding for Reveal, with the shell's platform label. */
export function revealHandler(actions: HostActions | null, session: { id: string; attempt?: number | null },
  onError?: (message: string) => void): { label: string; run: (path: string) => void } | undefined {
  const attempt = session.attempt;
  const reveal = actions?.reveal;
  if (!reveal || !attempt) return undefined;
  return {
    label: reveal.label,
    run: path => {
      reveal.run({ id: session.id, attempt, reference: path })
        .catch(error => onError?.(error instanceof Error ? error.message : typeof error === 'string' ? error : 'Unable to reveal the file'));
    },
  };
}

/** Host actions for this page, read once from the shell; null until known and in browsers. */
export function useHostActions(host: DesktopHost = desktopHost()): HostActions | null {
  const [actions, setActions] = useState<HostActions | null>(null);
  useEffect(() => {
    let live = true;
    void readHostActions(host).then(value => { if (live) setActions(value); });
    return () => { live = false; };
  }, [host]);
  return actions;
}
