import { render } from "preact";
import { DiscoveryNotice } from "../../../app/src/shell/DiscoveryNotice";
import { UpdateNotice } from "../../../app/src/shell/UpdateNotice";
import { NoticeStack } from "../../../app/src/ds/NoticeCard";
import { Rail } from "../../../app/src/shell/Rail";
import { resolveRoute, type Route } from "../../../app/src/router";
import { TaskContext } from "../../../app/src/screens/task-shared";
import { ActionContext } from "../../../app/src/data/action-context";
import { createActionRunner } from "../../../app/src/data/actions";
import { initialState } from "../../../app/src/data/store";
import { emptySnapshot } from "../../../src/link/envelope";
import { desktopStatus } from "../desktop-update/status";

// The shell's notices as main.tsx mounts them: a found machine and a ready desktop update at the same time.
const host = window as any;
host.calls = [];
const id = "a".repeat(26);
const list = { available: true, enabled: true, rev: 1, networksRev: 1, network: null,
  found: [{ discoveryId: id, name: "studio-mac", version: "1", lastSeen: 1, silenced: false }] };
const runner = createActionRunner({ call: async <T,>(op: string, params: unknown) => { host.calls.push({ op, params }); return {} as T; },
  waitFor: async () => false, refetch() {}, navigate() {} });
const narrow = innerWidth < 560;
const state = { ...initialState(), connected: true, features: { readModel: true, ops: new Set(["discovery.list", "desktop.update.restart"]) },
  snapshot: { ...emptySnapshot(), attention: [{ id: `discovery:${id}`, kind: "discovery" }],
    desktopUpdates: [desktopStatus({ phase: "ready", target: "0.2.4", actions: ["restart"] })] } as never };
const api = { call: async (op: string) => op === "discovery.list" ? list : {} } as never;
render(<TaskContext.Provider value={{ state, api }}><ActionContext.Provider value={runner}>
  <div className={`pc-app${narrow ? " pc-app--narrow" : " pc-app--with-status"}`}>
    <main id="main-content" tabIndex={-1}><button id="work">Continue working</button></main>
    {narrow ? <Rail route={resolveRoute("#/") as Route} counts={null} narrow /> : <footer className="pc-statusbar" aria-label="Status bar" />}
  </div>
  <NoticeStack narrow={narrow}>
    <DiscoveryNotice />
    <UpdateNotice />
  </NoticeStack>
</ActionContext.Provider></TaskContext.Provider>, document.getElementById("app")!);
