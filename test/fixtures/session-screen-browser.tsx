import { useEffect, useState } from "preact/hooks";
import { render } from "preact";
import fixture from "./ui/snapshot.json";
import detail from "./ui/task-get.json";
import navigatorData from "./ui/session-navigator.json";
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
// window.SCENARIO picks the task: "conversation" (running, built-in terminal), "supervised" (running), "asked" (running, with a question for the human), "ended" or "failed".
const scenario = (window as any).SCENARIO as "conversation" | "supervised" | "asked" | "ended" | "failed";
const calls: { op: string; params: unknown }[] = ((window as any).CALLS = []);
// Public snapshot/dispatch rows captured from live --seed ui, with portable repository paths.
const navigator = (window as any).NAVIGATOR === true;
const selectedId = navigator ? navigatorData.work.find(row=>row.depth===1 && row.state==='running')!.id : detail.id;
const running = scenario !== "ended" && scenario !== "failed";
let state = running ? "running" : scenario === "failed" ? "failed" : "done";
let question: { id: string; text: string; at: number } | undefined = scenario === "asked" ? { id: "m-1", text: "Which provider should the flow use?", at: 1 } : undefined;
const tokenMode = (window as any).TOKEN_MODE as string | undefined;
const task = () => ({ ...detail, id:selectedId, state, interactionMode: scenario === "conversation" ? "conversation" : undefined,
  conversation: scenario === "conversation" ? { agentSessionId: "agent-1", activity: "working" } : undefined,
  tokens: navigator ? null : { total: 1234, input: 1000, output: 234, cacheRead: tokenMode === "mixed" || tokenMode === "all-present" ? 100 : 0, cacheWrite: 0,
    reported: { input: true, output: true, cacheRead: tokenMode === "mixed" || tokenMode === "all-present", cacheWrite: tokenMode === "mixed" || tokenMode === "all-present" },
    complete: { input: true, output: true, cacheRead: tokenMode === "all-present", cacheWrite: tokenMode === "all-present" },
    measuredAttempts: tokenMode === "partial" ? 0 : tokenMode === "mixed" ? 2 : 1, partialAttempts: tokenMode === "partial" ? 1 : 0, unknownAttempts: 0, lowerBound: tokenMode === "partial", byExecutor: [], planner: { coverage: "unknown" }, decision: { coverage: "unknown" } },
  messages: question ? { unreadForHuman: 1, question } : undefined, attemptStartedAt: detail.startedAt, title: "Run demo-stages flow with WebGL enabled and report every console error" });
const session = { host: scenario === "conversation" ? "builtin" : "none", targets: ["terminal"], live: running, cols: 80, rows: 24, controller: null,
  capabilities: { control: true, resize: true }, takeover: { available: scenario !== "conversation", reason: "Already interactive" }, attach: { ws: "/v3/x", cli: "pacer attach t-0412" }, machine: "devbox" };
const diff = { patch: "diff --git a/src/example.ts b/src/example.ts\n--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-old\n+new\n",
  untracked: ["reports/frames/stage-2.png"], truncated: false,
  files: [{ path: "src/example.ts", status: "modified", added: 3, removed: 1 }, { path: "reports/a/very/long/path/that/keeps/going/demo-stages-frames.md", status: "modified", added: 64, removed: 0 }] };
const api = { async call(op: string, params: unknown) {
  calls.push({ op, params });
  if (op === "task.get") { await new Promise(resolve => setTimeout(resolve, 150)); return { ...task(), id: (params as { id: string }).id }; }
  if (op === "task.session") return session;
  if (op === "task.diff") return diff;
  // window.DELIVERY sets msg.send's delivery; like the service, only a delivered answer reads the question.
  if (op === "msg.send") { const delivery = (window as any).DELIVERY ?? "turn_started"; if (delivery !== "held") question = undefined; return { delivery }; }
  if (op === "msg.read") { question = undefined; return { read: 1 }; }
  if (op === "task.list") return { tasks: [], next: null };
  // Snapshot rows have no parentId: dispatch.list supplies the tree edges separately.
  if (op === "dispatch.list") {
   await new Promise(resolve=>setTimeout(resolve,60));
   return { tasks: navigator ? navigatorData.work.filter(row => tokenMode !== "deep-link" || row.id !== selectedId) : [], next: null }; }
  if (op === "session.context") return { draftId: "draft-1", attachments: [], rev: 1 };
  if (op === "task.takeover") return { state: "driving" };
  if (op === "task.retry") { state = "queued"; return { retry: { task_id: "t-retried" } }; }
  if (op === "session.end" || op === "task.stop") { state = "done"; return { ok: true }; }
  if (op === "account.list") return [];
  return {};
}, hello: async () => ({}), snapshot: async () => ({}) };
const store = { ...initialState(), connected: true, snapshot: { ...fixture, ...(navigator ? {tasks:navigatorData.tasks.filter(row => tokenMode !== "deep-link" || row.id !== selectedId),attention:[]} : {}), planner: { ...fixture.planner, agent: "claude" } } as any, features: { readModel: true, ops: new Set(["task.stop", "session.end", "task.review"]) } };
const runner = createActionRunner({ call: api.call as any, waitFor: async () => true, refetch: () => {}, navigate: () => {} });
function App() {
  const [hash, setHash] = useState(`#/tasks/${selectedId}`);
  useEffect(() => {
    const update = () => setHash(location.hash);
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  const route = resolveRoute(hash) as Route & { id: string };
  keys.setScope("sessions");
  return <TaskContext.Provider value={{ api: api as any, state: store }}><ActionContext.Provider value={runner}><NavigationProvider route={route}>
    <Layout route={route} state={store} title="Task"><TaskRoute key={route.id} id={route.id!} query={route.query} /></Layout>
  </NavigationProvider></ActionContext.Provider></TaskContext.Provider>;
}
// A tray deep link (`#/sessions/<id>/answer`) redirects the way the app router does.
const entry = resolveRoute(location.hash);
if ("redirect" in entry) history.replaceState(null, "", entry.redirect);
attachKeyRegistry(keys, window);
render(<App />, document.getElementById("app")!);
