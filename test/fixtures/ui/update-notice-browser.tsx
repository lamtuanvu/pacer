import { render } from "preact";
import { useState } from "preact/hooks";
import { UpdateNotice } from "../../../app/src/shell/UpdateNotice";
import { NoticeStack } from "../../../app/src/ds/NoticeCard";
import { TaskContext } from "../../../app/src/screens/task-shared";
import { ActionContext } from "../../../app/src/data/action-context";
import { createActionRunner } from "../../../app/src/data/actions";
import { initialState } from "../../../app/src/data/store";
import { emptySnapshot } from "../../../src/link/envelope";
import { desktopStatus } from "../desktop-update/status";
const host = window as any;
host.calls = [];
const ready = desktopStatus({ phase: "ready", target: "0.2.4", actions: ["restart"] });
function Fixture() {
  const [status, setStatus] = useState(ready), [connected, setConnected] = useState(true), [capable, setCapable] = useState(true), [hidden, setHidden] = useState(false);
  host.update = (patch: object) => setStatus(value => ({ ...value, ...patch }));
  host.connection = setConnected; host.capability = setCapable; host.hide = setHidden;
  const runner = createActionRunner({ call: async <T,>(op: string, params: unknown) => {
    host.calls.push({ op, params });
    return await new Promise<T>((resolve, reject) => { host.finish = () => resolve({} as T); host.fail = () => reject(new Error("Update request failed")); });
  }, waitFor: async () => false, refetch() {}, navigate() {} });
  const state = { ...initialState(), connected, features: { readModel: true, ops: new Set(capable ? ["desktop.update.restart"] : []) }, snapshot: { ...emptySnapshot(), desktopUpdates: [status] } };
  const api = {} as any;
  return <TaskContext.Provider value={{ state, api }}><ActionContext.Provider value={runner}>
    <main id="main-content" tabIndex={-1}><button id="work">Continue working</button></main>
    <NoticeStack narrow={innerWidth < 560}><UpdateNotice hidden={hidden}/></NoticeStack>
  </ActionContext.Provider></TaskContext.Provider>;
}
render(<Fixture/>, document.getElementById("app")!);
