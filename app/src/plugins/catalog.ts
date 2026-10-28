import { createContext } from "preact";
import { useEffect, useState } from "preact/hooks";
import type { BrowserApi } from "../data/api";
import type { SurfaceInfo } from "../../../src/plugins/registry";
export const PluginContext = createContext<{ surfaces: SurfaceInfo[]; revision: number }>({ surfaces: [], revision: 0 });
/** Listing starts nothing. `signal` changes on plugin events and plugin config changes from the store's one event stream. */
export function usePluginCatalog(api: BrowserApi, connected: boolean, signal: number) {
  const [surfaces, setSurfaces] = useState<SurfaceInfo[]>([]);
  useEffect(() => {
    let active = true;
    void api.call<{ surfaces: SurfaceInfo[] }>("plugin.ui.list", {}).then(data => { if (active) setSurfaces(Array.isArray(data.surfaces) ? data.surfaces : []); }, () => { if (active) setSurfaces([]); });
    return () => { active = false; };
  }, [api, connected, signal]);
  return { surfaces, revision: signal };
}
