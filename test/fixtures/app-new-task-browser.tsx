import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import fixture from "./ui/snapshot.json";
import { TaskContext } from "../../app/src/screens/task-shared";
import { ActionContext } from "../../app/src/data/action-context";
import { createActionRunner } from "../../app/src/data/actions";
import { ApiError } from "../../app/src/data/api";
import { initialState } from "../../app/src/data/store";
import { EXPLAIN_OP } from "../../app/src/data/explain-route";
import { resolveRoute, type Route } from "../../app/src/router";
import { attachKeyRegistry, newTaskShortcut } from "../../app/src/keys/registry";
import { keys } from "../../app/src/keys/instance";
import { NewTask } from "../../app/src/screens/new-task/NewTask";
import { openNewTask } from "../../app/src/screens/new-task/entry";

// Browser fixture for the New task composer with a stub service. The test sets `window.newTaskStub` first:
// explain "ok" | "missing" (op not in hello) | "unknown" (op answers unknown_op) | "error"; delegate "ok" | "fail".
type Stub = { explain: "ok" | "missing" | "unknown" | "error"; delegate: "ok" | "fail"; mode?: string };
const stub: Stub = { explain: "ok", delegate: "ok", ...(window as unknown as { newTaskStub?: Partial<Stub> }).newTaskStub };
const calls: { op: string; params: unknown }[] = [];
(window as unknown as { newTaskCalls: typeof calls }).newTaskCalls = calls;
if (!crypto.randomUUID) Object.defineProperty(crypto, "randomUUID", { value: () => `11111111-1111-4111-8111-${String(Date.now()).slice(-12).padStart(12, "0")}` });

const explanation = {
  schemaVersion: 1, revision: "r1", at: 1, observedAt: 1, outcome: "select",
  kind: { value: "feature", source: "detected" },
  strategy: { name: "no-agy", draft: false, source: "project" },
  engine: { id: "builtin", version: "1" },
  chosen: { executor: "codex", account: "work", runner: "codex", model: { kind: "executor-default" }, host: null },
  step: { id: "s1", index: 0, skipped: [] },
  reasons: [
    { code: "step_match", outcome: "pass", facts: { kind: "feature", stepId: "1" }, text: "" },
    { code: "capacity_comfortable", outcome: "pass", subject: "codex", facts: { headroomPct: 59, pacePct: 47 }, text: "" },
  ],
  fallbacks: [{ executor: "antigravity", account: "a", state: "eligible" }, { executor: "local", account: "l", state: "eligible" }],
  planner: { state: "estimate", tokens: { median: 60_000, p80: 90_000 }, samples: 12, basis: "kind", window: { account: "c", usedPct: 16, pacePct: 38, mode: "normal" } },
  uncertainty: [],
};
const api = { async call(op: string, params: unknown) {
  calls.push({ op, params });
  if (op === "repo.list") return [{ key: "econ-v1/node", label: "econ-v1/node", path: "~/code/node", branches: ["main"] }, { key: "pacer", label: "pacer", path: "~/code/pacer", branches: ["main"] }];
  if (op === "routing.route") return { ranked: [{ id: "codex", verdict: "BEHIND", reason: "41% of week · pace 47%" }, { id: "antigravity", verdict: "BEHIND", reason: "22% of week · pace 37%" }], excluded: [{ id: "opencode", reason: "No active subscription" }] };
  if (op === "account.list") return [];
  if (op === EXPLAIN_OP) {
    if (stub.explain === "unknown") throw new ApiError("unknown_op", "unknown op");
    if (stub.explain === "error") throw new ApiError("internal", "The routing engine timed out.");
    return explanation;
  }
  if (op === "task.delegate") {
    if (stub.delegate === "fail") throw new ApiError("dirty_checkout", "The current checkout of econ-v1/node has 3 uncommitted files, and this task would write to it.");
    return { task_id: "t-20261028-000000-0001" };
  }
  return {};
}, hello: async () => ({}), snapshot: async () => ({}) };
const snapshot = { ...fixture, mode: { ...fixture.mode, mode: stub.mode ?? "normal" }, planner: { ...fixture.planner, deltaPts: 9, mode: stub.mode ?? "normal" } };
const state = { ...initialState(), connected: true, snapshot: snapshot as any, features: { readModel: true, ops: new Set(stub.explain === "missing" ? [] : [EXPLAIN_OP]) } };
const runner = createActionRunner({ call: (op, params) => api.call(op, params) as never, waitFor: async () => true, refetch: () => {}, navigate: href => { location.hash = href; } });

function App() {
  const [hash, setHash] = useState(location.hash || "#/overview");
  useEffect(() => { const update = () => setHash(location.hash); addEventListener("hashchange", update); return () => removeEventListener("hashchange", update); }, []);
  const route = resolveRoute(hash) as Route;
  useEffect(() => { keys.setScope(route.name); }, [route.name]);
  return <TaskContext.Provider value={{ api: api as any, state }}><ActionContext.Provider value={runner}>
    <main id="main-content" tabIndex={-1}>
      {route.name === "new-task" ? <NewTask query={route.query} /> : <p data-route={route.name}>Route {route.name}</p>}
    </main>
  </ActionContext.Provider></TaskContext.Provider>;
}
keys.register(newTaskShortcut(() => openNewTask()));
attachKeyRegistry(keys, window);
render(<App />, document.getElementById("app")!);
