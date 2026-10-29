import { useEffect, useState } from "preact/hooks";
import { ago } from "../../../src/view-model/time";

/** Cached work remains visible while the stream reconnects; no service operation can restart an offline service. */
export function OfflineNotice({ lastUpdate }: { lastUpdate: number }) {
  const [now, setNow] = useState(() => Date.now() / 1000);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now() / 1000), 1000); return () => clearInterval(timer); }, []);
  return <div className="connection-bar" role="alert"><span className="connection-bar__glyph" aria-hidden="true">◐</span><span><b>Reconnecting to pacer…</b> <span className="connection-bar__caption">{lastUpdate > 0 ? `Last update ${ago(lastUpdate, now)}. ` : ""}Running tasks keep going; what you see may be out of date, and actions are paused until pacer is back.</span></span></div>;
}
