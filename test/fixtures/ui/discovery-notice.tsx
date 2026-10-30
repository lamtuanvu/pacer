import { render } from "preact";
import { DiscoveryNotice } from "../../../app/src/shell/DiscoveryNotice";
import { NoticeStack } from "../../../app/src/ds/NoticeCard";
import { NoticeFrame } from "./notice-frame";
import { TaskContext } from "../../../app/src/screens/task-shared";
import { ActionContext } from "../../../app/src/data/action-context";
import { createActionRunner } from "../../../app/src/data/actions";
import { initialState } from "../../../app/src/data/store";
import { emptySnapshot } from "../../../src/link/envelope";

// The shell's DiscoveryNotice with four found machines; each answer stays pending until window.finish().
const host = window as any;
host.calls = [];
const ids = ["a", "b", "c", "d"].map(c => c.repeat(26));
const list = { available: true, enabled: true, rev: 1, networksRev: 1, network: null,
  found: ids.map((discoveryId, i) => ({ discoveryId, name: `machine-${i + 1}`, version: "1", lastSeen: 1, silenced: false })) };
const runner = createActionRunner({ call: async <T,>(op: string, params: unknown) => {
  host.calls.push({ op, params });
  return await new Promise<T>(resolve => { host.finish = () => resolve({} as T); });
}, waitFor: async () => false, refetch() {}, navigate() {} });
const narrow = innerWidth < 560;
const state = { ...initialState(), connected: true, features: { readModel: true, ops: new Set(["discovery.list"]) },
  snapshot: { ...emptySnapshot(), attention: ids.map(id => ({ id: `discovery:${id}`, kind: "discovery" })) } as never };
const api = { call: async (op: string) => op === "discovery.list" ? list : {} } as never;
render(<TaskContext.Provider value={{ state, api }}><ActionContext.Provider value={runner}>
  <NoticeFrame narrow={narrow} />
  <NoticeStack narrow={narrow}><DiscoveryNotice /></NoticeStack>
</ActionContext.Provider></TaskContext.Provider>, document.getElementById("app")!);
