import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import detail from "./ui/task-get.json";
import snapshot from "./ui/snapshot.json";
import { Screen } from "../../app/src/screens/Screen";
import { TaskContext } from "../../app/src/screens/task-shared";
import { ActionContext } from "../../app/src/data/action-context";
import { createActionRunner } from "../../app/src/data/actions";
import { initialState } from "../../app/src/data/store";
import { NavigationProvider } from "../../app/src/navigation";
import { resolveRoute, type Route } from "../../app/src/router";

// Actual Screen -> LazyTrace route, with only the service boundary replaced.
const options = (window as any).OPTIONS ?? {};
const calls: { op: string; params: unknown }[] = (window as any).CALLS = [];
let question: { id: string; text: string } | undefined = { id: "m-1", text: "Which provider should the flow use?" };
const api = { async call(op: string, params: unknown) {
  calls.push({ op, params });
  if (op === "task.get") {
    await new Promise(resolve => setTimeout(resolve, 30));
    return { ...detail, state: options.state ?? "running", work: options.work ? { rootId: detail.id, parentId: null, depth: 0 } : undefined, messages: question ? { unreadForHuman: 1, question } : undefined };
  }
  if (op === "dispatch.tree") return { nodes: [], totals: {} };
  if (op === "task.session") return { takeover: { available: false } };
  if (op === "task.log") return { stdout: "", stderr: "" };
  if (op === "msg.send") return { delivery: options.delivery ?? "turn_started", hold: { reason: "confirmation_required" } };
  if (op === "msg.read") { question = undefined; return { read: 1 }; }
  return {};
} };
const store = { ...initialState(), connected: true, snapshot: snapshot as any, features: { readModel: true, ops: new Set(["task.review", "dispatch.review"]) } };
const runner = createActionRunner({ call: api.call as any, waitFor: async () => true,
  refetch: () => { (window as any).REFETCHES = ((window as any).REFETCHES ?? 0) + 1; }, navigate: () => {} });
function currentRoute(): Route {
  const result = resolveRoute(location.hash);
  if ("redirect" in result) { history.replaceState(null, "", result.redirect); return currentRoute(); }
  return result;
}
function App() {
  const [route, setRoute] = useState(currentRoute);
  useEffect(() => {
    const update = () => setRoute(currentRoute());
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  return <TaskContext.Provider value={{ api: api as any, state: store }}><ActionContext.Provider value={runner}>
    <NavigationProvider route={route}><Screen route={route}/></NavigationProvider>
  </ActionContext.Provider></TaskContext.Provider>;
}
render(<App/>, document.getElementById("app")!);
