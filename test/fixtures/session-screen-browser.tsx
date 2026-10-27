import { render } from "preact";
import fixture from "./ui/snapshot.json";
import detail from "./ui/task-get.json";
import { Layout } from "../../app/src/shell/Layout";
import { TaskContext } from "../../app/src/screens/task-shared";
import { NavigationProvider } from "../../app/src/navigation";
import { initialState } from "../../app/src/data/store";
import { resolveRoute, type Route } from "../../app/src/router";
import { attachKeyRegistry } from "../../app/src/keys/registry";
import { keys } from "../../app/src/keys/instance";
import { TaskRoute } from "../../app/src/screens/TaskResult";
import { ActionContext } from "../../app/src/data/action-context";
import { createActionRunner } from "../../app/src/data/actions";

// Browser fixture for a task's Session screen: the real Layout and TaskRoute with a stub service.
// window.SCENARIO picks the task: "conversation" (running, built-in terminal), "supervised" (running) or "ended".
const scenario = (window as any).SCENARIO as "conversation" | "supervised" | "ended";
const calls: { op: string; params: unknown }[] = ((window as any).CALLS = []);
const running = scenario !== "ended";
let state = running ? "running" : "done";
const task = () => ({ ...detail, state, interactionMode: scenario === "conversation" ? "conversation" : undefined,
  conversation: scenario === "conversation" ? { agentSessionId: "agent-1", activity: "working" } : undefined,
  attemptStartedAt: detail.startedAt, title: "Run demo-stages flow with WebGL enabled and report every console error" });
const session = { host: scenario === "conversation" ? "builtin" : "none", targets: ["terminal"], live: running, cols: 80, rows: 24, controller: null,
  capabilities: { control: true, resize: true }, takeover: { available: scenario !== "conversation", reason: "Already interactive" }, attach: { ws: "/v3/x", cli: "pacer attach t-0412" }, machine: "devbox" };
const diff = { patch: "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
  untracked: ["reports/frames/stage-2.png"], truncated: false,
  files: [{ path: "src/example.ts", status: "modified", added: 3, removed: 1 }, { path: "reports/a/very/long/path/that/keeps/going/demo-stages-frames.md", status: "modified", added: 64, removed: 0 }] };
const api = { async call(op: string, params: unknown) {
  calls.push({ op, params });
  if (op === "task.get") return task();
  if (op === "task.session") return session;
  if (op === "task.diff") return diff;
  if (op === "task.list") return { tasks: [], next: null };
  if (op === "session.context") return { draftId: "draft-1", attachments: [], rev: 1 };
  if (op === "task.takeover") return { state: "driving" };
  if (op === "task.retry") { state = "queued"; return { retry: { task_id: "t-retried" } }; }
  if (op === "session.end" || op === "task.stop") { state = "done"; return { ok: true }; }
  if (op === "account.list") return [];
  return {};
}, hello: async () => ({}), snapshot: async () => ({}) };
const store = { ...initialState(), connected: true, snapshot: fixture as any, features: { readModel: true, ops: new Set(["task.stop", "session.end", "task.review"]) } };
const runner = createActionRunner({ call: api.call as any, waitFor: async () => true, refetch: () => {}, navigate: () => {} });
function App() {
  const route = resolveRoute("#/tasks/t-0412") as Route;
  keys.setScope("sessions");
  return <TaskContext.Provider value={{ api: api as any, state: store }}><ActionContext.Provider value={runner}><NavigationProvider route={route}>
    <Layout route={route} state={store} title="Task"><TaskRoute id="t-0412" query={route.query} /></Layout>
  </NavigationProvider></ActionContext.Provider></TaskContext.Provider>;
}
attachKeyRegistry(keys, window);
render(<App />, document.getElementById("app")!);
