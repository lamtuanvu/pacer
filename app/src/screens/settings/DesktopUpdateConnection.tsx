import { useState } from "preact/hooks";
import type { DesktopUpdateConnection as Connection } from "../../data/desktop";
import { desktopConnectionView } from "../../../../src/view-model/updates";
import { openDesktopTakeover } from "../../data/desktop";
import { Button } from "../../ds/Button";
import { Stack } from "../../ds/Page";
import { ErrorMessage } from "../task-shared";

/** Opens the desktop's confirmation page; a failure becomes plain copy for the user. */
export async function reviewServiceReplacement(open: () => Promise<void>, failure: string): Promise<Error | null> {
  try { await open(); return null; }
  catch { return new Error(failure); }
}

export function DesktopUpdateConnection({ connection, open = openDesktopTakeover }: { connection: Connection | null; open?: () => Promise<void> }) {
  const view = desktopConnectionView(connection);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const review = async () => {
    setBusy(true);
    setError(null);
    setError(await reviewServiceReplacement(open, view.takeoverError));
    setBusy(false);
  };
  return <Stack space="compact">
    <div role="status" aria-live="polite"><strong>{view.label}</strong><p>{view.detail}</p>{view.terminalNote && <p>{view.terminalNote}</p>}</div>
    {view.takeoverAction && <div><Button busy={busy} onClick={() => void review()}>{view.takeoverAction}</Button></div>}
    <ErrorMessage error={error}/>
  </Stack>;
}
