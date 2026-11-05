import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import { TaskContext } from "../../../app/src/screens/task-shared";
import { ActionContext } from "../../../app/src/data/action-context";
import { createActionRunner } from "../../../app/src/data/actions";
import { NavigationProvider } from "../../../app/src/navigation";
import { initialState } from "../../../app/src/data/store";
import { Layout } from "../../../app/src/shell/Layout";
import { Screen } from "../../../app/src/screens/Screen";
import { SetupContext } from "../../../app/src/screens/setup/context";
import { resolveRoute, type Route } from "../../../app/src/router";
import fixture from "./snapshot.json";
import taskDetail from "./task-get.json";

// Walks the real router/Layout/Screen tree so every routed page's real header renders through the shell's
// `header` FrameSlot (its ref only fires once Preact actually mounts; renderToString never exercises it).
const state = {
  ...initialState(), connected: true,
  features: { readModel: true, ops: new Set<string>() },
  snapshot: fixture,
} as any;
const checklist = {
  checkedAt: 1, complete: true, ready: true,
  policy: { mode: "open" as const, plugins: 0 },
  items: [
    { id: "planner", title: "Planner", status: "done" as const, required: true, detail: "claude-code" },
    { id: "service", title: "Background service", status: "done" as const, required: true },
    { id: "connect", title: "Connect planner", status: "done" as const, required: true, agent: "claude-code" },
    { id: "executor", title: "Executor", status: "done" as const, required: false, detail: "codex" },
    { id: "first", title: "First delegation", status: "done" as const, required: false },
  ],
};
const arrayOps = new Set(["account.list", "host.suggest", "job.list", "strategy.list", "repo.list", "agent.detect", "runner.list"]);
const api = {
  call: async (op: string) => {
    if (op === "task.get") return { ...taskDetail, fullTitle: taskDetail.goal, tokens: { total: 0, measuredAttempts: 0, partialAttempts: 0, unknownAttempts: 0, lowerBound: false, byExecutor: [] }, derived: { files: "ready" } };
    if (op === "dispatch.tree") return { nodes: [], totals: { tokens: { total: 0, measuredAttempts: 0, partialAttempts: 0, unknownAttempts: 0, lowerBound: false, byExecutor: [] } } };
    if (op === "plugin.list") return { plugins: [] };
    if (op === "config.get") return { keys: { planner: { value: "claude-code" } }, planners: [] };
    if (op === "runner.settings.get") return { executors: [] };
    if (op === "routing.route" || op === "routing.status") return { ranked: [], excluded: [], providers: [] };
    if (op === "dispatch.list" || op === "task.list") return { tasks: [], next: null };
    if (op === "session.agent.list") return [];
    if (op === "setup.check") return checklist;
    if (op === "insights.summary") return { rootTasksHandled: 0, acceptedFirstTry: 0, reviewedRoots: 0, acceptedFirstTryRate: null, retryAttempts: 0, tokens: { total: 0, measuredAttempts: 0, partialAttempts: 0, unknownAttempts: 0, attempts: 0 }, retryTokens: { total: 0, unknownAttempts: 0 }, spread: [], kindByAgent: [], ladder: [], skipReasons: [], daily: [], from: 0, to: 0, previous: { rootTasksHandled: 0 } };
    if (arrayOps.has(op)) return [];
    return {};
  },
};
const runner = createActionRunner({ call: api.call as any, waitFor: async () => true, refetch() {}, navigate() {} });

function App() {
  const [hash, setHash] = useState(location.hash || "#/");
  useEffect(() => {
    const update = () => setHash(location.hash);
    addEventListener("hashchange", update);
    return () => removeEventListener("hashchange", update);
  }, []);
  const route = resolveRoute(hash) as Route;
  return (
    <TaskContext.Provider value={{ state, api: api as any }}>
      <SetupContext.Provider value={{ checklist, refresh() {}, setRunning() {} }}>
        <ActionContext.Provider value={runner}>
          <NavigationProvider route={route}>
            <Layout route={route} state={state} title="pacer">
              <Screen route={route} />
            </Layout>
          </NavigationProvider>
        </ActionContext.Provider>
      </SetupContext.Provider>
    </TaskContext.Provider>
  );
}
render(<App />, document.getElementById("app")!);
