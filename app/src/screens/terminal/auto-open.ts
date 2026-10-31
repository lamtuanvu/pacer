import type { TerminalRecord } from "../../../../src/terminal/workspace";

type TerminalApi = { call: <T>(op: string, params: Record<string, unknown>) => Promise<T> };
// Survives a panel unmount while listing/creation is pending (rapid toggles or strict effects).
const openings = new WeakMap<TerminalApi, Promise<TerminalRecord[]>>();

export function ensurePanelTerminal(api: TerminalApi, cwd: string): Promise<TerminalRecord[]> {
  const pending = openings.get(api);
  if (pending) return pending;
  const opening = (async () => {
    const tabs = await api.call<TerminalRecord[]>("terminal.list", {});
    if (tabs.length) return tabs;
    const tab = await api.call<TerminalRecord>("terminal.create", {
      request_id: crypto.randomUUID(), kind: "shell", ...(cwd ? { cwd } : {}),
    });
    return [tab];
  })();
  openings.set(api, opening);
  void opening.finally(() => { if (openings.get(api) === opening) openings.delete(api); }).catch(() => {});
  return opening;
}
