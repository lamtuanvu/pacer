import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import snapshot from "./snapshot.json";
import { initialState } from "../../../app/src/data/store";
import { TaskContext } from "../../../app/src/screens/task-shared";
import { NavigationProvider } from "../../../app/src/navigation";
import { Layout } from "../../../app/src/shell/Layout";
import { WorkPanels } from "../../../app/src/shell/panels/WorkPanels";
import { PluginContext } from "../../../app/src/plugins/catalog";
import { Button } from "../../../app/src/ds/Button";
import { resolveRoute, type Route } from "../../../app/src/router";
const surfaces = Array.from({ length: 5 }, (_, i) => ({
  plugin: "fixture",
  surface: "panelTabs" as "panelTabs" | "settings",
  id: `panel-${i}`,
  title: `Plugin ${i}`,
  icon: null,
  context: i === 2 ? ("task" as const) : ("global" as const),
  visible: i < 4,
  state: "ready" as const,
}));
if (!new URLSearchParams(location.search).has("no-settings"))
  surfaces.push({
    ...surfaces[0]!,
    surface: "settings",
    id: "settings",
    visible: true,
  });
const calls: unknown[] = [];
Object.assign(window, { panelCalls: calls });
const api = {
  async call(op: string, params: any) {
    calls.push({ op, params });
    if (op === "task.get") {
      const task = snapshot.tasks.find((row) => row.id === params.id)!;
      return {
        ...task,
        title: task.goal,
        repo: task.repo,
        routing: {
          chosen: task.executor,
          why: "capable",
          skipped: [],
          policy: { executors: [task.executor] },
        },
        tokens: { total: 214000, measuredAttempts: 1, partialAttempts: 0 },
      };
    }
    if (op === "plugin.ui.render")
      return { document: { type: "text", text: `Content for ${params.id}` } };
    if (op === "plugin.settings.get") return { rev: 7 };
    if (op === "plugin.ui.visibility") {
      surfaces.find((row) => row.id === params.id)!.visible = true;
      return { rev: 8 };
    }
    return {};
  },
};
const state = {
  ...initialState(),
  connected: true,
  snapshot,
  features: {
    readModel: true,
    ops: new Set(["plugin.ui.visibility", "plugin.settings.get"]),
  },
} as any;
function App() {
  const [hash, setHash] = useState(location.hash || "#/"),
    [selected, select] = useState<string | null>(snapshot.tasks[0]!.id),
    [revision, update] = useState(0);
  useEffect(() => {
    const change = () => setHash(location.hash);
    addEventListener("hashchange", change);
    return () => removeEventListener("hashchange", change);
  }, []);
  const route = resolveRoute(hash) as Route;
  return (
    <PluginContext.Provider
      value={{ surfaces, revision, reload: () => update((n) => n + 1) }}
    >
      <TaskContext.Provider value={{ state, api: api as any }}>
        <NavigationProvider route={route}>
          <Layout route={route} state={state} title={route.name}>
            {route.name === "settings" ? (
              <Button
                data-details="codex#team@devbox"
                aria-expanded={selected === "agent"}
                onClick={() => select("agent")}
              >
                Agent detail
              </Button>
            ) : (
              <>
                <h1>{route.name === "dispatch" ? "Dispatch" : "Tasks"}</h1>
                <Button onClick={() => select(snapshot.tasks[1]!.id)}>
                  Select another task
                </Button>
                <Button onClick={() => select(null)}>Clear selection</Button>
                <WorkPanels query={route.query} selected={selected} />
              </>
            )}
          </Layout>
        </NavigationProvider>
      </TaskContext.Provider>
    </PluginContext.Provider>
  );
}
render(<App />, document.getElementById("root")!);
