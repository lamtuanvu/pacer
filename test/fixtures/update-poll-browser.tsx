import { render } from "preact";
import { Button } from "../../app/src/ds/Button";
import { Feedback, useOperation } from "../../app/src/screens/settings/shared";
import { TaskContext } from "../../app/src/screens/task-shared";
import { ActionContext } from "../../app/src/data/action-context";
import { createActionRunner } from "../../app/src/data/actions";
import { initialState } from "../../app/src/data/store";
const api = { call: async (op: string, params: unknown) => {
  const response = await fetch(`/ops/${op}`, { method: "POST", body: JSON.stringify(params) });
  const result = await response.json(); if (!response.ok) throw Error(result.message); return result;
} } as any;
const actions = createActionRunner({ call: api.call, waitFor: async () => true, refetch: () => {}, navigate: () => {} });
let state = { ...initialState(), connected: true, snapshot: { at: 1800000000, accounts: [], executors: [], hosts: [], repos: [] } } as any;
function UpdateOperation() {
  const action = useOperation(undefined, { notifyJob: false, notifySuccess: false });
  return <><Button onClick={() => void action.run("update.apply", {})}>Install update</Button><Feedback action={action} /></>;
}
const renderApp = () => render(<TaskContext.Provider value={{ state, api }}><ActionContext.Provider value={actions}><div className="u3-settings"><UpdateOperation /></div></ActionContext.Provider></TaskContext.Provider>, document.getElementById("root")!);
/** The job event a reconnected service may publish before the page's own poll succeeds. */
(window as any).fixtureJobEvent = (job: any) => { state = { ...state, jobs: { ...state.jobs, [job.id]: job } }; renderApp(); };
renderApp();
