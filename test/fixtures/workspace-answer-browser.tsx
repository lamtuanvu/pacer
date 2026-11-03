import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import detail from "./ui/task-get.json";
import snapshot from "./ui/snapshot.json";
import { FrameContext } from "../../app/src/shell/slots";
import { Screen } from "../../app/src/screens/Screen";
import { TaskContext } from "../../app/src/screens/task-shared";
import { ActionContext } from "../../app/src/data/action-context";
import { createActionRunner } from "../../app/src/data/actions";
import { ApiError } from "../../app/src/data/api";
import { initialState } from "../../app/src/data/store";
import { NavigationProvider } from "../../app/src/navigation";
import { resolveRoute, type Route } from "../../app/src/router";

// Keep real routing, Workspace, AgentPanel, queries and MessageAnswer; replace only service I/O.
const options = (window as any).OPTIONS ?? {};
const resolved: string[] = (window as any).RESOLVED = [];
const calls: { op: string; params: any }[] = (window as any).CALLS = [];
let question: { id: string; text: string } | undefined = options.retained ? undefined : { id: "m-workspace", text: "Which provider should the flow use?" };
const task = { ...detail, state: options.state ?? "running", question: null,
  review: options.review ? { accepted: true } : null, dismissed: options.dismissed ?? false,
  work: options.work ? { rootId: detail.id, parentId: null, depth: 0 } : undefined };
const root = { ...task, id: "root-task", title: "Selected root", executor: null, messages: { unreadForHuman: 1, question: { id: "m-root", text: "Wrong root question" } } };
const messages = () => question ? { unreadForHuman: 1, question } : undefined;
let snapshotQuestion = question;
const tasks = () => options.retained ? [root, { ...task, messages: snapshotQuestion ? { unreadForHuman: 1, question: snapshotQuestion } : undefined }] : [task];
let sends = 0;
const api = { async call(op: string, params: any): Promise<any> {
  calls.push({ op, params });
  if (op === "task.get") {
    await new Promise(resolve => setTimeout(resolve, 30));
    resolved.push(params.id);
    return params.id === root.id ? root : { ...task, messages: messages() };
  }
  if (op === "task.list") return { tasks: tasks() };
  if (op === "dispatch.list") return { tasks: options.retained ? [{ ...root, rootId: root.id, parentId: null, depth: 0 }, { ...task, rootId: root.id, parentId: root.id, depth: 1 }] : [] };
  if (op === "dispatch.tree") return { nodes: [], totals: {} };
  if (op === "terminal.list" || op === "session.agent.list") return [];
  if (op === "task.session") return { host: "none", live: false, takeover: { available: false } };
  if (op === "task.log") return { stdout: "Fixture output", stderr: "" };
  if (op === "msg.send") {
    sends++;
    await new Promise(resolve => setTimeout(resolve, 60));
    if (options.failOnce && sends === 1) throw new ApiError("conflict", "Refused", undefined, 409, { reason: "confirmation_required" });
    return { delivery: options.delivery ?? "turn_started", hold: { reason: "confirmation_required" } };
  }
  if (op === "msg.read") { question = undefined; return { read: 1 }; }
  return {};
} };
const store = { ...initialState(), connected: true, snapshot: { ...snapshot, tasks: tasks() } as any,
  features: { readModel: true, ops: new Set(["task.review", "dispatch.review"]) } };
const runner = createActionRunner({ call: api.call as any, waitFor: async () => true,
  refetch: () => { (window as any).REFETCHES = ((window as any).REFETCHES ?? 0) + 1; }, navigate: () => {} });
function currentRoute(): Route {
  const result = resolveRoute(location.hash);
  if ("redirect" in result) { history.replaceState(null, "", result.redirect); return currentRoute(); }
  return result;
}
function App() {
  const [route, setRoute] = useState(currentRoute);
  const [revision, setRevision] = useState(0);
  (window as any).PUBLISH_QUESTION = () => {
    question = { id: "m-workspace", text: "Which provider should the flow use?" };
    snapshotQuestion = question;
    setRevision(n => n + 1);
  };
  (window as any).REMOVE_QUESTION = () => {
    question = undefined;
    snapshotQuestion = undefined;
    setRevision(n => n + 1);
  };
  (window as any).TICK = () => setRevision(n => n + 1);
  useEffect(() => {
    const update = () => setRoute(currentRoute());
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return <TaskContext.Provider value={{ api: api as any, state: { ...store, snapshot: { ...store.snapshot, seq: revision, tasks: tasks() } as any } }}><ActionContext.Provider value={runner}>
    <NavigationProvider route={route}><FrameContext.Provider value={options.retained ? { inline: true, title: null, actions: null, left: null, right: null, heading() {} } : null}><Screen route={route}/></FrameContext.Provider></NavigationProvider>
  </ActionContext.Provider></TaskContext.Provider>;
}
render(<App/>, document.getElementById("app")!);
