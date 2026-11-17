import { useEffect, useState } from "preact/hooks";
import type { Job } from "../../../src/api/read-model/types";
import { restartingUpdate } from "../model/update-job";
import { ago } from "../../../src/view-model/time";

export function updateInProgress(jobs: Record<string, Job>): boolean {
  return Object.values(jobs).some(restartingUpdate);
}

/** Cached work remains visible while the stream reconnects; no service operation can restart an offline service. */
export function OfflineNotice({ lastUpdate, updating = false }: { lastUpdate: number; updating?: boolean }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(timer); }, []);
  const caption = <span className="connection-bar__caption" aria-live="off">{lastUpdate > 0 ? `Last update ${ago(lastUpdate, now)}. ` : ""}</span>;
  if (updating) return <div className="connection-bar"><span className="connection-bar__glyph" aria-hidden="true">◐</span><span><b>Updating pacer…</b> {caption}The service is restarting on the new version. Running tasks keep going, and actions resume when it is back.</span></div>;
  return <div className="connection-bar"><span className="connection-bar__glyph" aria-hidden="true">◐</span><span><b>Reconnecting to pacer…</b> {caption}Running tasks keep going; what you see may be out of date, and actions are paused until pacer is back.</span></div>;
}
