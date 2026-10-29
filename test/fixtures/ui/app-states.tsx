import { ActionContext } from "../../../app/src/data/action-context";
import { TaskContext } from "../../../app/src/screens/task-shared";
import { SetupContext } from "../../../app/src/screens/setup/context";
import { useEffect, useState } from "preact/hooks";
import { createApi } from "../../../app/src/data/api";
import { createStore, initialState, type StoreState } from "../../../app/src/data/store";
import { Button } from "../../../app/src/ds/Button";
import { ActionButton } from "../../../app/src/screens/ActionButton";
import { StatusBar } from "../../../app/src/shell/StatusBar";
import { keys } from "../../../app/src/keys/instance";
import { render } from "preact";
import fixture from "./snapshot.json";
import type { ClientSnapshot } from "../../../src/view-model/snapshot";
import { DispatchHome, DispatchView, FirstRun, SampleTask } from "../../../app/src/screens/dispatch/Dispatch";
import { Layout } from "../../../app/src/shell/Layout";
import { AppFrame } from "../../../app/src/shell/AppFrame";
import { TopBar } from "../../../app/src/shell/TopBar";
import { CommandTrigger } from "../../../app/src/shell/CommandTrigger";
import { Rail } from "../../../app/src/shell/Rail";
import { OfflineNotice } from "../../../app/src/shell/OfflineNotice";
import { useNarrow } from "../../../app/src/shell/narrow";
import { createActionRunner } from "../../../app/src/data/actions";
const query = { repo: null, scope: null };
const mode = new URLSearchParams(location.search).get("state");
const snap = fixture as unknown as ClientSnapshot;
const snapshot = mode?.startsWith("home-") ? { ...snap, tasks: [], attention: [], executors: mode === "home-first" ? snap.executors!.filter(e => e.rank === "planner") : snap.executors } : mode === "empty" || mode === "first" || mode === "sample" ? { ...snap, tasks: [], attention: [], executors: mode === "first" ? [] : snap.executors } : snap;
const runner = createActionRunner({ call: async <T,>(op: string) => { document.body.dataset.sampleOp = op; return { task_id: "sample-task" } as T; }, waitFor: async () => true, refetch() {}, navigate() {} });
const homeState = { ...initialState(), connected: mode !== "offline", snapshot, features: { readModel: true, ops: new Set(mode === "home-sample" ? ["agent.detect", "onboarding.try"] : ["agent.detect"]) } };
const homeApi = { call: async (op: string) => {
  if (op === "agent.detect") { document.body.dataset.detectOp = op; return [{ agent: "codex", found: true, version: "detected-version", path: null, install_hint: "" }]; }
  if (op === "dispatch.list") return { tasks: [], next: null };
  return {};
} } as never;
function LayoutProbe() {
  const [connected, setConnected] = useState(false);
  const [api] = useState(() => createApi());
  const state = { ...homeState, connected, features: { ...homeState.features, ops: new Set(["delegation.pause", "strategy.use"]) } };
  return <TaskContext.Provider value={{ state, api }}><Button onClick={() => setConnected(v => !v)}>Toggle connection</Button><Button onClick={() => void api.call("task.answer", {}).then(() => { document.body.dataset.probe = "sent"; }, error => { document.body.dataset.probe = error.message; })}>Probe bypass</Button><Layout route={{ name: "dispatch", query }} state={state} title="Dispatch"><div className="pc-dispatch">Guard probe</div></Layout></TaskContext.Provider>;
}
function Fixture() {
  const narrow = useNarrow(query);
  const [store] = useState(() => mode === "recovery" ? createStore(createApi()) : null);
  const [current, setCurrent] = useState<StoreState>(homeState);
  useEffect(() => {
    if (!store) return;
    const unsubscribe = store.subscribe(() => setCurrent(store.getState()));
    const stop = store.start();
    return () => { stop(); unsubscribe(); };
  }, [store]);
  const connected = mode === "recovery" ? current.connected : mode !== "offline";
  const newTask = () => { location.hash = "#/tasks/new"; };
  return <TaskContext.Provider value={{ state: current, api: homeApi }}><SetupContext.Provider value={{ refresh() {}, setRunning() {}, checklist: { checkedAt: 0, ready: mode !== "home-first", complete: mode !== "home-first", items: [{ id: "connect", title: "Connect planner", required: true, status: mode === "home-first" ? "pending" : "done" }] } }}><ActionContext.Provider value={runner}><AppFrame mainClass="pc-main pc-main--canvas" narrow={narrow} top={<TopBar narrow={narrow} title="Dispatch" planner={snapshot.planner ?? null} plannerFigure={false} mode="relaxed" connected={connected} lastUpdate={snapshot.at} onDelegate={newTask} pageTitle={narrow} narrowSearch={<CommandTrigger narrow onOpen={() => { document.body.dataset.search = "open"; }} />} />}
    overlay={mode === "offline" ? <Button>Assistant service send</Button> : undefined}
    activity={<Rail narrow={narrow} route={{ name: "dispatch", query }} counts={snapshot.counts ?? null} />}
    live={!connected ? <OfflineNotice lastUpdate={Date.now() / 1000 - 60} /> : undefined}
    status={!narrow ? <StatusBar snapshot={snapshot} registry={keys} /> : undefined}
    main={<>{(mode === "offline" || mode === "recovery") && <><Button onClick={() => { document.body.dataset.submitted = "yes"; }}>Direct service submit</Button><ActionButton runner={runner} id="offline-test" action={{ op: "task.retry", label: "Offline service action", params: {} }} /></>}
    {mode?.startsWith("home-") ? <DispatchHome query={query} /> : <DispatchView snapshot={snapshot} query={query} now={snapshot.at} runner={runner} connected={connected}
      sampleTask={mode === "sample" ? <SampleTask query={query} /> : undefined}
      firstRun={mode === "first" ? <FirstRun planner="claude-code" query={query} detections={[{ agent: "claude-code", found: true, version: "2.1", path: null, install_hint: "" }, { agent: "codex", found: true, version: "0.162", path: null, install_hint: "" }, { agent: "cursor", found: false, version: null, path: null, install_hint: "Install Cursor CLI" }]} /> : undefined} />}</>} /></ActionContext.Provider></SetupContext.Provider></TaskContext.Provider>;
}
render(mode === "layout-probe" ? <LayoutProbe /> : <Fixture />, document.getElementById("root")!);
