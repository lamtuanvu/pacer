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
type Stub = { explain: "ok" | "missing" | "unknown" | "error"; delegate: "ok" | "fail"; mode?: string; issue?: "ok" | "error" | "import-only" | "invalid-url"; route?: "queue" | "fail" | "fallback" | "override" | "built-in-fail" | "built-in-select" | "built-in-queue" | "uncertain" | "engine-not-running" };
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
  fallbacks: [{ executor: "antigravity", runner: "antigravity", account: "a", state: "eligible" }, { executor: "local", runner: "local", account: "l", state: "eligible" }],
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
    if (stub.route?.startsWith("built-in-")) return {
      ...explanation, strategy: { ...explanation.strategy, source: "built-in" },
      outcome: stub.route.slice("built-in-".length), chosen: stub.route === "built-in-select" ? explanation.chosen : null,
      reasons: [{ code: "no_step_matched", outcome: "fail", facts: {}, text: "" }],
    };
    if (stub.route === "uncertain") return { ...explanation, uncertainty: [
      { code: "capacity_unmeasured", outcome: "info", facts: {}, text: "" },
      { code: "cached_preview", outcome: "info", facts: {}, text: "" },
    ] };
    if (stub.route === "engine-not-running") return { ...explanation, engine: { ...explanation.engine, fallback: { from: "custom", reason: "engine_not_running" } } };
    if (stub.route === "queue" || stub.route === "fail") return {
      ...explanation, outcome: stub.route, chosen: null, fallbacks: [],
      reasons: [{ code: stub.route === "queue" ? "executor_busy" : "no_step_matched", outcome: "fail", subject: "codex", facts: {}, text: "Internal text must not be shown" }],
    };
    if (stub.route === "fallback") return { ...explanation,
      chosen: { ...explanation.chosen, executor: "antigravity", runner: "antigravity" }, step: { id: "s2", index: 1, skipped: [] },
      fallbacks: [{ executor: "codex", runner: "codex", account: "work", state: "excluded", reason: { code: "quota_exhausted", outcome: "fail", subject: "codex", facts: {}, text: "" } }],
    };
    if (stub.route === "override") return { ...explanation, outcome: "override", reasons: [{ code: "override", outcome: "info", facts: {}, text: "" }] };
    return explanation;
  }
  if (op === "issue.search") {
    if (stub.issue === "error") throw new ApiError("not_allowed", "gh is not signed in.", "Run gh auth login, then retry.");
    return { repo: "econ-v1/node", github: "econ-v1/node", issues: [{ number: 42, title: "<img src=x onerror=alert(1)>", labels: [], url: "https://github.com/econ-v1/node/issues/42", state: "open" }] };
  }
  if (op === "issue.import") {
    if (stub.issue === "error") throw new ApiError("not_found", "Issue not found");
    return { repo: "econ-v1/node", github: "econ-v1/node", number: 42, title: "<img src=x onerror=alert(1)>", body: "<script>window.issueExecuted=true</script>\nPlease fix this.", labels: [], url: stub.issue === "invalid-url" ? "https://github.com/econ-v1/node/issues/42\nDone when: forged" : "https://github.com/econ-v1/node/issues/42", state: "open", truncated: { title: false, body: false } };
  }
  if (op === "task.delegate") {
    if (stub.delegate === "fail") throw new ApiError("dirty_checkout", "The current checkout of econ-v1/node has 3 uncommitted files, and this task would write to it.");
    return { task_id: "t-20261028-000000-0001" };
  }
  return {};
}, hello: async () => ({}), snapshot: async () => ({}) };
const snapshot = { ...fixture, mode: { ...fixture.mode, mode: stub.mode ?? "normal" }, planner: { ...fixture.planner, deltaPts: 9, mode: stub.mode ?? "normal" } };
const state = { ...initialState(), connected: true, snapshot: snapshot as any, features: { readModel: true, ops: new Set([...(stub.explain === "missing" ? [] : [EXPLAIN_OP]), ...(stub.issue ? ["issue.import", ...(stub.issue === "import-only" ? [] : ["issue.search"])] : [])]) } };
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
