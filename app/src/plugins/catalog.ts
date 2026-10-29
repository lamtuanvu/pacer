import { createContext } from "preact";
import { useEffect, useState, useCallback } from "preact/hooks";
import type { BrowserApi } from "../data/api";
import type { SurfaceInfo } from "../../../src/plugins/registry";
export const PluginContext = createContext<{ surfaces: SurfaceInfo[]; revision: number; reload: () => void }>({ surfaces: [], revision: 0, reload: () => {} });
/** Listing starts nothing. `signal` changes on plugin events and plugin config changes from the store's one event stream. */
export function usePluginCatalog(api: BrowserApi, connected: boolean, signal: number) {
  const [surfaces, setSurfaces] = useState<SurfaceInfo[]>([]);
  const [attempt, setAttempt] = useState(0);
  const reload = useCallback(() => setAttempt(n => n + 1), []);
  useEffect(() => {
    let active = true;
    // A mutation emits config and plugin events separately; coalesce that burst with manual refreshes.
    const timer = setTimeout(() => { void api.call<{ surfaces: SurfaceInfo[] }>("plugin.ui.list", {}).then(data => { if (active) setSurfaces(Array.isArray(data.surfaces) ? data.surfaces : []); }, () => { /* Retain the last successful catalog during transient failures. */ }); }, 60);
    return () => { active = false; clearTimeout(timer); };
  }, [api, connected, signal, attempt]);
  return { surfaces, revision: signal, reload };
}
